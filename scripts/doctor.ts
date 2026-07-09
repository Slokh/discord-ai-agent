import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { parseGitHubRepository } from "../src/github/repository.js";

async function main() {
  const config = loadConfig();
  const checks: Array<[string, boolean, string]> = [];

  checks.push(["Discord token", Boolean(config.discord.token), "required to log in the bot"]);
  checks.push(["Discord client ID", Boolean(config.discord.clientId), "configured for the Discord bot application"]);
  checks.push(["Discord guild ID", Boolean(config.discord.guildId), "configured for the target Discord server"]);
  checks.push(["OpenRouter API key", Boolean(config.openRouter.apiKey), "required for chat, embeddings, and images"]);
  checks.push([
    "GitHub task credential",
    Boolean(config.github.token || (config.github.appId && config.github.appPrivateKey && config.github.appInstallationId)),
    "required for sandbox code-update PRs"
  ]);
  checks.push(["Task signing secret", Boolean(config.execution.taskSigningSecret), "required for Kubernetes sandbox callbacks"]);
  const githubRepository = checkGitHubRepository(config.github.repository);
  checks.push(["GitHub repository", githubRepository.ok, githubRepository.detail]);

  const pool = createPool(config);
  try {
    await pool.query("SELECT 1");
    checks.push(["database", true, "connected"]);

    const expectedTables = [
      "schema_migrations",
      "guilds",
      "discord_users",
      "channels",
      "messages",
      "attachments",
      "message_embeddings",
      "crawl_cursors",
      "privacy_deletions",
      "interaction_blocks",
      "tool_audit_logs",
      "trace_events",
      "skills",
      "skill_changes",
      "agent_tasks",
      "sandbox_runs",
      "sandbox_command_events",
      "agent_runtime_sessions",
      "agent_runtime_executions",
      "agent_runtime_events"
    ];
    const tables = await pool.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
      `,
      [expectedTables]
    );
    checks.push([
      "migrations",
      tables.rowCount === expectedTables.length,
      `${tables.rowCount ?? 0}/${expectedTables.length} expected tables found`
    ]);

    const vectorType = await pool.query(
      `
        SELECT format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'message_embeddings'
          AND a.attname = 'embedding'
          AND a.attnum > 0
          AND NOT a.attisdropped
      `
    );
    const expectedVectorType = `vector(${config.embeddingDimensions})`;
    checks.push([
      "embedding_dimensions",
      vectorType.rows[0]?.type === expectedVectorType,
      `database=${vectorType.rows[0]?.type ?? "missing"}, env=${expectedVectorType}`
    ]);
  } catch (error) {
    checks.push(["database", false, error instanceof Error ? error.message : String(error)]);
  } finally {
    await pool.end().catch(() => undefined);
  }

  for (const [name, ok, detail] of checks) {
    process.stdout.write(`${ok ? "ok" : "missing"} ${name}: ${detail}\n`);
  }

  const failed = checks.some(([, ok]) => !ok);
  if (failed) process.exitCode = 1;
}

function checkGitHubRepository(repository: string | undefined) {
  try {
    parseGitHubRepository(repository);
    return { ok: true, detail: "real owner/repo configured" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
