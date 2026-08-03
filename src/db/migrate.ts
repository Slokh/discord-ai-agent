import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/env.js";
import { createPool } from "./pool.js";

export function resolveMigrationsDir(cwd = process.cwd()) {
  return path.join(cwd, "migrations");
}

export async function runMigrations(databaseUrl?: string) {
  const config = loadConfig();
  const pool = createPool({ ...config, databaseUrl: databaseUrl ?? config.databaseUrl });
  try {
    await runMigrationsWithPool(pool);
  } finally {
    await pool.end();
  }
}

export async function runMigrationsWithPool(pool: ReturnType<typeof createPool>, lockScope = "application") {
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`discord_ai_agent_schema_migrations:${lockScope}`]);
    lockAcquired = true;

    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("COMMIT");

    const migrationsDir = resolveMigrationsDir();
    const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (applied.rowCount && applied.rowCount > 0) continue;

      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      process.stdout.write(`Applied migration ${file}\n`);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (lockAcquired) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`discord_ai_agent_schema_migrations:${lockScope}`]).catch(() => undefined);
    }
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
