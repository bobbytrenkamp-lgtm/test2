/**
 * Recently opened properties and models.
 *
 * ## Why this is not on the server
 *
 * Favourites are. The difference is what the two things are.
 *
 * A favourite is a decision — *these six are what I am working on* — and a
 * decision should follow you to whatever machine you sign in from. A recents
 * list is not a decision; it is a trace of one device's afternoon. Storing it
 * would mean writing a row on every navigation to record something nobody
 * asked for, and it would merge a laptop's morning with a desk machine's
 * afternoon into a list that is a worse answer than either.
 *
 * So this is `localStorage`, and the product documentation says so rather than
 * implying the list follows you.
 *
 * ## Why it is keyed by user and organization
 *
 * `localStorage` belongs to the browser, not to the person. Two people sharing
 * a machine would otherwise see each other's asset names — a small leak, but a
 * real one, and the sort that is embarrassing precisely because it was
 * avoidable. Each list is stored under the user and organization it was built
 * in, and signing out clears every list this origin holds rather than only the
 * one that happened to be active.
 *
 * ## Why it degrades quietly
 *
 * Private-browsing modes and storage-policy settings make `localStorage` throw
 * rather than fail silently. Every access here is wrapped: the worst outcome is
 * an empty recents list, which is a great deal better than a shell that will
 * not render.
 */

export interface Recent {
  entityType: 'property' | 'model';
  entityId: string;
  name: string;
  context: string | null;
  /** Epoch milliseconds, so the list can be ordered without parsing. */
  at: number;
}

const PREFIX = 'cre.recents';
const LIMIT = 8;

function keyFor(userId: string, organizationId: string): string {
  return `${PREFIX}.${userId}.${organizationId}`;
}

export function readRecents(userId: string, organizationId: string): Recent[] {
  try {
    const raw = window.localStorage.getItem(keyFor(userId, organizationId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validated on the way out rather than trusted: this is data the user's own
    // browser holds and anything could have written it, including an older
    // version of this file.
    return parsed.filter(isRecent).slice(0, LIMIT);
  } catch {
    return [];
  }
}

/**
 * Records a visit, moving an asset already in the list to the front.
 *
 * Returns the new list so a caller can render it without reading back.
 */
export function recordRecent(
  userId: string,
  organizationId: string,
  entry: Omit<Recent, 'at'>,
): Recent[] {
  const next = [
    { ...entry, at: Date.now() },
    ...readRecents(userId, organizationId).filter(
      (existing) =>
        !(existing.entityType === entry.entityType && existing.entityId === entry.entityId),
    ),
  ].slice(0, LIMIT);

  try {
    window.localStorage.setItem(keyFor(userId, organizationId), JSON.stringify(next));
  } catch {
    // Storage full, or disabled. The list is a convenience; losing it is not
    // worth interrupting somebody's navigation for.
  }
  return next;
}

/**
 * Clears every recents list this origin holds, not only the active one.
 *
 * Called on sign-out. Clearing only the current user's list would leave the
 * previous one behind for whoever signs in next, which is the case this is
 * here to prevent.
 */
export function clearRecents(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

function isRecent(value: unknown): value is Recent {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<Recent>;
  return (
    (entry.entityType === 'property' || entry.entityType === 'model') &&
    typeof entry.entityId === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.at === 'number'
  );
}
