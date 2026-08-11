import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api.js';
import { ErrorMessage } from '../components.js';
import { useMutation } from '../hooks.js';
import { useSession } from '../session.js';

/**
 * Redeems an organization invitation link for the signed-in account.
 *
 * Scoped to a user who already has an account: this screen requires being
 * signed in (the shared `Shell` falls back to the sign-in screen otherwise,
 * on the same URL, so the token survives that detour). Inviting someone with
 * no account yet still has to be completed through `/auth/register` directly
 * — there is no self-registration screen in this release — which is a known
 * gap, not something this page pretends to solve.
 */
export function AcceptInvitationPage(): JSX.Element {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const { session, refresh } = useSession();

  const accept = useMutation(async () => {
    if (!token) {
      throw new ApiError(400, 'MISSING_TOKEN', 'This invitation link is missing its token.');
    }
    const result = await api.post<{ organizationId: string; role: string }>('/invitations/accept', {
      token,
    });
    await refresh();
    return result;
  });

  return (
    <div className="card" style={{ maxWidth: 480, margin: '48px auto' }}>
      <h1>Join organization</h1>
      {!token ? (
        <div className="message error" role="alert">
          This invitation link is missing its token. Ask whoever sent it for a fresh one.
        </div>
      ) : (
        <>
          <p>
            Signed in as <strong>{session?.user.email}</strong>. Accepting joins the organization
            this invitation was sent for.
          </p>
          <ErrorMessage error={accept.error} />
          <button
            type="button"
            className="primary"
            disabled={accept.pending}
            onClick={async () => {
              if (await accept.run()) navigate('/', { replace: true });
            }}
          >
            {accept.pending ? 'Joining…' : 'Accept invitation'}
          </button>
        </>
      )}
    </div>
  );
}
