import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { assertDiscordConfig, loadConfig } from "../src/config/env.js";
import { summarizeBotChannelPermissions, validateMemberLevelBotPermissions } from "../src/discord/permissions.js";

async function main() {
  const config = loadConfig();
  assertDiscordConfig(config);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
  });

  try {
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for Discord ready event.")), 15_000);
      client.once(Events.ClientReady, () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await client.login(config.discord.token);
    await ready;

    const guild = await client.guilds.fetch(config.discord.guildId).catch(async (error: any) => {
      if (error?.code !== 10004) throw error;
      const guilds = await client.guilds.fetch();
      const visibleGuilds = [...guilds.values()].map((guild) => `${guild.name} (${guild.id})`);
      throw new Error(
        [
          `Discord bot logged in as ${client.user?.tag ?? "unknown"}, but cannot see configured guild ${config.discord.guildId}.`,
          visibleGuilds.length
            ? `Guilds visible to this bot token: ${visibleGuilds.join(", ")}.`
            : "Guilds visible to this bot token: none.",
          "Invite this exact bot application to the target server, or update the hardcoded guild ID in src/config/env.ts."
        ].join("\n")
      );
    });
    const botMember = await guild.members.fetchMe();
    const channels = await guild.channels.fetch();
    const permissions = summarizeBotChannelPermissions(botMember, channels.values());

    process.stdout.write(`discord ok: logged in as ${client.user?.tag ?? "unknown"}\n`);
    process.stdout.write(`guild ok: ${guild.name} (${guild.id})\n`);
    process.stdout.write(`bot member ok: ${botMember.displayName}\n`);
    process.stdout.write(`bot administrator permission: ${permissions.hasAdministrator ? "yes - remove this for member-level setup" : "no"}\n`);
    process.stdout.write(`channels visible to client cache: ${channels.size}\n`);
    process.stdout.write(
      `permissions ok: crawlable=${permissions.crawlableChannels}/${permissions.textLikeChannels}, ` +
        `sendable=${permissions.sendableChannels}/${permissions.textLikeChannels}, ` +
        `thread-sendable=${permissions.threadSendableChannels}/${permissions.textLikeChannels}, ` +
        `attachable=${permissions.attachableChannels}/${permissions.textLikeChannels}\n`
    );
    if (permissions.missingCrawlChannelNames.length > 0) {
      process.stdout.write(`missing crawl permission sample: ${permissions.missingCrawlChannelNames.join(", ")}\n`);
    }
    if (permissions.missingSendChannelNames.length > 0) {
      process.stdout.write(`missing send permission sample: ${permissions.missingSendChannelNames.join(", ")}\n`);
    }
    if (permissions.missingAttachChannelNames.length > 0) {
      process.stdout.write(`missing attach permission sample: ${permissions.missingAttachChannelNames.join(", ")}\n`);
    }

    const memberLevelErrors = validateMemberLevelBotPermissions(permissions);
    if (memberLevelErrors.length > 0) {
      throw new Error(memberLevelErrors.join("\n"));
    }
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
