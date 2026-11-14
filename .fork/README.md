# Fork overlay — beliciobcardoso/OmniRoute

This fork tracks `cheaper-inference/OmniRoute` and adds only a small deployment overlay.
Everything fork-specific lives in **new files** so upstream merges never conflict:

| File | Purpose |
| --- | --- |
| `docker-compose.coolify.yaml` | Coolify Docker Compose — production (`/data/omniroute`) |
| `docker-compose.coolify.dev.yaml` | Development twin — differs only in the data dir (`/data/omniroute-dev`) |
| `tests/unit/fork-coolify-compose.test.ts` | Guards that the two compose files only differ in the data dir, and the backup service contract |
| `.fork/README.md` | This file — branch model, sync, Coolify runbook |

Do not edit upstream files on `prod`/`dev` unless unavoidable. If you must, make it one isolated
commit prefixed `fork:` so it is easy to find, drop or upstream later.

## Branch model

```
upstream/main ──ff──▶ main   (exact mirror — never commit here)
                        │ merge
                        ▼
          feat/* ──▶  dev    (integration + test) ──▶ Coolify development
                        │ PR dev → prod, merged by fast-forward
                        ▼
                      prod   (only commits already deployed on dev) ──▶ Coolify production
```

- Upstream only advances `main` on a stable release (one squash commit per release), so following
  `upstream/main` means following stable releases.
- **Nothing reaches `prod` without passing through `dev` first** — not features, not upstream
  updates, not hotfixes. `prod` only ever moves to a commit that is already on `dev` and was
  deployed and validated on the dev environment.
- No registry: each Coolify app builds from its own branch. Fast-forwarding `prod` to the tested
  `dev` commit means prod builds the **same commit SHA** (same tree, same `package-lock.json`), so
  the code is identical; the only drift left is base-image tags resolved at build time.

### Promote dev → prod

1. Open a PR `dev → prod` (records what is being promoted; review the diff there).
2. Merge it by **fast-forward**, not with the GitHub button — "Create a merge commit" adds a
   commit prod has and dev does not, and "Rebase"/"Squash" rewrite SHAs, so prod would no longer
   run the exact commit tested on dev:

   ```bash
   git fetch origin
   git merge-base --is-ancestor origin/prod origin/dev   # must succeed (prod never ahead of dev)
   git push origin <tested-sha>:prod                      # usually origin/dev; GitHub marks the PR merged
   ```

   Push the SHA that was actually deployed on dev, not a newer `dev` tip that was not tested.

### Syncing with upstream

```bash
git fetch upstream main
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout dev  && git merge main && git push origin dev    # overlay = new files → no conflicts
# validate on the dev environment, then promote dev → prod as above
```

A `--ff-only` failure on `main` means something was committed to it — move that commit to a
branch and reset `main` to `upstream/main`. A failure of the `is-ancestor` check means something
was committed straight to `prod` — merge `prod` into `dev`, test, then promote.

Upstream releases run SQLite migrations on boot. They are **forward-only**: back up the prod data
directory before deploying a new upstream version to prod.

## Coolify

One compose file per environment (the data dir is a literal path: Coolify does not substitute app
env vars into volume sources — `${VAR:-/x}` always resolves to `/x` and a bare `${VAR}` silently
becomes a fresh named volume). Per-environment settings (Coolify → app → Environment
Variables). Mark every secret **runtime-only** (uncheck "Build Variable"), otherwise Coolify passes
it as `--build-arg` and it ends up in the build log and image history.

| Variable | prod | dev |
| --- | --- | --- |
| Docker Compose Location (app setting) | `/docker-compose.coolify.yaml` | `/docker-compose.coolify.dev.yaml` |
| `JWT_SECRET` (`openssl rand -base64 48`) | own | own |
| `API_KEY_SECRET` (`openssl rand -hex 32`) | own | own |
| `OMNIROUTE_WS_BRIDGE_SECRET` | own | own |
| `INITIAL_PASSWORD` | own, strong | own |
| `REQUIRE_API_KEY` | default `true` | default `true` |
| `BACKUP_R2_ENDPOINT` (host only, no `https://`) | R2 endpoint | same |
| `BACKUP_R2_BUCKET` | backup bucket | same |
| `BACKUP_S3_PATH` | `omniroute/prod` | `omniroute/dev` |
| `BACKUP_R2_ACCESS_KEY_ID` / `BACKUP_R2_SECRET_ACCESS_KEY` | R2 token with write on the bucket | same |
| `BACKUP_GPG_PASSPHRASE` | own, strong — also keep it **outside** the server | own |

Stored provider credentials are encrypted with `STORAGE_ENCRYPTION_KEY`, which the app generates
on first boot and persists in `<data dir>/server.env`. A database restored without that file loses
every provider credential (decryption fails, all connections need re-auth). Never copy a data
directory — or restore a backup — without its `server.env`.

App settings that live in Coolify, not in the repo:

| Setting | Value | Why |
| --- | --- | --- |
| Health check | enabled, path `/api/monitoring/health` | Off by default — Coolify reports a crash-looping app as healthy |
| `max_restart_count` | `0` (unlimited) or ≥ 100 | Default 10 turns a crash loop into a permanent outage |
| Memory limit | `0` unless the host is contended | A cgroup limit turns a heap spike into OOMKilled with no V8 trace |

### Data directory (host bind mount)

No host setup needed: Docker creates the directory on first deploy and the `data-init` service
creates `offsite/` and chowns everything to the `node` user (UID 1000) before the app starts.

### Backup (daily, encrypted, offsite)

Two halves, because a consistent SQLite copy must come from inside the app container while the
upload must not need a Docker socket:

1. **03:00 — snapshot** (Coolify → app → Scheduled Tasks, container `omniroute`, frequency
   `0 3 * * *`): online backup API → `offsite/omniroute-YYYY-MM-DD.sqlite` (single file: `journal_mode=DELETE`,
   + `integrity_check`),
   copies `server.env`, keeps the last 2 snapshots. Command:

   ```sh
   cd /app && node -e 'const D=require("better-sqlite3"),fs=require("fs"),dir="/app/data/offsite",out=dir+"/omniroute-"+new Date().toISOString().slice(0,10)+".sqlite";fs.mkdirSync(dir,{recursive:true});const db=new D("/app/data/storage.sqlite",{readonly:true,fileMustExist:true});db.backup(out).then(()=>{db.close();const c=new D(out);c.pragma("journal_mode = DELETE");const r=c.pragma("integrity_check",{simple:true});c.close();if(r!=="ok")throw new Error("integrity_check: "+r);fs.copyFileSync("/app/data/server.env",dir+"/server.env");fs.chmodSync(dir+"/server.env",0o600);for(const f of fs.readdirSync(dir).filter(f=>/^omniroute-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().slice(0,-2))for(const x of ["","-wal","-shm"])fs.rmSync(dir+"/"+f+x,{force:true});console.log("snapshot ok",out,fs.statSync(out).size)}).catch(e=>{console.error("snapshot failed:",e.message);process.exit(1)})'
   ```

2. **03:30 — upload** (`backup` service in the compose): tars `offsite/`, encrypts it with GPG
   (`BACKUP_GPG_PASSPHRASE`) and uploads to `s3://$BACKUP_R2_BUCKET/$BACKUP_S3_PATH/`, pruning
   archives older than 14 days.

A failed snapshot does not stop the upload — it re-ships the previous day's files. Watch the
scheduled task's executions (or a Coolify notification) so a stale backup does not go unnoticed.

Restore:

```bash
gpg --decrypt omniroute-<timestamp>.tar.gz.gpg | tar -xz     # → backup/omniroute/…
sqlite3 backup/omniroute/omniroute-<date>.sqlite "PRAGMA integrity_check"
```

Then stop the app and put **both** files back into the data dir (`storage.sqlite`, `server.env`;
delete any stale `storage.sqlite-wal`/`-shm`), or import the `.sqlite` from the dashboard
(Settings → Database) and restore `server.env` by hand before restarting.

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
