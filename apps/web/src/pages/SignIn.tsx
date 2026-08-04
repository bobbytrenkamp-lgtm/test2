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
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await signIn(email, password);
      navigate('/', { replace: true });
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'The server could not be reached. Try again.',
      );
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
