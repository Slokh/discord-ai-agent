import pg from "pg";
import type { AppConfig } from "../config/env.js";

export type DbPool = pg.Pool;

export function createPool(config: AppConfig): DbPool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10
  });
}
