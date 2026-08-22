import test from "node:test";
import assert from "node:assert/strict";

import {
  createFile,
  getFile,
  getFileContent,
  listFiles,
  countFiles,
  deleteFile,
} from "../../../src/lib/db/files";
import {
  ensurePostgresBootstrap,
  getKyselyDb,
  resetKyselyDb,
} from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "files (postgres) create/get/content/list/count/delete",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const apiKeyId = `pg-key-${Date.now()}`;
    const fileIds: string[] = [];

    try {
      const fileA = await createFile({
        bytes: 11,
        filename: "pg-file-a.txt",
        purpose: "assistants",
        content: Buffer.from("hello file"),
        mimeType: "text/plain",
        apiKeyId,
      });
      fileIds.push(fileA.id);
      assert.ok(fileA.id);
      assert.equal(fileA.filename, "pg-file-a.txt");
      assert.equal(fileA.expiresAt, null);

      const batchFile = await createFile({
        bytes: 5,
        filename: "pg-file-batch.jsonl",
        purpose: "batch",
        content: Buffer.from("batch"),
        mimeType: "application/jsonl",
        apiKeyId,
      });
      fileIds.push(batchFile.id);
      assert.ok(batchFile.expiresAt && batchFile.expiresAt > Math.floor(Date.now() / 1000));

      const fetched = await getFile(fileA.id);
      assert.equal(fetched!.filename, "pg-file-a.txt");

      const content = await getFileContent(fileA.id);
      assert.equal(content!.toString(), "hello file");

      const listed = await listFiles({ apiKeyId, order: "desc", limit: 10 });
      assert.equal(listed.length, 2);
      assert.deepEqual(new Set(listed.map((f) => f.id)), new Set([fileA.id, batchFile.id]));

      const purposeFiltered = await listFiles({ apiKeyId, purpose: "batch" });
      assert.equal(purposeFiltered.length, 1);
      assert.equal(purposeFiltered[0].id, batchFile.id);

      const page1 = await listFiles({ apiKeyId, order: "desc", limit: 1 });
      assert.equal(page1.length, 1);
      const page2 = await listFiles({ apiKeyId, order: "desc", limit: 1, after: page1[0].id });
      assert.equal(page2.length, 1);
      assert.notEqual(page2[0].id, page1[0].id);
      assert.deepEqual(new Set([page1[0].id, page2[0].id]), new Set([fileA.id, batchFile.id]));

      const count = await countFiles({ apiKeyId });
      assert.equal(count, 2);

      const deleted = await deleteFile(fileA.id);
      assert.equal(deleted, true);
      assert.equal(await getFile(fileA.id), null);
      assert.equal(await getFileContent(fileA.id), null);

      const countAfterDelete = await countFiles({ apiKeyId });
      assert.equal(countAfterDelete, 1);
    } finally {
      for (const id of fileIds) {
        await getKyselyDb()
          .deleteFrom("files")
          .where("id", "=", id)
          .execute()
          .catch(() => {});
      }
      await resetKyselyDb();
    }
  }
);
