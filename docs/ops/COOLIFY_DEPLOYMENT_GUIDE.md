# Coolify Deployment Guide

Companion to [`docker-compose.coolify.yaml`](../../docker-compose.coolify.yaml). Covers the
Coolify-side settings that are **not** in the compose file, the state migration required by
the bind-mount change, and the crash-loop runbook.

## 1. Application settings (Coolify UI → the app → Configuration)

These live in Coolify's database, not in the repo, so they must be set once per application.

| Setting             | Value                                  | Why                                                                                                                                                                                   |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Health Check`      | **enabled**                            | Disabled by default. With it off, Coolify never notices the app is unhealthy and never notifies — an outage is discovered by a user hitting a dead endpoint.                          |
| Health Check Path   | `/api/monitoring/health`               | Same endpoint `scripts/dev/healthcheck.mjs` probes.                                                                                                                                   |
| `max_restart_count` | **≥ 100** (or `0`)                     | Default `10`. After 10 consecutive crashes Coolify stops restarting and the container stays `exited` **indefinitely** — a crash loop turns a transient fault into a permanent outage. |
| Memory limit        | leave `0` unless the host is contended | An explicit cgroup limit converts a heap spike into an `OOMKilled` with no V8 stack trace, which is strictly harder to debug.                                                         |

Reading the current values (read-only):

```bash
source ~/.config/coolify/env
curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "$COOLIFY_URL/api/v1/applications/$APP_UUID" \
  | jq '{status, health_check_enabled, health_check_path, max_restart_count, limits_memory}'
```

Coolify's own notification channels (email / Discord / Slack) are **instance-level**, under
Settings → Notifications. Enabling the health check without a notification channel gets you a
red dot in the dashboard and nothing else — configure both.

## 2. Restart without a rebuild

A full redeploy rebuilds the image and takes ~10 minutes. A restart takes ~20 seconds and is
what you almost always want during an incident:

```bash
source ~/.config/coolify/env
curl -s -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "$COOLIFY_URL/api/v1/applications/$APP_UUID/restart"
```

The response status is **stale** — the endpoint is async. Poll for the real state:

```bash
curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "$COOLIFY_URL/api/v1/applications/$APP_UUID" | jq -r .status
```

Require several consecutive `running:healthy` reads before calling it stable; a container that
boots and aborts flaps through `healthy` between crashes.

## 3. Crash-loop runbook

> **Do not redeploy first.** A deploy recreates the container, and `docker logs` for the dead
> container is destroyed with it — that is how a repeating crash stays undiagnosed across
> multiple outages. Capture the log, _then_ recover.

On the app's host (get it from `jq -r .destination.server.name` on the application endpoint —
it is often not the Coolify host):

```bash
# 1. Capture the evidence. `docker logs` survives restarts of the same
#    container, so this contains every crash in the loop.
docker logs --tail 400 $(docker ps -aqf name=omniroute) 2>&1 | tail -80

# 2. Classify the exit.
docker inspect $(docker ps -aqf name=omniroute) \
  --format 'exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}'

# 3. Rule out the host.
free -m; df -h /; dmesg -T | grep -iE 'oom|killed process' | tail -20

# 4. Only now recover.
docker restart $(docker ps -aqf name=omniroute)
```

Reading the exit:

| Signal                                              | Cause                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `oom=true`, or `Killed process` in `dmesg`          | Kernel/cgroup OOM. Raise the host RAM or the container limit.                 |
| `FATAL ERROR: ... heap out of memory` in the log    | V8 heap ceiling. Raise `OMNIROUTE_MEMORY_MB` (`Dockerfile`, default 1024).    |
| `exit=0` with `restarts=0` and a recent `StartedAt` | You are looking at a container the deploy just created. The evidence is gone. |

Counting restarts after the fact, when the container has already been replaced:

```bash
journalctl -u docker --since '3 days ago' --no-pager | grep -E 'sbJoin.*omniroute'
```

Each `sbJoin` line for the same endpoint name is the container rejoining the network — i.e. one
restart. A dense cluster of them followed by silence is a crash loop that exhausted
`max_restart_count`. Note that `healthcheck failed fatally: ... only one connection allowed` in
the same log is **BuildKit's** session health check during a build, not the application.

## 4. State lives on a host bind mount

`docker-compose.coolify.yaml` mounts `${OMNIROUTE_HOST_DATA_DIR:-/data/omniroute}` at
`/app/data` instead of using a Docker named volume.

Rationale: a crash-looping app leaves an `exited` container. If a cleanup pass (Coolify's
scheduled Docker cleanup, or a manual `docker system prune`) removes that container first, the
named volume it referenced becomes dangling, and the next prune deletes it. The app then boots
on an empty volume and looks perfectly healthy — with every API key, connection, and usage
record gone. `prune` never touches a bind mount.

Before the first deploy with this compose file, on the host:

```bash
mkdir -p /data/omniroute
chown -R 1000:1000 /data/omniroute   # `node` user, per Dockerfile `USER node`
```

### Migrating an existing deployment (⚠️ read before deploying)

An app already running on the named volume has its SQLite database inside it. Deploying this
change without copying the data first gives you a **fresh, empty database** — the old data is
still in the volume, but nothing reads it any more.

```bash
APP_UUID=<uuid>
docker volume ls | grep "$APP_UUID"          # find <APP_UUID>_omniroute-data

# Stop the app FIRST so no SQLite WAL write is in flight.
docker stop $(docker ps -aqf name=omniroute)

mkdir -p /data/omniroute
cp -a /var/lib/docker/volumes/${APP_UUID}_omniroute-data/_data/. /data/omniroute/
chown -R 1000:1000 /data/omniroute
ls -la /data/omniroute                        # expect omniroute.db + -wal + -shm
```

Then deploy. Keep the old volume around until you have confirmed the app came up with its data
intact — verify by logging in and checking that connections and API keys are present, not just
that the container is `healthy`.

Diagnostic for a suspected wipe: if **every** file in the data directory shares one recent
mtime, the directory was created then. The data that predates it is gone, not hidden.
