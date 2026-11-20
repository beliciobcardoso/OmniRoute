#!/usr/bin/env node
// scripts/check/check-postgres-boundary.mjs
// Persistence-boundary gate (docs/architecture/persistence-backend-boundary.md).
// Business code depends on repository contracts in src/domain/persistence/, never on a
// backend or dialect. Only the persistence layer itself may touch the Postgres backend:
//   - src/lib/db/postgres/**        client, dialect, generated schema, bootstrap
//   - src/lib/db/repositories/**    postgres*Repository impls + composition roots
//   - src/lib/db/driverConfig.ts    backend selection contract
// Anywhere else in src/ or open-sse/, importing kysely / pg / the postgres client /
// driverConfig, or branching on the backend (isPostgres), fails the gate.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCAN_ROOTS = ["src", "open-sse"];

export const ALLOWED_PREFIXES = [
  "src/lib/db/postgres/",
  "src/lib/db/repositories/",
  "src/lib/db/driverConfig.ts",
];

const FORBIDDEN = [
  { re: /from\s+["']kysely(?:\/[^"']*)?["']/, why: "imports kysely" },
  { re: /from\s+["']pg(?:\/[^"']*)?["']/, why: "imports pg" },
  // Matches both "@/lib/db/postgres/..." and sibling-relative "./postgres/..." specifiers.
  { re: /from\s+["'][^"']*(?:^|[/"'.])postgres\/[^"']*["']/, why: "imports the Postgres backend" },
  { re: /from\s+["'][^"']*(?:\/|\.)driverConfig(?:\.ts)?["']/, why: "imports driverConfig" },
  { re: /\bisPostgres\s*\(/, why: "branches on the persistence backend" },
];

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(c|m)?[jt]sx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function isAllowed(relPath) {
  return ALLOWED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

export function findViolations(relPath, source) {
  if (isAllowed(relPath)) return [];
  const code = stripComments(source);
  return FORBIDDEN.filter(({ re }) => re.test(code)).map(({ why }) => `${relPath}: ${why}`);
}

export function scan(cwd = process.cwd()) {
  const violations = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(cwd, root))) {
      const rel = path.relative(cwd, file).split(path.sep).join("/");
      violations.push(...findViolations(rel, fs.readFileSync(file, "utf8")));
    }
  }
  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const violations = scan();
  if (violations.length > 0) {
    console.error("❌ Persistence boundary violated (persistence-backend-boundary.md):");
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "Depend on a repository contract from src/domain/persistence/ instead; backend " +
        "selection belongs in a composition root under src/lib/db/repositories/."
    );
    process.exit(1);
  }
  console.log("✅ Postgres persistence boundary respected.");
}
