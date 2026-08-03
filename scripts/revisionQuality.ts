import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import {
  assessRevisionQuality,
  collectRevisionQuality,
  findBaselineRevision,
} from "../src/observability/revisionQuality.js";

const config = loadConfig();
const revision = argument("--revision") ?? config.appRevision;
const hours = boundedNumber(argument("--hours") ?? "48", 1, 168);
const pool = createPool(config);

try {
  const quality = await collectRevisionQuality(pool, revision, hours);
  const baselineRevision = process.argv.includes("--compare")
    ? await findBaselineRevision(pool, revision, hours)
    : null;
  const baseline = baselineRevision
    ? await collectRevisionQuality(pool, baselineRevision, hours)
    : null;
  const assessment = assessRevisionQuality(quality, baseline);
  process.stdout.write(`${JSON.stringify({
    ...quality,
    assessment,
    baseline: baseline ? { ...baseline, assessment: assessRevisionQuality(baseline) } : null,
  }, null, 2)}\n`);
  if (process.argv.includes("--enforce") && assessment.status === "fail") process.exitCode = 1;
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
