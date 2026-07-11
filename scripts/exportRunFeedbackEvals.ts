import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";

const outputPath = path.resolve(process.argv[2] ?? ".discord-ai-agent/evals/run-feedback.jsonl");
const pool = createPool(loadConfig());
try {
  const result = await pool.query(`
    SELECT f.run_id, f.rating, f.note, f.expected_behavior, f.updated_at,
           s.request, s.metadata->>'appRevision' AS app_revision,
           s.metadata->>'promptVersion' AS prompt_version,
           s.metadata->>'toolVersion' AS tool_version,
           s.metadata->>'configVersion' AS config_version
    FROM agent_run_feedback f
    LEFT JOIN agent_runtime_executions e ON e.execution_id = f.run_id
    LEFT JOIN agent_runtime_sessions s ON s.session_id = e.session_id
    WHERE f.capture_eval = true
    ORDER BY f.updated_at ASC
  `);
  const lines = result.rows.map((row) => JSON.stringify({
    id: String(row.run_id),
    input: String(row.request ?? ""),
    expectedBehavior: row.expected_behavior == null ? null : String(row.expected_behavior),
    reviewerNote: row.note == null ? null : String(row.note),
    rating: String(row.rating),
    revisions: {
      app: row.app_revision ?? null,
      prompt: row.prompt_version ?? null,
      tools: row.tool_version ?? null,
      config: row.config_version ?? null,
    },
    capturedAt: new Date(row.updated_at).toISOString(),
  }));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`, { mode: 0o600 });
  process.stdout.write(`Exported ${lines.length} private eval cases to ${outputPath}\n`);
} finally {
  await pool.end();
}
