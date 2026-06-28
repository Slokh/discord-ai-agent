import { REST, Routes } from "discord.js";
import { assertDiscordConfig, loadConfig } from "../config/env.js";
import { commandPayloads } from "./commands.js";

export async function registerCommands() {
  const config = loadConfig();
  assertDiscordConfig(config);
  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
    body: commandPayloads
  });
  const action = commandPayloads.length === 0 ? "Cleared stale slash commands" : "Registered slash commands";
  process.stdout.write(`${action} for guild ${config.discord.guildId}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  registerCommands().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
