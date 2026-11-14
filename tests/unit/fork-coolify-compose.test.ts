import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Fork overlay: prod and dev Coolify compose files must differ only in the
// host data dir. Coolify does not substitute app env vars into volume
// sources, so the path is a literal per file — and a drift anywhere else
// would mean dev no longer tests what prod runs.
const prod = readFileSync("docker-compose.coolify.yaml", "utf8");
const dev = readFileSync("docker-compose.coolify.dev.yaml", "utf8");

const DATA_MOUNT = /^(\s*- )\/data\/omniroute(-dev)?:\/app\/data$/gm;

test("prod mounts /data/omniroute and dev mounts /data/omniroute-dev", () => {
  const prodMounts = [...prod.matchAll(DATA_MOUNT)].map((m) => m[0].trim());
  const devMounts = [...dev.matchAll(DATA_MOUNT)].map((m) => m[0].trim());
  assert.ok(prodMounts.length >= 1);
  assert.ok(prodMounts.every((m) => m === "- /data/omniroute:/app/data"));
  assert.equal(devMounts.length, prodMounts.length);
  assert.ok(devMounts.every((m) => m === "- /data/omniroute-dev:/app/data"));
});

test("dev compose is the prod compose with only the data dir swapped", () => {
  const normalize = (s: string) => s.replace(DATA_MOUNT, "$1<DATA_DIR>:/app/data");
  assert.equal(normalize(dev), normalize(prod));
});

test("no volume source relies on env substitution", () => {
  // `${VAR}` becomes a named volume and `${VAR:-/x}` always resolves to /x
  // under Coolify, so either form silently points at the wrong data.
  for (const file of [prod, dev]) {
    assert.doesNotMatch(file, /^\s*- \$\{[^}]+\}:\//m);
  }
});
