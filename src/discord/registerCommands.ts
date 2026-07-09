import { REST, Routes } from "discord.js";
import { assertDiscordConfig, loadConfig } from "../config/env.js";

export async function clearApplicationCommands() {
  const config = loadConfig();
  assertDiscordConfig(config);
  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
    // This bot is intentionally commandless: the UX is mention-driven.
    // Keep this script only to clear previously registered slash commands.
    body: []
  });
  process.stdout.write(`Cleared stale slash commands for guild ${config.discord.guildId}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  clearApplicationCommands().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
