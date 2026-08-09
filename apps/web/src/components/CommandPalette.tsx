import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Model, type Property } from '../api.js';
import { useFavourites } from '../favourites.js';
import { useShortcut } from '../hooks.js';
import { readRecents } from '../recents.js';
import { useSession } from '../session.js';

/**
 * Command palette.
 *
 * Someone who lives in this application all day should not have to reach for a
 * mouse to get from one asset to another. Ctrl/Cmd + K opens it anywhere,
 * typing filters, and Enter goes.
 *
 * Properties and models are fetched once when the palette first opens, not on
 * every keystroke: an analyst types faster than a round trip, and a
 * search-as-you-type endpoint would make the palette feel slower than the
 * navigation it replaces.
 */

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

export function CommandPalette(): JSX.Element | null {
  const navigate = useNavigate();
  const { session } = useSession();
  const { favourites } = useFavourites();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [properties, setProperties] = useState<Property[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useShortcut('k', () => setOpen((value) => !value));

  useEffect(() => {
    if (!open || loaded || !session?.organizationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [propertyResponse, modelResponse] = await Promise.all([
          api.get<{ properties: Property[] }>('/properties'),
          api.get<{ models: Model[] }>('/models'),
        ]);
        if (cancelled) return;
        setProperties(propertyResponse.properties);
        setModels(modelResponse.models);
        setLoaded(true);
      } catch {
        // A palette that cannot load its index is still useful for the static
        // commands below, so a failure here is not surfaced as an error.
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loaded, session?.organizationId]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      // Focus after the dialog paints, or the keystroke that opened it lands
      // in whatever had focus before.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => {
      setOpen(false);
      navigate(path);
    };
    const list: Command[] = [
      { id: 'nav-dashboard', label: 'Dashboard', group: 'Go to', run: go('/') },
      { id: 'nav-properties', label: 'Properties', group: 'Go to', run: go('/properties') },
      { id: 'nav-portfolios', label: 'Portfolios', group: 'Go to', run: go('/portfolios') },
      { id: 'nav-funds', label: 'Funds', group: 'Go to', run: go('/funds') },
      { id: 'nav-tasks', label: 'Tasks', group: 'Go to', run: go('/tasks') },
      { id: 'nav-jobs', label: 'Background jobs', group: 'Go to', run: go('/jobs') },
      { id: 'nav-audit', label: 'Audit history', group: 'Go to', run: go('/audit') },
    ];

    for (const property of properties) {
      list.push({
        id: `property-${property.id}`,
        label: property.name,
        hint: [property.city, property.market].filter(Boolean).join(' · '),
        group: 'Properties',
        run: go(`/properties/${property.id}`),
      });
    }

    for (const model of models) {
      list.push({
        id: `model-${model.id}`,
        label: model.name,
        hint: model.status,
        group: 'Models',
        run: go(`/models/${model.id}`),
      });
    }

    return list;
  }, [properties, models, navigate]);

  /**
   * Favourites and recents, shown ahead of everything else when nobody has
   * typed anything. This is the palette's answer to "where was I" — the
   * question it opens on far more often than "find me something new".
   */
  const quickAccess = useMemo<Command[]>(() => {
    const go = (path: string) => () => {
      setOpen(false);
      navigate(path);
    };
    const seen = new Set<string>();
    const list: Command[] = [];

    for (const entry of favourites) {
      const key = `${entry.entity_type}-${entry.entity_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        id: `fav-${key}`,
        label: entry.name,
        hint: entry.context ?? undefined,
        group: 'Favourites',
        run: go(
          entry.entity_type === 'property'
            ? `/properties/${entry.entity_id}`
            : `/models/${entry.entity_id}`,
        ),
      });
    }

    if (session?.user.id && session.organizationId) {
      for (const entry of readRecents(session.user.id, session.organizationId)) {
        const key = `${entry.entityType}-${entry.entityId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({
          id: `recent-${key}`,
          label: entry.name,
          hint: entry.context ?? undefined,
          group: 'Recently viewed',
          run: go(
            entry.entityType === 'property'
              ? `/properties/${entry.entityId}`
              : `/models/${entry.entityId}`,
          ),
        });
      }
    }

    return list;
  }, [favourites, session?.user.id, session?.organizationId, navigate]);

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) {
      // The rest of the index still fills out the list, but never repeats an
      // asset already shown as a favourite or a recent.
      const shown = new Set(quickAccess.map((command) => command.id.replace(/^(fav|recent)-/, '')));
      const rest = commands.filter((command) => !shown.has(command.id));
      return [...quickAccess, ...rest].slice(0, 12);
    }
    return commands
      .filter(
        (command) =>
          command.label.toLowerCase().includes(text) ||
          (command.hint ?? '').toLowerCase().includes(text),
      )
      .slice(0, 20);
  }, [commands, quickAccess, query]);

  useEffect(() => {
    // Keep the highlight inside the list as it shortens under typing.
    setSelected((current) => Math.min(current, Math.max(matches.length - 1, 0)));
  }, [matches.length]);

  if (!open) return null;

  const activeId = matches[selected]?.id;

  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <label htmlFor="palette-input" className="visually-hidden">
          Search properties, models and screens
        </label>
        <input
          id="palette-input"
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={activeId}
          autoComplete="off"
          placeholder="Search properties, models and screens…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelected((current) => Math.min(current + 1, matches.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected((current) => Math.max(current - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              matches[selected]?.run();
            }
          }}
        />

        <ul id="palette-list" role="listbox" aria-label="Results" className="palette-list">
          {matches.length === 0 && (
            <li className="palette-empty" role="presentation">
              Nothing matches “{query}”.
            </li>
          )}
          {matches.map((command, index) => (
            <li
              key={command.id}
              id={command.id}
              role="option"
              aria-selected={index === selected}
              className={index === selected ? 'palette-item selected' : 'palette-item'}
              onMouseEnter={() => setSelected(index)}
              onClick={() => command.run()}
            >
              <span className="palette-group">{command.group}</span>
              <span className="palette-label">{command.label}</span>
              {command.hint && <span className="palette-hint">{command.hint}</span>}
            </li>
          ))}
        </ul>

        <p className="palette-footer">
          <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to go · <kbd>Esc</kbd> to close
        </p>
      </div>
    </div>
  );
}
