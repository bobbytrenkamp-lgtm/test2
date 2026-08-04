# Browser tests

```bash
pnpm test:e2e            # the whole suite
pnpm test:e2e --headed   # watch it run
pnpm test:e2e underwriting
pnpm test:e2e:report     # open the HTML report from the last CI-style run
```

`docs/testing-strategy.md` explains what these assert and why. This file is the
operational detail.

## What a run does

1. **Rebuilds the database.** `prepare-database.ts` creates `cre_platform_e2e`
   if it is absent, drops and recreates its schema from the migrations, and
   re-seeds it. It refuses to run against a database whose name does not contain
   `e2e`, because dropping a schema is not something to get almost right.
2. **Starts the API** on port 4100 against that database.
3. **Builds the web client and serves it** with `vite preview` on port 5174. The
   browser drives the production bundle, not the dev server, through the same
   same-origin `/api` proxy the real deployment uses.
4. **Signs in once per role** and saves the session to `e2e/.auth/`. The login
   route is rate limited; re-authenticating per test would exhaust that budget
   and fail for the wrong reason.
5. Runs the specs.

Servers are never reused between runs — an inherited server would be talking to
a database this run has just rebuilt underneath it.

## Requirements

- PostgreSQL reachable at `postgres://cre:cre@127.0.0.1:5432`, or set
  `E2E_DATABASE_URL`. The role needs permission to create a database.
- Chromium: `pnpm exec playwright install chromium`.

Nothing else. No hosted browser service, no account, no key.

## Overrides

| Variable | Default |
| --- | --- |
| `E2E_DATABASE_URL` | `postgres://cre:cre@127.0.0.1:5432/cre_platform_e2e` |
| `E2E_API_PORT` | `4100` |
| `E2E_WEB_PORT` | `5174` |

## Conventions

- **Locate by role and accessible name**, not by CSS class or test id. A test
  that can only find a button by its class does not prove the button is usable;
  finding it the way a screen reader does proves rather more.
- **Assert on the seed by name**, never by generated identifier. `roles.ts`
  holds the fixture names in one place.
- **Never assert a screen's own claim as evidence of persistence.** The import
  test reads the rent roll afterwards, because the wizard reporting success is
  not the same as a row existing.
- `e2e/.auth/` holds live session cookies and is git-ignored. It is deleted at
  the start of every run.
