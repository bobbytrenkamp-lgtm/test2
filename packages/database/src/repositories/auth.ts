import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@cre/domain-models';
import type { Sql } from '../client.js';
import { hashPassword, needsRehash, verifyPassword } from '../passwords.js';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  is_active: boolean;
  mfa_enrolled: boolean;
  last_login_at: Date | null;
}

export interface SessionRecord {
  id: string;
  user_id: string;
  organization_id: string | null;
  expires_at: Date;
}

export interface AuthenticatedContext {
  user: UserRecord;
  session: SessionRecord;
  organizationId: string | null;
  role: Role | null;
}

/** Session lifetime. Sliding: extended on each authenticated request. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Session tokens are random 32-byte values; only their SHA-256 digest is
 * persisted. A database disclosure therefore does not yield usable sessions,
 * and a token lookup is still a single indexed read.
 */
export function generateSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createUser(
  sql: Sql,
  input: { email: string; name: string; password: string },
): Promise<UserRecord> {
  const passwordHash = await hashPassword(input.password);
  const rows = (await sql`
    INSERT INTO users (email, name, password_hash)
    VALUES (${input.email.trim().toLowerCase()}, ${input.name.trim()}, ${passwordHash})
    RETURNING id, email, name, is_active, mfa_enrolled, last_login_at
  `) as unknown as UserRecord[];
  return rows[0] as UserRecord;
}

export async function findUserByEmail(sql: Sql, email: string): Promise<(UserRecord & { password_hash: string | null }) | null> {
  const rows = (await sql`
    SELECT id, email, name, is_active, mfa_enrolled, last_login_at, password_hash
    FROM users
    WHERE email = ${email.trim().toLowerCase()}
  `) as unknown as Array<UserRecord & { password_hash: string | null }>;
  return rows[0] ?? null;
}

/**
 * Verifies credentials in constant-ish time.
 *
 * When the email is unknown a verification is still performed against a dummy
 * hash so that a missing account and a wrong password take comparable time and
 * cannot be told apart by an attacker enumerating addresses.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

export async function authenticate(
  sql: Sql,
  email: string,
  password: string,
): Promise<UserRecord | null> {
  const user = await findUserByEmail(sql, email);
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || !user.is_active) return null;

  if (needsRehash(user.password_hash)) {
    const refreshed = await hashPassword(password);
    await sql`UPDATE users SET password_hash = ${refreshed}, updated_at = now() WHERE id = ${user.id}`;
  }
  await sql`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    is_active: user.is_active,
    mfa_enrolled: user.mfa_enrolled,
    last_login_at: user.last_login_at,
  };
}

export async function createSession(
  sql: Sql,
  input: {
    userId: string;
    organizationId?: string | null;
    userAgent?: string | null;
    ipAddress?: string | null;
  },
): Promise<{ token: string; session: SessionRecord }> {
  const { token, hash } = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const rows = (await sql`
    INSERT INTO sessions (user_id, token_hash, organization_id, user_agent, ip_address, expires_at)
    VALUES (
      ${input.userId}, ${hash}, ${input.organizationId ?? null},
      ${input.userAgent ?? null}, ${input.ipAddress ?? null}, ${expiresAt}
    )
    RETURNING id, user_id, organization_id, expires_at
  `) as unknown as SessionRecord[];
  return { token, session: rows[0] as SessionRecord };
}

export async function resolveSession(sql: Sql, token: string): Promise<AuthenticatedContext | null> {
  const rows = (await sql`
    SELECT
      s.id            AS session_id,
      s.user_id,
      s.organization_id,
      s.expires_at,
      u.email, u.name, u.is_active, u.mfa_enrolled, u.last_login_at,
      m.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN memberships m
      ON m.user_id = s.user_id AND m.organization_id = s.organization_id
    WHERE s.token_hash = ${hashToken(token)}
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
  `) as unknown as Array<{
    session_id: string;
    user_id: string;
    organization_id: string | null;
    expires_at: Date;
    email: string;
    name: string;
    is_active: boolean;
    mfa_enrolled: boolean;
    last_login_at: Date | null;
    role: Role | null;
  }>;

  const row = rows[0];
  if (!row || !row.is_active) return null;

  // Sliding expiry, refreshed at most once a minute to avoid a write per request.
  await sql`
    UPDATE sessions
    SET last_seen_at = now(),
        expires_at = now() + interval '12 hours'
    WHERE id = ${row.session_id} AND last_seen_at < now() - interval '1 minute'
  `;

  return {
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      is_active: row.is_active,
      mfa_enrolled: row.mfa_enrolled,
      last_login_at: row.last_login_at,
    },
    session: {
      id: row.session_id,
      user_id: row.user_id,
      organization_id: row.organization_id,
      expires_at: row.expires_at,
    },
    organizationId: row.organization_id,
    role: row.role,
  };
}

export async function revokeSession(sql: Sql, token: string): Promise<void> {
  await sql`
    UPDATE sessions SET revoked_at = now() WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL
  `;
}

export async function revokeAllSessionsForUser(sql: Sql, userId: string): Promise<void> {
  await sql`UPDATE sessions SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
}

export async function switchSessionOrganization(
  sql: Sql,
  sessionId: string,
  organizationId: string,
): Promise<void> {
  await sql`UPDATE sessions SET organization_id = ${organizationId} WHERE id = ${sessionId}`;
}

export async function listMemberships(
  sql: Sql,
  userId: string,
): Promise<Array<{ organization_id: string; name: string; slug: string; role: Role }>> {
  return (await sql`
    SELECT m.organization_id, o.name, o.slug, m.role
    FROM memberships m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ${userId} AND o.deleted_at IS NULL
    ORDER BY o.name
  `) as unknown as Array<{ organization_id: string; name: string; slug: string; role: Role }>;
}

export async function getMembershipRole(
  sql: Sql,
  userId: string,
  organizationId: string,
): Promise<Role | null> {
  const rows = (await sql`
    SELECT role FROM memberships WHERE user_id = ${userId} AND organization_id = ${organizationId}
  `) as unknown as Array<{ role: Role }>;
  return rows[0]?.role ?? null;
}

export async function createPasswordResetToken(
  sql: Sql,
  userId: string,
  ttlMinutes = 60,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (${userId}, ${hashToken(token)}, now() + (${ttlMinutes} || ' minutes')::interval)
  `;
  return token;
}

export async function consumePasswordResetToken(
  sql: Sql,
  token: string,
  newPassword: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT id, user_id FROM password_reset_tokens
      WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > now()
      FOR UPDATE
    `) as unknown as Array<{ id: string; user_id: string }>;
    const row = rows[0];
    if (!row) return false;

    const passwordHash = await hashPassword(newPassword);
    await tx`UPDATE users SET password_hash = ${passwordHash}, updated_at = now() WHERE id = ${row.user_id}`;
    await tx`UPDATE password_reset_tokens SET used_at = now() WHERE id = ${row.id}`;
    // Any session opened with the old password is invalidated.
    await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${row.user_id} AND revoked_at IS NULL`;
    return true;
  }) as Promise<boolean>;
}
