import { loadConfig } from "../src/config/env.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool, type DbPool } from "../src/db/pool.js";
import { DiscordAiAgentRepository, type DiscordUserLookupResult } from "../src/db/repositories.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const config = loadConfig();
  await runMigrations(config.databaseUrl);
  const pool = createPool(config);
  const repo = new DiscordAiAgentRepository(pool);
  try {
    if (command === "list") {
      const query = args.slice(1).join(" ");
      const aliases = await repo.listDiscordUserAliases({ guildId: config.discord.guildId, query, limit: 500 });
      if (aliases.length === 0) {
        process.stdout.write("No aliases found.\n");
        return;
      }
      for (const alias of aliases) {
        process.stdout.write(`${formatAliasUser(alias)} <= ${alias.alias}\n`);
      }
      return;
    }

    if (command === "resolve") {
      const query = requiredText(args.slice(1), "resolve requires a user query.");
      const matches = await findUsers(pool, repo, config.discord.guildId, query, 10);
      printUserMatches(matches);
      return;
    }

    if (command === "add") {
      const userQuery = args[1];
      const aliases = args.slice(2).map((alias) => alias.trim()).filter(Boolean);
      if (!userQuery || aliases.length === 0) {
        throw new Error("add requires a user query/id and at least one alias.");
      }
      const user = await resolveSingleUser(pool, repo, config.discord.guildId, userQuery);
      for (const alias of aliases) {
        await repo.upsertDiscordUserAlias({ guildId: config.discord.guildId, userId: user.id, alias });
        process.stdout.write(`added alias: ${formatUser(user)} <= ${alias}\n`);
      }
      return;
    }

    if (command === "remove" || command === "rm") {
      const alias = requiredText(args.slice(1), "remove requires an alias.");
      const deleted = await repo.deleteDiscordUserAlias({ guildId: config.discord.guildId, alias });
      process.stdout.write(deleted > 0 ? `removed alias: ${alias}\n` : `alias not found: ${alias}\n`);
      return;
    }

    if (command === "top") {
      const limit = Number(args[1] ?? 30);
      const users = await findUsers(pool, repo, config.discord.guildId, "", Number.isFinite(limit) ? limit : 30);
      printUserMatches(users);
      return;
    }

    throw new Error(`Unknown aliases command: ${command}`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function findUsers(pool: DbPool, repo: DiscordAiAgentRepository, guildId: string, query: string, limit: number) {
  const visibleChannelIds = await allIndexedChannelIds(pool, guildId);
  return repo.findDiscordUsers({ guildId, visibleChannelIds, query, limit });
}

async function resolveSingleUser(pool: DbPool, repo: DiscordAiAgentRepository, guildId: string, query: string) {
  const matches = await findUsers(pool, repo, guildId, query, 5);
  if (matches.length === 0) throw new Error(`No indexed Discord user matched: ${query}`);
  const exact = matches.find((match) => match.id === query || match.username?.toLowerCase() === query.toLowerCase());
  const picked = exact ?? matches[0]!;
  if (!exact && matches.length > 1 && picked.score < 85) {
    process.stderr.write("Multiple possible users matched; picked the highest score:\n");
    printUserMatches(matches);
  }
  return picked;
}

async function allIndexedChannelIds(pool: DbPool, guildId: string) {
  const result = await pool.query(
    `
      SELECT c.id
      FROM channels c
      LEFT JOIN channels parent ON parent.id = c.parent_id
      WHERE c.guild_id = $1
        AND c.is_excluded = false
        AND coalesce(parent.is_excluded, false) = false
    `,
    [guildId]
  );
  return result.rows.map((row) => String(row.id));
}

function printUserMatches(matches: DiscordUserLookupResult[]) {
  if (matches.length === 0) {
    process.stdout.write("No users matched.\n");
    return;
  }
  for (const match of matches) {
    const aliases = match.aliases.length ? ` aliases=[${match.aliases.join(", ")}]` : "";
    process.stdout.write(
      `${formatUser(match)} messages=${match.messageCount} score=${match.score}${aliases}${match.lastMessageAt ? ` last=${match.lastMessageAt.toISOString()}` : ""}\n`
    );
  }
}

function formatUser(user: { id: string; username: string | null; globalName: string | null }) {
  const names = [user.globalName, user.username ? `@${user.username}` : null].filter(Boolean).join(" / ") || "(unknown)";
  return `${names} id=${user.id}`;
}

function formatAliasUser(user: { userId: string; username: string | null; globalName: string | null }) {
  const names = [user.globalName, user.username ? `@${user.username}` : null].filter(Boolean).join(" / ") || "(unknown)";
  return `${names} id=${user.userId}`;
}

function requiredText(parts: string[], message: string) {
  const value = parts.join(" ").trim();
  if (!value) throw new Error(message);
  return value;
}

function printUsage() {
  process.stdout.write(`Usage:
  npm run aliases -- top [limit]
  npm run aliases -- list [query]
  npm run aliases -- resolve <query>
  npm run aliases -- add <user-query-or-id> <alias> [alias...]
  npm run aliases -- remove <alias>

Examples:
  npm run aliases -- add jordan1323 hunter "hunt er"
  npm run aliases -- add riverrunner connor riverphone
  npm run aliases -- resolve hunter
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
