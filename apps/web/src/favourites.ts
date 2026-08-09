import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { useSession } from './session.js';

/**
 * Pinned properties and models, shared by every screen that shows a star.
 *
 * One fetch per mount of the shell's lifetime, not per screen: the list is
 * small, and a property page and the dashboard should agree instantly about
 * what is pinned rather than each holding a stale copy until its own refetch.
 */

export interface Favourite {
  entity_type: 'property' | 'model';
  entity_id: string;
  name: string;
  context: string | null;
  created_at: string;
}

export function useFavourites(): {
  favourites: Favourite[];
  loading: boolean;
  isFavourite: (entityType: 'property' | 'model', entityId: string) => boolean;
  toggle: (entityType: 'property' | 'model', entityId: string) => Promise<void>;
} {
  const { session } = useSession();
  const [favourites, setFavourites] = useState<Favourite[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session?.organizationId) {
      setFavourites([]);
      setLoading(false);
      return;
    }
    try {
      const response = await api.get<{ favourites: Favourite[] }>('/favourites');
      setFavourites(response.favourites);
    } finally {
      setLoading(false);
    }
  }, [session?.organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isFavourite = useCallback(
    (entityType: 'property' | 'model', entityId: string) =>
      favourites.some((entry) => entry.entity_type === entityType && entry.entity_id === entityId),
    [favourites],
  );

  const toggle = useCallback(
    async (entityType: 'property' | 'model', entityId: string) => {
      const currentlyPinned = isFavourite(entityType, entityId);
      // Applied to local state before the round trip completes: a star is a
      // toggle, and waiting for the network to flip it reads as broken on
      // anything but a fast connection. Reloaded from the server after, so a
      // failure corrects itself rather than leaving the two out of sync.
      if (currentlyPinned) {
        setFavourites((prev) =>
          prev.filter(
            (entry) => !(entry.entity_type === entityType && entry.entity_id === entityId),
          ),
        );
        await api.delete(`/favourites/${entityType}/${entityId}`);
      } else {
        await api.put(`/favourites/${entityType}/${entityId}`, {});
      }
      await load();
    },
    [isFavourite, load],
  );

  return { favourites, loading, isFavourite, toggle };
}
