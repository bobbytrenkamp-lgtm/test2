import { useState } from 'react';
import { api } from '../api.js';
import { ErrorMessage, Field, Loading } from '../components.js';
import { formatDateTime } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { useSession } from '../session.js';

/**
 * Account security.
 *
 * Enrolment is deliberately two steps and the screen shows why: a secret is
 * issued, then a code generated from it has to be typed back before the account
 * is protected. Marking it enrolled on issue would lock somebody out with a
 * secret they never finished scanning — the failure where the security feature
 * is the attacker.
 *
 * The secret and the recovery codes are shown once, and the screen says so at
 * the moment it matters rather than in help text nobody opens.
 */

interface MfaState {
  enrolled: boolean;
  confirmedAt: string | null;
  pending: boolean;
  recoveryCodesRemaining: number;
}

export function SecurityPage(): JSX.Element {
  const { session } = useSession();
  const state = useResource<MfaState>('/auth/mfa');

  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');

  const enrol = useMutation(async () => {
    const response = await api.post<{ secret: string; uri: string }>('/auth/mfa/enrol', {});
    setSecret(response.secret);
    setUri(response.uri);
    return response;
  });

  const confirm = useMutation(async () => {
    const response = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/confirm', { code });
    setRecoveryCodes(response.recoveryCodes);
    // The secret is cleared from the browser the moment it is no longer needed.
    // It is already unrecoverable from the server; leaving it in a React state
    // that survives a route change would be the only remaining copy.
    setSecret(null);
    setUri(null);
    setCode('');
    return response;
  });

  const disable = useMutation(async () => {
    const response = await api.post('/auth/mfa/disable', { password });
    setPassword('');
    setRecoveryCodes(null);
    return response;
  });

  const enrolled = state.data?.enrolled ?? false;

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Security</h1>
          <p>
            Signed in as {session?.user.name} ({session?.user.email}).
          </p>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Two-factor authentication</h2>
          <span className={enrolled ? 'badge positive' : 'badge'}>{enrolled ? 'On' : 'Off'}</span>
        </div>

        <p className="field-hint" style={{ marginTop: 0 }}>
          A code from an authenticator app, in addition to your password. It means a stolen password
          is not enough on its own. It does not protect against someone relaying a code to this site
          in real time, which is what a hardware security key would solve.
        </p>

        <ErrorMessage error={state.error} />
        <ErrorMessage error={enrol.error} />
        <ErrorMessage error={confirm.error} />
        <ErrorMessage error={disable.error} />
        {state.loading && <Loading label="Loading security settings" />}

        {enrolled && state.data && (
          <div className="message info" role="status" aria-label="Two-factor status">
            Enabled{state.data.confirmedAt ? ` on ${formatDateTime(state.data.confirmedAt)}` : ''}.{' '}
            {state.data.recoveryCodesRemaining} recovery code
            {state.data.recoveryCodesRemaining === 1 ? '' : 's'} remaining.
          </div>
        )}

        {!enrolled && !secret && (
          <button
            type="button"
            className="primary"
            disabled={enrol.pending}
            onClick={async () => {
              if (await enrol.run()) state.reload();
            }}
          >
            {enrol.pending ? 'Preparing…' : 'Set up two-factor authentication'}
          </button>
        )}

        {secret && (
          <div style={{ marginTop: 12 }}>
            <h3>Step 1 — add it to your authenticator</h3>
            <p className="field-hint">
              Enter this key in your authenticator app. It is shown once and cannot be read back
              afterwards; if you lose it before finishing, start again.
            </p>
            <p>
              <code style={{ fontSize: 16, letterSpacing: 1 }}>{secret}</code>
            </p>
            {uri && (
              <p className="field-hint">
                Some apps accept a setup link instead: <code>{uri}</code>
              </p>
            )}

            <h3>Step 2 — prove it works</h3>
            <p className="field-hint">
              Nothing is switched on until a code from the app is accepted, so a key that did not
              scan properly cannot lock you out.
            </p>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (await confirm.run()) state.reload();
              }}
            >
              <Field label="Code from your app" hint="Six digits.">
                <input
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </Field>
              <button type="submit" className="primary" disabled={confirm.pending}>
                {confirm.pending ? 'Checking…' : 'Turn on two-factor authentication'}
              </button>
            </form>
          </div>
        )}

        {recoveryCodes && (
          <div
            className="message warning"
            style={{ marginTop: 12 }}
            role="status"
            aria-label="Recovery codes"
          >
            <strong>Save these recovery codes now.</strong>
            <p style={{ marginBottom: 8 }}>
              They are shown once and are the only way in if you lose your authenticator. Each works
              a single time.
            </p>
            <ul style={{ columns: 2, margin: 0 }}>
              {recoveryCodes.map((entry) => (
                <li key={entry}>
                  <code>{entry}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        {enrolled && (
          <form
            style={{ marginTop: 16 }}
            onSubmit={async (event) => {
              event.preventDefault();
              if (await disable.run()) state.reload();
            }}
          >
            <h3>Turn it off</h3>
            <p className="field-hint">
              Your password is required. Removing a second factor is the most valuable thing someone
              with a stolen session could do, and this is the cheapest place to ask again.
            </p>
            <Field label="Current password">
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <button type="submit" disabled={disable.pending}>
              {disable.pending ? 'Removing…' : 'Turn off two-factor authentication'}
            </button>
          </form>
        )}
      </div>
    </>
  );
}
