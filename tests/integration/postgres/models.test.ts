import test from "node:test";
import assert from "node:assert/strict";

import {
  getCustomModels,
  getAllCustomModels,
  addCustomModel,
  replaceCustomModels,
  removeCustomModel,
  updateCustomModel,
  getSyncedAvailableModelsForConnection,
  getSyncedAvailableModels,
  getSyncedAvailableModelsByConnection,
  getAllSyncedAvailableModels,
  replaceSyncedAvailableModelsForConnection,
  removeSyncedAvailableModel,
  deleteSyncedAvailableModelsForConnection,
  deleteSyncedAvailableModelsForProvider,
  pruneStaleSyncedAvailableModelsForProvider,
  getModelAliases,
  setModelAlias,
  deleteModelAlias,
  getMitmAlias,
  setMitmAliasAll,
} from "../../../src/lib/db/models";
import {
  ensurePostgresBootstrap,
  resetKyselyDb,
  getKyselyDb,
} from "../../../src/lib/db/kysely/client";

/**
 * Requires a real Postgres 15+ reachable at DATABASE_URL — see
 * tests/integration/postgres/kysely-client.test.ts for how to run this
 * locally. Wired into CI as the `test-postgres-adapter` job.
 */
test(
  "models (postgres) customModels/syncedAvailableModels/aliases/mitmAlias lifecycle",
  { skip: !process.env.DATABASE_URL },
  async () => {
    process.env.DB_DRIVER = "postgres";
    await resetKyselyDb();
    await ensurePostgresBootstrap();

    const provider = "pg-models-provider";

    try {
      const created = await addCustomModel(provider, "model-a", "Model A");
      assert.equal(created.id, "model-a");

      const dedupAttempt = await addCustomModel(provider, "model-a", "Model A dup");
      assert.equal(dedupAttempt.id, "model-a");

      const list = await getCustomModels(provider);
      assert.equal(list.length, 1);

      const all = await getAllCustomModels();
      assert.ok(Array.isArray(all[provider]));

      const updated = await updateCustomModel(provider, "model-a", {
        modelName: "Model A renamed",
      });
      assert.equal(updated?.name, "Model A renamed");

      const replaced = await replaceCustomModels(provider, [
        { id: "model-a", name: "Model A", inputTokenLimit: 1000 },
        { id: "model-b", name: "Model B" },
      ]);
      assert.equal(replaced.length, 2);
      // preserved name persisted via updateCustomModel above must survive the merge
      const modelA = replaced.find((m) => m.id === "model-a") as Record<string, unknown>;
      assert.equal(modelA.inputTokenLimit, 1000);

      const removed = await removeCustomModel(provider, "model-b");
      assert.equal(removed, true);
      assert.equal((await getCustomModels(provider)).length, 1);

      // Synced available models (per-connection, provider-level union, cross-provider listing).
      const connA = "conn-a";
      const connB = "conn-b";
      await replaceSyncedAvailableModelsForConnection(provider, connA, [
        { id: "sync-1", name: "Sync One" },
      ] as never);
      await replaceSyncedAvailableModelsForConnection(provider, connB, [
        { id: "sync-2", name: "Sync Two" },
      ] as never);

      const forConnA = await getSyncedAvailableModelsForConnection(provider, connA);
      assert.equal(forConnA.length, 1);
      assert.equal(forConnA[0].id, "sync-1");

      const unioned = await getSyncedAvailableModels(provider);
      assert.equal(unioned.length, 2);

      const byConnection = await getSyncedAvailableModelsByConnection(provider);
      assert.equal(byConnection[connA]?.length, 1);
      assert.equal(byConnection[connB]?.length, 1);

      const allSynced = await getAllSyncedAvailableModels();
      assert.ok(Array.isArray(allSynced[provider]));

      const removedSync = await removeSyncedAvailableModel(provider, "sync-1");
      assert.equal(removedSync, true);
      assert.equal((await getSyncedAvailableModels(provider)).length, 1);

      // re-seed connA so prune below has something to remove
      await replaceSyncedAvailableModelsForConnection(provider, connA, [
        { id: "sync-1", name: "Sync One" },
      ] as never);
      const prunedCount = await pruneStaleSyncedAvailableModelsForProvider(provider, [connB]);
      assert.equal(prunedCount, 1);
      assert.equal(Object.keys(await getSyncedAvailableModelsByConnection(provider)).length, 1);

      const deletedCount = await deleteSyncedAvailableModelsForProvider(provider);
      assert.equal(deletedCount, 1);
      assert.equal((await getSyncedAvailableModels(provider)).length, 0);

      await replaceSyncedAvailableModelsForConnection(provider, connA, [
        { id: "sync-3", name: "Sync Three" },
      ] as never);
      await deleteSyncedAvailableModelsForConnection(provider, connA);
      assert.equal((await getSyncedAvailableModels(provider)).length, 0);

      // Model aliases + MITM alias round-trip.
      await setModelAlias("pg-alias", `${provider}/model-a`);
      const aliases = await getModelAliases();
      assert.equal(aliases["pg-alias"], `${provider}/model-a`);
      await deleteModelAlias("pg-alias");
      assert.equal((await getModelAliases())["pg-alias"], undefined);

      await setMitmAliasAll("pg-tool", { "old-name": "new-name" });
      const mitm = await getMitmAlias("pg-tool");
      assert.deepEqual(mitm, { "old-name": "new-name" });
    } finally {
      const kdb = getKyselyDb();
      await kdb
        .deleteFrom("key_value")
        .where("namespace", "in", ["customModels", "syncedAvailableModels"])
        .where("key", "like", `${provider}%`)
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("key_value")
        .where("namespace", "=", "modelAliases")
        .where("key", "=", "pg-alias")
        .execute()
        .catch(() => {});
      await kdb
        .deleteFrom("key_value")
        .where("namespace", "=", "mitmAlias")
        .where("key", "=", "pg-tool")
        .execute()
        .catch(() => {});
      await resetKyselyDb();
    }
  }
);
