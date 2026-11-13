# Fork overlay — beliciobcardoso/OmniRoute

This fork tracks `cheaper-inference/OmniRoute` and adds only a small deployment overlay.
Everything fork-specific lives in **new files** so upstream merges never conflict:

| File | Purpose |
| --- | --- |
| `docker-compose.coolify.yaml` | Coolify Docker Compose resource (prod + dev) |
| `.fork/README.md` | This file — branch model, sync, Coolify runbook |

Do not edit upstream files on `prod`/`dev` unless unavoidable. If you must, make it one isolated
commit prefixed `fork:` so it is easy to find, drop or upstream later.

## Branch model

```
upstream/main ──ff──▶ main   (exact mirror — never commit here)
                        │ merge
                        ▼
                      prod   (main + overlay) ──▶ Coolify production
                        │ merge
                        ▼
                      dev    (prod + features under test) ──▶ Coolify development
                        ▲
                     feat/*
```

- Upstream only advances `main` on a stable release (one squash commit per release), so following
  `upstream/main` means following stable releases.
- Feature work: `feat/*` from `dev` → PR into `dev` → validate on the dev environment → PR
  `dev → prod`.

## Syncing with upstream

```bash
git fetch upstream main
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout prod && git merge main && git push origin prod   # overlay = new files → no conflicts
git checkout dev  && git merge prod && git push origin dev
```

A `--ff-only` failure on `main` means something was committed to it — move that commit to a
branch and reset `main` to `upstream/main`.

Upstream releases run SQLite migrations on boot. They are **forward-only**: back up the prod data
directory before deploying a new upstream version to prod.

## Coolify

One compose file, two environments. Per-environment settings (Coolify → app → Environment
Variables). Mark every secret **runtime-only** (uncheck "Build Variable"), otherwise Coolify passes
it as `--build-arg` and it ends up in the build log and image history.

| Variable | prod | dev |
| --- | --- | --- |
| `OMNIROUTE_HOST_DATA_DIR` | `/data/omniroute-prod` | `/data/omniroute-dev` |
| `JWT_SECRET` (`openssl rand -base64 48`) | own | own |
| `API_KEY_SECRET` (`openssl rand -hex 32`) | own | own |
| `OMNIROUTE_WS_BRIDGE_SECRET` | own | own |
| `INITIAL_PASSWORD` | own, strong | own |
| `REQUIRE_API_KEY` | default `true` | default `true` |

`API_KEY_SECRET` encrypts stored provider credentials: changing it on an existing data directory
makes those credentials unreadable. Never copy a data directory between environments without its
secrets.

App settings that live in Coolify, not in the repo:

| Setting | Value | Why |
| --- | --- | --- |
| Health check | enabled, path `/api/monitoring/health` | Off by default — Coolify reports a crash-looping app as healthy |
| `max_restart_count` | `0` (unlimited) or ≥ 100 | Default 10 turns a crash loop into a permanent outage |
| Memory limit | `0` unless the host is contended | A cgroup limit turns a heap spike into OOMKilled with no V8 trace |

### Data directory (host bind mount)

Create once per environment on the app host before the first deploy:

```bash
mkdir -p /data/omniroute-prod && chown -R 1000:1000 /data/omniroute-prod   # node user
```

Backup (app may stay up — `.backup` is WAL-safe):

```bash
sqlite3 /data/omniroute-prod/storage.sqlite ".backup '/backup/omniroute-$(date +%F).sqlite'"
```

### Crash-loop runbook

Do **not** redeploy first — a redeploy replaces the container and destroys the logs of the
crashing one.

```bash
docker logs --tail 400 $(docker ps -aqf name=omniroute) 2>&1 | tail -80
docker inspect $(docker ps -aqf name=omniroute) \
  --format 'exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}'
free -m; dmesg -T | grep -iE 'oom|killed process' | tail -20
docker restart $(docker ps -aqf name=omniroute)   # only now recover
```

| Signal | Cause |
| --- | --- |
| `oom=true` / `Killed process` in dmesg | Kernel/cgroup OOM — more host RAM or a higher limit |
| `FATAL ERROR: ... heap out of memory` | V8 ceiling — raise `OMNIROUTE_MEMORY_MB` (default 1024) |
| `Assertion failed: (env) != nullptr` + `Statement::~Statement` | better-sqlite3 GC finalizer abort (fixed upstream in 3.8.51, #14920) |

## Archived work

The PostgreSQL dual-dialect port (2026-08) is parked at branch/tag
`archive/postgres-dual-dialect` / `archive/postgres-dual-dialect-2026-11-12`. Upstream plans its own
Postgres backend (3.9 LTS / 4.0) with a different design; it never ran in production here.
