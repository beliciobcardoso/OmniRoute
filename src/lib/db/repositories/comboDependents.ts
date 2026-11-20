/**
 * State owned by a combo that lives OUTSIDE the combos table: proxy
 * assignments and the rotation cursor (proxies domain) and last-known-good
 * provider rows (settings/lkgp). API key grants are revoked separately by
 * `revokeComboGrantsByName`, because an import must only revoke names it did
 * not bring back.
 *
 * Those domains are still SQLite-only, so this always runs against the SQLite
 * handle:
 * - SQLite combo repository: inside the same transaction as the combo DELETE.
 * - Postgres combo repository: in its own SQLite transaction after the Postgres
 *   commit — not atomic across the two stores (partial backend, see
 *   src/lib/db/driverConfig.ts). Move it next to the combo write once these
 *   domains are ported.
 */

import type { getDbInstance } from "../core";
import { clearRotationState } from "../proxies/rotation";
import { bumpProxyRegistryGeneration } from "../proxies/registryGeneration";
import { deleteLKGPRowsByComboName } from "../settings/lkgp";

type Db = ReturnType<typeof getDbInstance>;

export interface ComboImportBatchResult {
  created: Record<string, unknown>[];
  removed: number;
  lkgpKeys: string[];
  revokedKeys: number;
}

export interface ComboOwnedStatePurge {
  purged: number;
  lkgpKeys: string[];
}

/**
 * Purge the combo's proxy assignments and rotation cursor with the combo row
 * (#14553, same shape as the account-scope purge in providers/deletion.ts for
 * #9232): orphaned proxy_assignments rows would keep answering for a scope_id
 * that no longer exists.
 */
export function purgeComboOwnedState(
  db: Db,
  comboId: string,
  comboName?: string
): ComboOwnedStatePurge {
  const purged = db
    .prepare("DELETE FROM proxy_assignments WHERE scope = 'combo' AND scope_id IS ?")
    .run(comboId).changes;
  clearRotationState(db, "combo", comboId);
  return {
    purged,
    lkgpKeys: comboName ? deleteLKGPRowsByComboName(comboName) : [],
  };
}

/** Cache and generation effects after a combo delete commits (both backends). */
export async function applyComboDeletionEffects(outcome: {
  lkgpKeys: string[];
  purged: number;
  revokedKeys: number;
}): Promise<void> {
  if (outcome.revokedKeys > 0) {
    const { clearApiKeyCaches } = await import("../apiKeys");
    const { invalidateModelCatalogCache } = await import("../readCache");
    clearApiKeyCaches();
    invalidateModelCatalogCache();
  }

  if (outcome.purged > 0) {
    bumpProxyRegistryGeneration();
  }

  if (outcome.lkgpKeys.length > 0) {
    const { invalidateCachedLKGP } = await import("../readCache");
    for (const key of outcome.lkgpKeys) {
      invalidateCachedLKGP(key);
    }
  }
}
