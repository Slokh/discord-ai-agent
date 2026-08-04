import { loadConfig } from "../src/config/env.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { nativePollText } from "../src/discord/messagePersistence.js";
import { normalizeMessageContent } from "../src/memory/normalize.js";

const DEFAULT_LIMIT = 1_000;

async function main() {
  const config = loadConfig();
  const apply = process.argv.includes("--apply");
  const limit = positiveArgument("--limit") ?? DEFAULT_LIMIT;
  await runMigrations(config.databaseUrl);
  const pool = createPool(config);
  try {
    const result = await pool.query(
      `SELECT id, content, normalized_content, raw
       FROM messages
       WHERE deleted_at IS NULL AND raw ? 'poll'
       ORDER BY id
       LIMIT $1`,
      [limit],
    );
    let candidates = 0;
    let updated = 0;
    for (const row of result.rows) {
      const pollText = nativePollText((row.raw as Record<string, unknown> | null)?.poll);
      const normalized = normalizeMessageContent([String(row.content ?? ""), pollText].filter(Boolean).join("\n"));
      if (!pollText || normalized === row.normalized_content) continue;
      candidates += 1;
      if (!apply) continue;
      await pool.query("UPDATE messages SET normalized_content = $2, updated_at = now() WHERE id = $1", [row.id, normalized]);
      await pool.query("DELETE FROM message_embeddings WHERE message_id = $1", [row.id]);
      updated += 1;
    }
    process.stdout.write(`${apply ? "updated" : "would update"} ${apply ? updated : candidates} native poll message${(apply ? updated : candidates) === 1 ? "" : "s"}; scanned ${result.rows.length}.\n`);
    if (apply && updated > 0) process.stdout.write("Run npm run embeddings:backfill to queue replacement embeddings.\n");
  } finally {
    await pool.end();
  }
}

function positiveArgument(name: string) {
  const raw = process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

void main();
