import { loadConfig } from "../src/config/env.js";
import { createApplicationServices } from "../src/runtime/applicationServices.js";

/**
 * Seeds a small synthetic guild so the public eval suite can run against an
 * empty database (CI). Every name and message here is invented; nothing comes
 * from a real server.
 */
/** Synthetic snowflake-shaped IDs, built at runtime so no real-looking ID is committed. */
const synthetic = (prefix: number, index: number) => `${prefix}${String(index).padStart(17, "0")}`;

const config = loadConfig();
const guildId = config.discord.guildId;
if (!/^\d{17,20}$/.test(guildId)) throw new Error("Set DISCORD_GUILD_ID to a synthetic snowflake before seeding.");
const services = createApplicationServices({ config, enableWalletRuntime: false });
const channelId = synthetic(1, 1);
const members = [
  { id: synthetic(2, 1), name: "Avery" },
  { id: synthetic(2, 2), name: "Blake" },
  { id: synthetic(2, 3), name: "Casey" },
];
const lines = [
  "Morning all, the standup moved to 10:30 today.",
  "Has anyone tried the new ramen place on 5th? Thinking about lunch there Friday.",
  "Reminder that the quarterly planning doc is due next Wednesday.",
  "I finally fixed the flaky integration test, it was a timezone bug.",
  "Movie night pick: either Arrival or Interstellar, vote below.",
  "Arrival for sure, the linguistics angle is great.",
  "Interstellar, the soundtrack alone wins it.",
  "Anyone up for pickup basketball Saturday at noon?",
];
try {
  const repo = services.repo;
  await repo.upsertGuild({ id: guildId, name: "Eval Guild" });
  await repo.upsertChannel({ id: channelId, guildId, name: "general", type: 0, topic: "Everyday chat" });
  for (const member of members) {
    await repo.upsertUser({ id: member.id, username: member.name.toLowerCase(), globalName: member.name });
    await repo.upsertGuildMember({ guildId, userId: member.id, displayName: member.name });
  }
  const start = Date.now() - lines.length * 60 * 60 * 1000;
  for (const [index, content] of lines.entries()) {
    const author = members[index % members.length]!;
    await repo.upsertMessage({
      id: synthetic(3, index),
      guildId,
      channelId,
      authorId: author.id,
      authorUsername: author.name.toLowerCase(),
      authorGlobalName: author.name,
      memberDisplayName: author.name,
      content,
      normalizedContent: content.toLowerCase(),
      createdAt: new Date(start + index * 60 * 60 * 1000),
    });
  }
  process.stdout.write(`${JSON.stringify({ guildId, channelId, members: members.length, messages: lines.length })}\n`);
} finally {
  await services.close();
}
