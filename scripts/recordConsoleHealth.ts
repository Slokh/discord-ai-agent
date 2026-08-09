import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { createAppDatabase } from "../src/db/repositories.js";

const values = argumentsMap(process.argv.slice(2));
const config = loadConfig();
const revision = required(values, "revision");
if (revision !== config.appRevision) throw new Error("Console health evidence must target the running application revision.");
const status = required(values, "status");
if (!new Set(["started", "succeeded", "failed"]).has(status)) throw new Error("--status must be started, succeeded, or failed.");
const pool = createPool(config);
const repo = createAppDatabase(pool);

try {
  const run = await repo.recordImprovementProofProducerRun({
    trigger: "console_health",
    runKey: required(values, "run-key"),
    status: status as "started" | "succeeded" | "failed",
    revision,
    outcomeCode: values.get("outcome-code") ?? (status === "succeeded" ? "healthy" : status === "failed" ? "check_failed" : null),
  });
  process.stdout.write(`${JSON.stringify({ trigger: run.trigger, runKey: run.runKey, status: run.status, revision: run.revision, outcomeCode: run.outcomeCode })}\n`);
} finally {
  await pool.end();
}

function argumentsMap(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[++index];
    if (!name || !value) throw new Error(`Missing value for --${name || arg}`);
    values.set(name, value);
  }
  return values;
}

function required(values: Map<string, string>, name: string) {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}
