import type {
  ComboRepository,
  ModelComboMappingRepository,
} from "@/domain/persistence/comboRepositories";
import { resolveDbDriverConfig, type DbDriver } from "../driverConfig";
import type { ComboImportBatchResult } from "./comboDependents";
import { importPostgresComboBatch, postgresComboRepository } from "./postgresComboRepository";
import { postgresModelComboMappingRepository } from "./postgresModelComboMappingRepository";
import { importComboBatch, sqliteComboRepository } from "./sqliteComboRepository";
import { sqliteModelComboMappingRepository } from "./sqliteModelComboMappingRepository";

export interface RoutingConfigRepositories {
  combos: ComboRepository;
  modelComboMappings: ModelComboMappingRepository;
  /**
   * Atomic combos-only import. Kept beside the portable repository surface
   * because its side effects (LKGP keys, revoked grants) are reported back to
   * the compatibility facade for cache invalidation.
   */
  comboImport: {
    importBatch(
      entries: Record<string, unknown>[],
      options: { replaceVisible: boolean }
    ): Promise<ComboImportBatchResult>;
  };
}

const sqliteRoutingConfigRepositories: RoutingConfigRepositories = {
  combos: sqliteComboRepository,
  modelComboMappings: sqliteModelComboMappingRepository,
  comboImport: {
    importBatch: async (entries, options) => importComboBatch(entries, options),
  },
};

const postgresRoutingConfigRepositories: RoutingConfigRepositories = {
  combos: postgresComboRepository,
  modelComboMappings: postgresModelComboMappingRepository,
  comboImport: { importBatch: importPostgresComboBatch },
};

/**
 * Composition root for the routing-config repository slice. The backend is
 * chosen once, here, from DB_DRIVER; compatibility facades and business code
 * never see a concrete driver (docs/architecture/persistence-backend-boundary.md).
 */
export function selectRoutingConfigRepositories(
  driver: DbDriver = resolveDbDriverConfig().driver
): RoutingConfigRepositories {
  return driver === "postgres"
    ? postgresRoutingConfigRepositories
    : sqliteRoutingConfigRepositories;
}

export const routingConfigRepositories: RoutingConfigRepositories =
  selectRoutingConfigRepositories();
