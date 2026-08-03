import { randomUUID } from "node:crypto";
import type { AppConfig } from "../../src/config/env.js";
import { loadConfig } from "../../src/config/env.js";
import { runMigrationsWithPool } from "../../src/db/migrate.js";
import { createPool, type DbPool } from "../../src/db/pool.js";

export type IsolatedTestDatabase = {
  config: AppConfig;
  pool: DbPool;
  schema: string;
  cleanup: () => Promise<void>;
};

/** Gives one integration-test file its own migrated application schema. */
export async function createIsolatedTestDatabase(label: string): Promise<IsolatedTestDatabase> {
  const baseConfig = loadConfig();
  const schema = `test_${safeIdentifier(label)}_${randomUUID().replaceAll("-", "")}`;
  const admin = createPool(baseConfig);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const databaseUrl = databaseUrlWithSearchPath(baseConfig.databaseUrl, schema);
  const config = { ...baseConfig, databaseUrl };
  const pool = createPool(config);
  try {
    await runMigrationsWithPool(pool, schema);
  } catch (error) {
    await pool.end().catch(() => undefined);
    const cleanupPool = createPool(baseConfig);
    await cleanupPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).finally(() => cleanupPool.end());
    throw error;
  }

  return {
    config,
    pool,
    schema,
    cleanup: async () => {
      await pool.end();
      const cleanupPool = createPool(baseConfig);
      try {
        await cleanupPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await cleanupPool.end();
      }
    },
  };
}

function databaseUrlWithSearchPath(databaseUrl: string, schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

function safeIdentifier(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 24) || "db";
}
