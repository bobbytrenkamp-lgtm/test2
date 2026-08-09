import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api.js';

/**
 * Data-loading hook.
 *
 * Every consumer gets an explicit loading, error and empty state rather than
 * an optimistic render: a financial screen must never present a partial figure
 * as if it were the answer. In-flight requests are aborted when the path
 * changes so a slow response cannot overwrite a newer one.
 */
export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

export function useResource<T>(path: string | null, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    setError(null);
    api
      .get<T>(path, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError(0, 'NETWORK_ERROR', 'The server could not be reached.'),
        );
        setLoading(false);
      });

    return () => controller.abort();
    // Deps are listed deliberately; see the comment above.
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, reload };
}

/** Tracks an in-flight mutation with its own error state. */
export function useMutation<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
): {
  run: (...args: TArgs) => Promise<TResult | null>;
  pending: boolean;
  error: ApiError | null;
  clearError: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | null> => {
      setPending(true);
      setError(null);
      try {
        return await action(...args);
      } catch (cause) {
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError(0, 'NETWORK_ERROR', 'The server could not be reached.'),
        );
        return null;
      } finally {
        setPending(false);
      }
    },
    [action],
  );

  return { run, pending, error, clearError: () => setError(null) };
}

/**
 * Warns before the browser discards unsaved edits. Registered only while a
 * form is genuinely dirty, so it never fires spuriously.
 */
export function useUnsavedChangesWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}

/** Registers a global keyboard shortcut, ignoring keystrokes inside inputs. */
export function useShortcut(key: string, handler: () => void, withMeta = true): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const inField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;
      if (withMeta && !(event.metaKey || event.ctrlKey)) return;
      if (!withMeta && inField) return;
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [key, handler, withMeta]);
}

/**
 * A Ctrl/Cmd shortcut that yields to whatever field has focus.
 *
 * Separate from `useShortcut` because the policy is genuinely different, not
 * because of a flag. `Cmd+K` and `Cmd+Enter` should open the palette and
 * recalculate from anywhere, including mid-sentence in a notes field — they are
 * navigation. `Cmd+Z` must not: inside an open cell editor it belongs to the
 * text being typed, and stealing it would undo somebody's paste while they were
 * correcting a tenant name.
 *
 * The handler receives the event so it can read `shiftKey`, which is how one
 * binding covers undo and redo.
 */
export function useEditShortcut(key: string, handler: (event: KeyboardEvent) => void): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      handler(event);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [key, handler]);
}

/** Persists a small value locally, e.g. a saved view or column preference. */
export function useLocalState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // A full or disabled local store is not worth interrupting the user for.
      }
    },
    [key],
  );

  return [value, update];
}
