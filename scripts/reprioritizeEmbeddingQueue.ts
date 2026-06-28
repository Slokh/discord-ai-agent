import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const result = await pool.query(
      `
        UPDATE pgboss.job j
        SET priority = least(2147483647, greatest(0, floor(extract(epoch FROM m.created_at))::int))
        FROM messages m
        WHERE j.name = 'embedding.message'
          AND j.state IN ('created', 'retry')
          AND j.data->>'messageId' = m.id
          AND m.guild_id = $1
      `,
      [config.discord.guildId]
    );

    const states = await pool.query(
      `
        SELECT
          state,
          count(*)::int AS count,
          min(priority)::int AS min_priority,
          max(priority)::int AS max_priority
        FROM pgboss.job
        WHERE name = 'embedding.message'
        GROUP BY state
        ORDER BY state
      `
    );

    process.stdout.write(`reprioritized embedding jobs: ${result.rowCount ?? 0}\n`);
    for (const row of states.rows) {
      process.stdout.write(
        `${row.state}: count=${row.count}, min_priority=${row.min_priority ?? "n/a"}, max_priority=${row.max_priority ?? "n/a"}\n`
      );
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
