import { PermissionFlagsBits } from "discord.js";
import { loadConfig } from "../src/config/env.js";

const config = loadConfig();

if (!config.discord.clientId) {
  console.error("Discord client ID is required to generate an invite URL.");
  process.exit(1);
}

const permissions =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.AttachFiles;

const url = new URL("https://discord.com/oauth2/authorize");
url.searchParams.set("client_id", config.discord.clientId);
url.searchParams.set("scope", "bot");
url.searchParams.set("permissions", permissions.toString());

process.stdout.write(`${url.toString()}\n`);
