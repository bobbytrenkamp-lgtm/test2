# Zero-cost operation

**Requirement:** beyond an existing Claude subscription, this project must not
create any charge — no upgraded account, no usage-based billing, no payment
method, no spending limit above zero, no purchased domain, no paid hosting,
database, storage, authentication, email, monitoring, mapping, security, AI,
data or API service, and no dependency requiring a commercial licence.

**Audited:** 2026-08-04. Findings below are what was checked and observed, not
what was assumed.

---

## Summary

Nothing in this repository incurs a charge. No account was upgraded, no billing
was enabled, no payment method exists, no spending limit was raised, no domain
was bought, and no paid plan was activated. The platform runs entirely on
locally installed open-source components.

Two things were **hardened defensively** during this audit even though neither
was billing today, and one licensing ambiguity is recorded honestly.

---

## 1. GitHub Actions — the only metered surface

| Check | Finding |
| --- | --- |
| Repository visibility | **Public** (`"private": false`, verified via the API) |
| Billing consequence | GitHub Actions is **free without limit** on GitHub-hosted standard runners for public repositories |
| Runs so far | 4 (2 failed on a workflow defect, 2 passed), all on the free public-repo allowance |
| Self-hosted runners | None |
| Larger runners | None. `ubuntu-latest` only — Windows bills 2x and macOS 10x on metered accounts |
| Scheduled (`cron`) triggers | **None.** A schedule bills whether or not anything changed |

### Defect found and fixed

The workflow triggered on `push` to **every branch** *and* on `pull_request`.
On a branch with an open PR that is **two billed runs per push**. Harmless on a
public repository; on a private one it would consume the 2,000-minute monthly
free allowance at twice the necessary rate.

Now:

- `push` fires only on `main`. Feature branches are verified once, by the
  `pull_request` trigger.
- `concurrency` with `cancel-in-progress` means a rapid series of pushes costs
  one run, not one per push.
- `timeout-minutes: 20` caps a hung job. **Without this the default ceiling is
  six hours**, which is the single largest way a metered account leaks minutes.
- `permissions: contents: read` — least privilege.
- `workflow_dispatch` allows a manual run without adding a recurring cost.

### If this repository is ever made private

Actions minutes become metered against the account's free allowance. The
settings above keep usage far inside it (a full run is roughly two minutes), but
verify before switching:

- Settings → Billing → **spending limit stays at $0**.
- Settings → Billing → **"Actions" usage-based billing disabled**.

At a $0 limit GitHub *stops* running workflows when the allowance is exhausted;
it does not bill overage. That is the required "usage stops rather than
generating a charge" behaviour.

## 2. Codespaces, Pages and deployment

| Item | Finding |
| --- | --- |
| `.devcontainer` / `devcontainer.json` | **Absent** — Codespaces cannot start from this repository, so the free allowance cannot be consumed |
| GitHub Pages | **Disabled** (`"has_pages": false`) |
| Vercel / Netlify / Render / Fly / Railway / Heroku config | **None present** |
| Deployment workflow | **None.** Nothing is deployed anywhere |
| Purchased domain | **None** |

## 3. External services — none

| Concern | State |
| --- | --- |
| Outbound network calls in application code | **One**, `fetch('/api/v1…')` in `apps/web/src/api.ts` — same-origin, to this project's own API |
| Hard-coded external hosts | **None** outside `localhost`, `example.invalid` and documentation links |
| Paid-service SDKs (AWS, Stripe, Sentry, OpenAI, Anthropic, Google Cloud, Twilio, SendGrid, Mapbox, Firebase, Supabase, Auth0, Clerk, …) | **None installed** |
| AI assistant | `AI_ASSISTANT_PROVIDER=none`, disabled by default, not implemented. No provider bundled |
| Object storage | `STORAGE_DRIVER=local` — writes to a local directory |
| Email | **No mailer.** Reset and invitation tokens are returned in the response outside production |
| Monitoring | **None wired** |
| Maps | **None.** The geographic dashboard widget is deferred rather than backed by a paid tile provider |

Every one of these sits behind an interface (`docs/architecture.md`), so a
provider can be added later by choice — never by default.

## 4. Local-first stack

Everything runs on the developer's machine with no hosted dependency:

| Concern | Component | Licence |
| --- | --- | --- |
| Database | PostgreSQL 16, installed locally | PostgreSQL Licence (permissive) |
| Job queue | The same PostgreSQL database, `FOR UPDATE SKIP LOCKED` | — |
| Background worker | Node process | — |
| File storage | Local filesystem | — |
| Calculations, imports, exports | In-process | — |
| Web client | Vite dev server / static files | MIT |

Container images used by the (unverified) Compose stack are the free official
`postgres:16-alpine`, `node:22-alpine` and `nginx:1.27-alpine`. Docker Hub
applies anonymous pull *rate limits*, never charges.

## 5. Dependency licences

Checked automatically by `scripts/check-licences.mjs`, which runs offline
against the installed tree and **fails the build** on a paid, commercial or
copyleft licence. It runs in CI.

```
335 packages examined

  273  MIT
   24  ISC
   16  Apache-2.0
    7  BSD-3-Clause
    6  BSD-2-Clause
    2  Unlicense
    2  MIT/X11
    1  Python-2.0
    1  CC-BY-4.0
    1  (MIT OR GPL-3.0-or-later)     dual — MIT taken
    1  (MIT AND Zlib)
    1  UNDECLARED                     see below
```

No AGPL, SSPL, BUSL, Elastic, `UNLICENSED` or commercial licence is present.

### The one ambiguity, stated plainly

`buffers@0.1.1` declares **no licence at all** — no `license` field, no LICENSE
file. It arrives transitively via `exceljs → unzipper → binary → buffers`.

This is an *absent declaration*, not a commercial requirement: it costs nothing
and demands no payment. But strictly, an undeclared package carries no explicit
grant of rights. The upstream author's packages are conventionally MIT, and this
one is widely depended upon, so it is recorded in the checker's known list with
its reason rather than passed over silently.

If zero ambiguity is preferred, the fix is to drop `exceljs` and write the
`.xlsx` output directly (the format is a zip of XML). That removes spreadsheet
export's entire dependency subtree at the cost of implementing the writer.
Flagged as a decision, not taken unilaterally — it has no cost implication
either way.

## 6. What was deferred rather than paid for

Consistent with the requirement to build a free local version, expose an
interface, or defer:

| Feature | Decision |
| --- | --- |
| Email delivery | **Deferred.** No provider. Tokens returned in non-production so flows are testable |
| Malware scanning of uploads | **Deferred.** `scan_status` column and a driver seam exist; no scanner wired |
| Error monitoring | **Deferred.** Attachment point documented |
| Server-side PDF | **Deferred.** Print-ready HTML works through the browser's own print-to-PDF, free |
| Geographic maps | **Deferred.** No paid tile provider. Allocation is shown as charts and tables instead |
| AI assistant | **Deferred and disabled by default.** Provider-neutral design; nothing bundled |
| Cloud object storage | **Local driver.** S3-compatible support is an interface, not a dependency |

None of these blocks the platform. Each is recorded in `docs/feature-status.md`.

## 7. Standing rules

1. Never add a payment method, raise a spending limit, or enable usage-based
   billing.
2. A free *trial* is not an acceptable substitute for a permanently free option.
3. Before any external service, confirm in writing: a genuinely free plan; no
   payment method required; overage billing disabled; usage **stops** rather
   than charging at the limit; and the application can migrate away from it.
4. Prefer a local, open-source component. When one does not exist, defer the
   feature and document it.
5. No `cron` trigger in any workflow, and no job without `timeout-minutes`.
6. `scripts/check-licences.mjs` must pass. Widening its allow-list requires a
   stated reason in the diff.

## How to re-run this audit

```bash
node scripts/check-licences.mjs --list   # every licence in the tree
grep -rn "fetch(\|axios\|https\?://" --include="*.ts" --include="*.tsx" apps packages | grep -v node_modules
ls .devcontainer devcontainer.json vercel.json netlify.toml fly.toml 2>/dev/null
grep -n "cron\|schedule\|runs-on\|timeout-minutes" .github/workflows/*.yml
```
