import { sql } from "kysely";
import { getDbInstance } from "./core";
import { resolveDbDriverConfig } from "./driverConfig";
import { ensurePostgresBootstrap, getKyselyDb } from "./kysely/client";

type DbInstance = ReturnType<typeof getDbInstance>;

const ENCRYPTED_COLUMNS = ["api_key", "access_token", "refresh_token", "id_token"] as const;
const ENCRYPTED_PATTERN = "enc:v1:%";

function isPostgres(): boolean {
  return resolveDbDriverConfig().driver === "postgres";
}

function buildWhereClause(): string {
  return ENCRYPTED_COLUMNS.map((col) => `${col} LIKE '${ENCRYPTED_PATTERN}'`).join(" OR ");
}

async function countEncryptedCredentialsPg(): Promise<number> {
  await ensurePostgresBootstrap();
  const kdb = getKyselyDb();
  const where = buildWhereClause();
  const result = await sql<{
    cnt: string;
  }>`SELECT COUNT(*) AS cnt FROM provider_connections WHERE ${sql.raw(where)}`.execute(kdb);
  return Number(result.rows[0]?.cnt ?? 0);
}

export async function countEncryptedCredentials(db?: DbInstance): Promise<number> {
  if (!db && isPostgres()) {
    return countEncryptedCredentialsPg();
  }
  const activeDb = db ?? getDbInstance();
  const where = buildWhereClause();
  const row = activeDb
    .prepare(`SELECT COUNT(*) AS cnt FROM provider_connections WHERE ${where}`)
    .get() as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export async function resetEncryptedColumns(
  { dryRun }: { dryRun: boolean },
  db?: DbInstance
): Promise<{ affected: number }> {
  if (!db && isPostgres()) {
    const affected = await countEncryptedCredentialsPg();
    if (dryRun || affected === 0) return { affected };

    await ensurePostgresBootstrap();
    const kdb = getKyselyDb();
    const nullCols = ENCRYPTED_COLUMNS.map((col) => `${col} = NULL`).join(", ");
    const where = buildWhereClause();
    await sql`UPDATE provider_connections SET ${sql.raw(nullCols)} WHERE ${sql.raw(where)}`.execute(
      kdb
    );

    return { affected };
  }

  const activeDb = db ?? getDbInstance();
  const affected = await countEncryptedCredentials(activeDb);
  if (dryRun || affected === 0) return { affected };

  const nullCols = ENCRYPTED_COLUMNS.map((col) => `${col} = NULL`).join(", ");
  const where = buildWhereClause();
  activeDb.prepare(`UPDATE provider_connections SET ${nullCols} WHERE ${where}`).run();

  return { affected };
}
