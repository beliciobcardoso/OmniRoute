import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Fork overlay: prod and dev Coolify compose files must differ only in the
// host data dir. Coolify does not substitute app env vars into volume
// sources, so the path is a literal per file — and a drift anywhere else
// would mean dev no longer tests what prod runs.
const prod = readFileSync("docker-compose.coolify.yaml", "utf8");
const dev = readFileSync("docker-compose.coolify.dev.yaml", "utf8");

// Every host path under the data dir: the dir itself and its subdirs
// (e.g. the offsite backup staging dir).
const HOST_DATA = /^(\s*- )\/data\/omniroute(-dev)?(?=[:/])/gm;

test("prod mounts /data/omniroute and dev mounts /data/omniroute-dev", () => {
  const prodMounts = [...prod.matchAll(HOST_DATA)];
  const devMounts = [...dev.matchAll(HOST_DATA)];
  assert.ok(prodMounts.length >= 1);
  assert.ok(prodMounts.every((m) => m[2] === undefined));
  assert.equal(devMounts.length, prodMounts.length);
  assert.ok(devMounts.every((m) => m[2] === "-dev"));
});

test("dev compose is the prod compose with only the data dir swapped", () => {
  const normalize = (s: string) => s.replace(HOST_DATA, "$1<DATA_DIR>");
  assert.equal(normalize(dev), normalize(prod));
});

test("no volume source relies on env substitution", () => {
  // `${VAR}` becomes a named volume and `${VAR:-/x}` always resolves to /x
  // under Coolify, so either form silently points at the wrong data.
  for (const file of [prod, dev]) {
    assert.doesNotMatch(file, /^\s*- \$\{[^}]+\}:\//m);
  }
});

test("offsite backup ships only the staging dir, encrypted, to a required target", () => {
  const block = prod.match(/^ {2}backup:\n(?: {4}.*\n|\n)+/m)?.[0] ?? "";
  assert.ok(block, "backup service missing");
  // Pinned image: a floating tag could change env names under us.
  assert.match(block, /image: offen\/docker-volume-backup:v\d+\.\d+\.\d+\n/);
  // Read-only, and only the snapshot staging dir — never the live SQLite
  // files, which a tar of a running WAL database would corrupt.
  assert.match(block, /^ {6}- \/data\/omniroute\/offsite:\/backup\/omniroute:ro$/m);
  assert.doesNotMatch(block, /^ {6}- \/data\/omniroute:/m);
  // The archive carries server.env (STORAGE_ENCRYPTION_KEY): encryption and
  // credentials are mandatory, so a missing value fails the deploy.
  for (const key of [
    "GPG_PASSPHRASE=${BACKUP_GPG_PASSPHRASE:?}",
    "AWS_ACCESS_KEY_ID=${BACKUP_R2_ACCESS_KEY_ID:?}",
    "AWS_SECRET_ACCESS_KEY=${BACKUP_R2_SECRET_ACCESS_KEY:?}",
    "AWS_ENDPOINT=${BACKUP_R2_ENDPOINT:?}",
    "AWS_S3_BUCKET_NAME=${BACKUP_R2_BUCKET:?}",
    "AWS_S3_PATH=${BACKUP_S3_PATH:?}",
  ]) {
    assert.ok(block.includes(`- ${key}`), `backup env missing ${key}`);
  }
  assert.doesNotMatch(block, /docker\.sock/);
});

test("data-init pre-creates the offsite dir and writes the snapshot script", () => {
  const block = prod.match(/^ {2}data-init:\n(?: {4}.*\n|\n)+/m)?.[0] ?? "";
  assert.match(block, /mkdir -p \/app\/data\/offsite\n/);
  // Ownership fix runs last, after every file data-init writes.
  assert.match(block, /chown -R 1000:1000 \/app\/data\n(?! {8}\S)/);
  // The scheduled task runs this file; Coolify caps a task command at 255 chars.
  assert.match(block, /cat > \/app\/data\/\.fork-snapshot\.cjs <<'EOF'\n/);
  const script = block.match(/<<'EOF'\n([\s\S]*?)\n {8}EOF\n/)?.[1] ?? "";
  assert.ok(script.includes("db.backup(out)"), "snapshot must use the online backup API");
  assert.ok(script.includes('"journal_mode = DELETE"'));
  assert.ok(script.includes('"/app/data/server.env"'), "server.env must ship with the snapshot");
  // A `$` would be interpolated by compose and silently corrupt the script.
  assert.doesNotMatch(script, /\$/);
});
