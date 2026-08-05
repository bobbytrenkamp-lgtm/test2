import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api.js';
import { Field } from '../components.js';
import { useSession } from '../session.js';

export function SignInPage(): JSX.Element {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
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
      await signIn(email, password, code);
      navigate('/', { replace: true });
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
      } else {
        setError(
          cause instanceof ApiError ? cause.message : 'The server could not be reached. Try again.',
        );
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
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={error ? 'true' : undefined}
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error ? 'true' : undefined}
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
              onChange={(event) => setCode(event.target.value)}
              aria-invalid={error ? 'true' : undefined}
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
