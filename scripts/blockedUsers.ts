import { loadConfig } from "../src/config/env.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { DiscordAiAgentRepository } from "../src/db/repositories.js";

type BlockCommand = "block" | "unblock" | "list";

async function main() {
  const config = loadConfig();
  const guildId = config.discord.guildId;
  if (!guildId) throw new Error("DISCORD_GUILD_ID is required to manage interaction blocks.");

  const command = process.argv[2] as BlockCommand | undefined;
  if (!command || !["block", "unblock", "list"].includes(command)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  await runMigrations(config.databaseUrl);
  const pool = createPool(config);
  const repo = new DiscordAiAgentRepository(pool);

  try {
    if (command === "list") {
      const blocks = await repo.listInteractionBlocks(guildId);
      if (blocks.length === 0) {
        process.stdout.write("No blocked users.\n");
        return;
      }
      for (const block of blocks) {
        process.stdout.write(
          `${block.userId}${block.reason ? ` - ${block.reason}` : ""} (updated ${block.updatedAt.toISOString()})\n`
        );
      }
      return;
    }

    const userId = process.argv[3];
    if (!isDiscordSnowflake(userId)) {
      throw new Error("Provide a Discord user ID, for example: npm run blocked-users -- block 123456789012345678");
    }

    if (command === "block") {
      const reason = process.argv.slice(4).join(" ").trim() || null;
      await repo.blockUserInteraction({ guildId, userId, reason });
      process.stdout.write(`Blocked Discord AI Agent interactions from ${userId}${reason ? ` (${reason})` : ""}.\n`);
      return;
    }

    const removed = await repo.unblockUserInteraction({ guildId, userId });
    process.stdout.write(removed ? `Unblocked ${userId}.\n` : `${userId} was not blocked.\n`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function isDiscordSnowflake(value: string | undefined): value is string {
  return Boolean(value && /^\d{5,32}$/.test(value));
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  npm run blocked-users -- list",
      "  npm run blocked-users -- block <discord-user-id> [reason]",
      "  npm run blocked-users -- unblock <discord-user-id>"
    ].join("\n") + "\n"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
