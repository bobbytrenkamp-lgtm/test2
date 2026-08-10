import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Capability, EntitlementFeature } from '@cre/domain-models';
import { canUseFeature } from '@cre/domain-models';
import { ApiError, api, type Session } from './api.js';
import { clearRecents } from './recents.js';

interface SessionContextValue {
  session: Session | null;
  loading: boolean;
  can: (capability: Capability) => boolean;
  /**
   * Whether the caller's organization plan includes a named feature. Mirrors
   * `canUseFeature` on the server — see `apps/api/src/context.ts`'s
   * `requireFeature` — so a control can hide or explain itself the same way
   * `can` already does for role capabilities. The server re-checks on every
   * request; this only decides what to show.
   */
  hasFeature: (feature: EntitlementFeature) => boolean;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string, code?: string) => Promise<void>;
  signOut: () => Promise<void>;
  switchOrganization: (organizationId: string) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setSession(await api.get<Session>('/auth/me'));
    } catch (error) {
      // A 401 simply means nobody is signed in; anything else is worth
      // surfacing on the sign-in screen rather than crashing the shell.
      if (!(error instanceof ApiError) || error.status !== 401) {
        console.error('Failed to resolve the session', error);
      }
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string, code?: string) => {
      // The code is omitted rather than sent empty when there is none: an
      // account without a second factor should send exactly what it did before.
      await api.post('/auth/login', { email, password, ...(code ? { code } : {}) });
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    setSession(null);
    // Every recents list this origin holds, not only the one that was active:
    // a shared machine must not hand the next person signing in a trace of
    // this one's afternoon.
    clearRecents();
  }, []);

  const switchOrganization = useCallback(
    async (organizationId: string) => {
      await api.post(`/organizations/${organizationId}/switch`);
      await refresh();
    },
    [refresh],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      loading,
      // The server re-checks every capability; this only decides what to show.
      can: (capability) => session?.capabilities.includes(capability) ?? false,
      hasFeature: (feature) =>
        session?.entitlements ? canUseFeature(session.entitlements, feature) : false,
      refresh,
      signIn,
      signOut,
      switchOrganization,
    }),
    [session, loading, refresh, signIn, signOut, switchOrganization],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider.');
  return context;
}
