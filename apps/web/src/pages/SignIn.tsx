import { useState } from 'react';
import { ApiError } from '../api.js';
import { Field } from '../components.js';
import { useSession } from '../session.js';

export function SignInPage(): JSX.Element {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Separate from `error`: the message stays up after a failed attempt so the
  // user knows what went wrong, but each field's own invalid marking clears
  // as soon as they start correcting it, rather than staying red until they
  // resubmit and find out whether the edit actually fixed it.
  const [invalidFields, setInvalidFields] = useState<Set<'email' | 'password' | 'code'>>(new Set());
  const [pending, setPending] = useState(false);
  /*
   * Whether this account has asked for a second factor.
   *
   * The field is revealed only after the server says so, rather than shown to
   * everyone. Most accounts do not have one, and a code box on every sign-in
   * would be a question most people cannot answer.
   */
  const [needsCode, setNeedsCode] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      // No navigation on success: `Shell` renders this component in place of
      // the normal layout only while `session` is null, on whatever URL the
      // browser already had — an invitation link, a deep link to a model, or
      // just "/". `signIn` resolves the session, `Shell` re-renders with that
      // same URL against the real routes, and whatever was actually asked for
      // shows up. Navigating to "/" here would discard that destination.
      await signIn(email, password, code);
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        (cause.code === 'MFA_REQUIRED' || cause.code === 'MFA_INVALID')
      ) {
        setNeedsCode(true);
        // The password was right, so it is not re-entered; only the code is.
        setError(
          cause.code === 'MFA_REQUIRED'
            ? 'Enter the current code from your authenticator app.'
            : 'That code is not right. Codes change every 30 seconds — try the current one.',
        );
        // MFA_REQUIRED asks for a code nobody has entered yet — that is not a
        // wrong value, so the field is not marked invalid until it actually is.
        setInvalidFields(cause.code === 'MFA_INVALID' ? new Set(['code']) : new Set());
      } else {
        setError(
          cause instanceof ApiError ? cause.message : 'The server could not be reached. Try again.',
        );
        setInvalidFields(new Set(['email', 'password']));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>Sign in</h1>
        <p className="lede">Commercial real estate underwriting, valuation and asset management.</p>

        {error && (
          <div className="message error" role="alert">
            {error}
          </div>
        )}

        <Field label="Email address">
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setInvalidFields((fields) => {
                if (!fields.has('email')) return fields;
                const next = new Set(fields);
                next.delete('email');
                return next;
              });
            }}
            aria-invalid={invalidFields.has('email') ? 'true' : undefined}
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setInvalidFields((fields) => {
                if (!fields.has('password')) return fields;
                const next = new Set(fields);
                next.delete('password');
                return next;
              });
            }}
            aria-invalid={invalidFields.has('password') ? 'true' : undefined}
          />
        </Field>

        {needsCode && (
          <Field
            label="Authenticator code"
            hint="Six digits from your authenticator app, or one of your recovery codes."
          >
            <input
              // `one-time-code` lets a password manager and iOS fill it, and
              // `inputMode` gives a phone the numeric keypad.
              autoComplete="one-time-code"
              inputMode="numeric"
              autoFocus
              required
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setInvalidFields((fields) => {
                  if (!fields.has('code')) return fields;
                  const next = new Set(fields);
                  next.delete('code');
                  return next;
                });
              }}
              aria-invalid={invalidFields.has('code') ? 'true' : undefined}
            />
          </Field>
        )}

        <button type="submit" className="primary" disabled={pending} style={{ width: '100%' }}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="field-hint" style={{ marginTop: 16 }}>
          A seeded development database signs in with <code>owner@example.invalid</code> and the
          password printed by <code>pnpm db:seed</code>. All seeded data is fictional.
        </p>
      </form>
    </div>
  );
}
