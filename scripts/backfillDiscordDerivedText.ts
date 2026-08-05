import { loadConfig } from "../src/config/env.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { indexableStoredMessageText } from "../src/discord/messagePersistence.js";
import { normalizeMessageContent } from "../src/memory/normalize.js";

const DEFAULT_BATCH_SIZE = 500;

async function main() {
  const config = loadConfig();
  const apply = process.argv.includes("--apply");
  const limit = positiveArgument("--limit");
  const batchSize = positiveArgument("--batch-size") ?? DEFAULT_BATCH_SIZE;
  await runMigrations(config.databaseUrl);
  const pool = createPool(config);
  let afterId = "";
  let scanned = 0;
  let candidates = 0;
  let updated = 0;

  try {
    while (limit == null || scanned < limit) {
      const requested = Math.min(batchSize, limit == null ? batchSize : limit - scanned);
      const result = await pool.query(
        `SELECT id, content, normalized_content, raw
         FROM messages
         WHERE deleted_at IS NULL
           AND id > $1
           AND (
             jsonb_typeof(raw -> 'poll') = 'object'
             OR CASE
               WHEN jsonb_typeof(raw -> 'embeds') = 'array'
                 THEN jsonb_array_length(raw -> 'embeds') > 0
               ELSE false
             END
           )
         ORDER BY id
         LIMIT $2`,
        [afterId, requested],
      );
      if (result.rows.length === 0) break;

      for (const row of result.rows) {
        const normalized = normalizeMessageContent(indexableStoredMessageText(row.content, row.raw));
        if (normalized === row.normalized_content) continue;
        candidates += 1;
        if (!apply) continue;
        const update = await pool.query(
          `WITH changed AS (
             UPDATE messages
             SET normalized_content = $2, updated_at = now()
             WHERE id = $1
               AND normalized_content IS NOT DISTINCT FROM $3
             RETURNING id
           ), removed_embedding AS (
             DELETE FROM message_embeddings
             WHERE message_id IN (SELECT id FROM changed)
           )
           SELECT id FROM changed`,
          [row.id, normalized, row.normalized_content],
        );
        updated += update.rows.length;
      }

      scanned += result.rows.length;
      afterId = String(result.rows.at(-1)?.id ?? afterId);
      if (result.rows.length < requested) break;
    }

    const changed = apply ? updated : candidates;
    process.stdout.write(`${apply ? "updated" : "would update"} ${changed} Discord message${changed === 1 ? "" : "s"}; scanned ${scanned}.\n`);
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
