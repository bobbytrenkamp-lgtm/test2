-- Multi-factor authentication.
--
-- `users.mfa_enrolled` has been in the schema since it was written, with
-- nothing setting it. These are the columns that make it mean something.
--
-- Purely additive, so the previous release runs against this schema unchanged:
-- it simply never reads these columns and never sets `mfa_enrolled`, which
-- leaves every account exactly as it behaves today. See scripts/check-migrations.mjs.

-- The shared secret, base32 as an authenticator app expects it.
--
-- Nullable and separate from `mfa_enrolled` on purpose: a secret exists from
-- the moment enrolment starts, but the account is not protected until a code
-- has been verified. Flipping the flag on issue would lock somebody out of
-- their own account with a secret they never finished scanning.
ALTER TABLE users ADD COLUMN mfa_secret text;

-- When the enrolment was confirmed, for the security screen to show and for an
-- administrator answering "since when".
ALTER TABLE users ADD COLUMN mfa_confirmed_at timestamptz;

-- Recovery codes, for the phone that fell in a river.
--
-- Hashed, not stored. A list of plaintext bypass codes is a second password
-- column with none of the care taken over the first, and it would turn one
-- database read into a way past every second factor in the organization.
CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Single use. Kept rather than deleted so "a recovery code was used" stays
  -- answerable afterwards, which is exactly when somebody asks.
  used_at    timestamptz
);

CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;
