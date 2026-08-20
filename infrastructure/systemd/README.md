# Production deployment via systemd

Scripts the "Production topology" section of `docs/deployment-guide.md`: the
same images `infrastructure/Dockerfile.api` and `Dockerfile.web` build —
already built, brought up and smoke-tested on every CI run by the `docker`
job — run here as long-lived systemd services instead of a `docker compose`
session, fed by images `.github/workflows/publish-images.yml` publishes.

What this does **not** script, on purpose: PostgreSQL itself. The topology
diagram shows "PostgreSQL (primary + replica)" as infrastructure this
platform connects to, not infrastructure it stands up — a real deployment's
database is a managed service, a separately-administered server, or at least
a machine with its own backup policy, none of which a unit file here should
presume to own. Point `DATABASE_URL` in `api.env` at whatever that is.

## Prerequisites

- A host with Docker installed and `systemd` (any modern Linux distribution).
- A published set of images: push to `main` and let
  `.github/workflows/publish-images.yml` build and push
  `ghcr.io/<owner>/<repo>-api` and `-web` after CI passes. If the repository
  (and therefore the packages) is private, `docker login ghcr.io` on the host
  with a personal access token that has `read:packages` scope before the
  units below try to pull.
- A PostgreSQL 16+ database reachable from the host, and its connection
  string.
- A domain name pointed at the host, for certbot to issue a certificate
  against.

## Install

```bash
# 1. Application + deploy config.
sudo mkdir -p /etc/cre-platform /var/lib/cre-platform/uploads
sudo cp infrastructure/systemd/deploy.env.example /etc/cre-platform/deploy.env
sudo cp infrastructure/systemd/api.env.example /etc/cre-platform/api.env
sudo "$EDITOR" /etc/cre-platform/deploy.env  # real owner/repo
sudo "$EDITOR" /etc/cre-platform/api.env     # real DATABASE_URL, SESSION_SECRET, WEB_ORIGIN
sudo chmod 600 /etc/cre-platform/api.env

# 2. Units.
sudo cp infrastructure/systemd/cre-network.service \
        infrastructure/systemd/cre-api.service \
        infrastructure/systemd/cre-worker.service \
        infrastructure/systemd/cre-web.service \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cre-network.service
sudo systemctl enable --now cre-api.service
sudo systemctl enable --now cre-worker.service
sudo systemctl enable --now cre-web.service

# 3. TLS-terminating reverse proxy — see the file itself for the certbot
#    command that issues the certificate it references.
sudo cp infrastructure/nginx/production.conf.example \
        /etc/nginx/sites-available/cre-platform
sudo "$EDITOR" /etc/nginx/sites-available/cre-platform  # replace example.invalid
sudo ln -s /etc/nginx/sites-available/cre-platform /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Confirm with `curl https://<domain>/api/v1/health` — `{"status":"ok"}` means
the whole chain (host nginx → `web` container → `api` container → database)
is up.

## Operating

```bash
journalctl -u cre-api -f       # follow logs
systemctl status cre-worker
systemctl restart cre-api cre-worker cre-web   # after changing deploy.env or api.env
```

**Deploying a new build**: `publish-images.yml` runs on every push to `main`
that passes CI, updating the `:latest` tag. Run
`systemctl restart cre-api cre-worker cre-web` on the host to pull and switch
to it — `cre-api.service` runs the migration
(`pnpm --filter @cre/database run migrate`) before starting, matching
`docs/deployment-guide.md`'s documented deploy order (migrate, then release
API and worker).

**Rollback**: set `CRE_API_IMAGE`/`CRE_WEB_IMAGE` in `deploy.env` to a
specific commit SHA tag instead of `:latest` (every image is published under
both), then restart the three units. `pnpm check:migrations` gates every
migration in CI on the previous release still being able to run against it,
so this is safe by construction — see `docs/deployment-guide.md`'s Rollback
section.

## What is still not scripted

- Provisioning the host itself, DNS, and the PostgreSQL server/replica —
  infrastructure decisions specific to wherever this actually runs, not
  something a unit file in this repository should decide on an operator's
  behalf.
- Horizontal scaling beyond one host. `docs/deployment-guide.md`'s Scaling
  notes cover what the load and concurrency tests found; running more than
  one `cre-api`/`cre-worker` pair means more hosts (or a real orchestrator),
  which is beyond what systemd units on a single machine can express.
