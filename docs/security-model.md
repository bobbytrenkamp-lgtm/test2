# Security model

## Threat model

The platform holds rent rolls, tenant financial terms and valuations for
multiple organizations. The threats that matter most, in order:

1. **Cross-organization disclosure.** One client reading another's rent roll.
2. **Privilege escalation.** A read-only reviewer altering an approved valuation.
3. **Session theft.** A stolen cookie or a database dump yielding live sessions.
4. **Credential attacks.** Stuffing, brute force, account enumeration.
5. **Injection and forgery.** SQL injection, CSRF, XSS.
6. **Leakage through side channels.** Logs, error messages, exports.

## 1. Cross-organization isolation

Every tenant-scoped table carries `organization_id` and every query filters on
it. A user acts only inside the organization their **session** currently points
at; switching re-verifies membership, so a removed member cannot replay an old
request.

A record in another organization returns **404, not 403**. Reporting "forbidden"
would confirm the identifier exists, which is itself a disclosure.

`tests/authorization.test.ts` builds two real organizations with real data and
asserts that a member of one cannot read, modify, calculate, export or audit the
other's records even when handed the exact identifiers.

## 2. Authorization

Roles map to capabilities in one place, `packages/domain-models/src/permissions.ts`,
so the API, worker and client cannot drift on what a role may do.

| Role | Read | Write | Calculate | Approve | Admin |
| --- | --- | --- | --- | --- | --- |
| Organization owner | ✓ | ✓ | ✓ | ✓ | ✓ |
| Administrator | ✓ | ✓ | ✓ | ✓ | ✓ |
| Portfolio / asset manager | ✓ | ✓ | ✓ | ✓ | — |
| Acquisitions, analyst | ✓ | ✓ | ✓ | — | — |
| Valuation | ✓ | ✓ | ✓ | ✓ | — |
| Reviewer | ✓ | — | ✓ | ✓ | — |
| Read-only | ✓ | — | — | — | — |

The server checks every request. The client uses the same table only to decide
what to render; hiding a control is a convenience, never a control.

An organization can never be left without an owner: demoting or removing the
last owner is refused.

## 3. Sessions and credentials

- Session tokens are 32 random bytes. Only the **SHA-256 digest** is stored, so
  a database disclosure does not hand over live sessions.
- Cookies are `HttpOnly`, `SameSite=Lax`, signed, and `Secure` — the process
  **refuses to start** in production without `SESSION_COOKIE_SECURE=true`.
- Sliding 12-hour expiry, refreshed at most once a minute to avoid a write per
  request.
- Passwords use **scrypt** (N=16384, r=8, p=1, 64-byte key) from the Node
  standard library — memory-hard, no native dependency. Parameters are stored in
  the hash so they can be raised later; a login with outdated parameters is
  rehashed on success.
- Policy leads with **length** (12 characters minimum) rather than character
  classes, which push users toward predictable substitutions.
- A password reset revokes every session for that user.

**Not implemented:** multi-factor authentication. The `mfa_enrolled` column
exists; no second factor is enforced.

## 4. Account enumeration

- Login verifies against a dummy hash when the address is unknown, so a missing
  account and a wrong password take comparable time.
- Login failure returns an identical response either way. This is asserted:
  `expect(known.json()).toEqual(unknown.json())`.
- Registration does not reveal that an address is already in use.
- Password reset always responds "if that address has an account…".

## 5. Injection, forgery and content

- **SQL:** every query is parameterised through postgres.js tagged templates.
  The two `unsafe()` call sites take table names from a closed internal list,
  never from user input.
- **CSRF:** state-changing requests must carry `X-Requested-With: cre-platform`,
  which a cross-site form post cannot set. With `SameSite=Lax` this blocks
  forgery without a token round trip.
- **XSS:** React escapes by default; no `dangerouslySetInnerHTML` anywhere. The
  print-HTML renderer escapes every interpolated value explicitly.
- **CSP:** `default-src 'self'`, no inline scripts, `frame-ancestors 'none'`,
  `object-src 'none'`.
- **Rate limiting:** 600 requests/minute globally, 10/minute on authentication.

## 6. Leakage

- Unexpected errors are logged in full and returned as a generic message,
  because the underlying text can contain SQL, file paths or model data.
  Framework-raised **client** errors pass their status and message through, so a
  malformed request is not reported as a server fault.
- Audit entries record only the fields a change touched, never a whole rent roll.
- The worker logs job kind and identifiers, never payloads.
- Exports respect the caller's capabilities; spreadsheet export requires
  `export:run`.

## 7. Uploads

Designed, not yet reachable: `documents` carries a checksum, a byte size, an
opaque storage key and a `scan_status`. **No scanner is wired and no upload
endpoint exists.** The rent-roll import takes CSV text through the normal JSON
body, subject to the 5 MB body limit.

## 8. Data handling

Uploaded financial documents and model content **never leave the deployment**.
Import parsing is entirely deterministic and contacts no external service. The
optional AI assistant is disabled by default, and if enabled must not transmit
model content without explicit consent.

## 9. Audit

Append-only by application convention: no code path updates or deletes
`audit_log`. Entries record user, action, entity, changed fields, timestamp,
organization and IP where appropriate, and are exportable as NDJSON.

**Not yet done:** a database-level grant preventing UPDATE and DELETE for the
application role. Recorded in `docs/feature-status.md`.

## 10. Verified vs. asserted

**Verified by tests:** isolation, capability enforcement, CSRF, session
revocation, enumeration resistance, password policy, owner-retention.

**Implemented but untested:** rate limiting, CSP headers, export permissions.

**Not implemented:** MFA, malware scanning, database-level audit immutability,
dependency scanning that fails the build, penetration testing.
