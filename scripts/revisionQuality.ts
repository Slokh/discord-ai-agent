import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { collectRevisionQuality } from "../src/observability/revisionQuality.js";

const config = loadConfig();
const revision = argument("--revision") ?? config.appRevision;
const hours = boundedNumber(argument("--hours") ?? "48", 1, 168);
const pool = createPool(config);

try {
  const quality = await collectRevisionQuality(pool, revision, hours);
  process.stdout.write(`${JSON.stringify(quality, null, 2)}\n`);
} finally {
  await pool.end();
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function boundedNumber(value: string, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got ${value}.`);
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
