import { useState } from 'react';
import { api } from '../api.js';
import { ErrorMessage, Field } from '../components.js';
import { useMutation } from '../hooks.js';
import { useSession } from '../session.js';

/**
 * A brand-new account has no organization and nothing else in the product is
 * reachable without one — every other screen sits behind the "select an
 * organization" gate in `Shell`. This is the one way to get past it the
 * first time, short of a support ticket.
 *
 * The server switches the creator's session to the new organization as part
 * of creating it (`POST /organizations`), so a session refresh here is
 * enough to leave the gate — no separate "switch" call.
 */
export function CreateOrganizationForm(): JSX.Element {
  const { refresh } = useSession();
  const [name, setName] = useState('');

  const create = useMutation(async (organizationName: string) => {
    await api.post('/organizations', { name: organizationName });
    await refresh();
  });

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h2 style={{ marginTop: 0 }}>Create your organization</h2>
      <p className="field-hint">
        Everything in the platform — properties, models, and the people who work on them — belongs
        to an organization. Name yours to get started; you can invite the rest of your team once it
        exists.
      </p>
      <ErrorMessage error={create.error} />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          await create.run(name);
        }}
      >
        <Field label="Organization name">
          <input
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <button type="submit" className="primary" disabled={create.pending}>
          {create.pending ? 'Creating…' : 'Create organization'}
        </button>
      </form>
    </div>
  );
}
