import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DbPool } from "../src/db/pool.js";
import type { DiscordAiAgentRepository } from "../src/db/repositories.js";
import type { AgentFile } from "../src/tools/types.js";

const SESSION_CONTEXT_MESSAGE_LIMIT = 24;

type PromptArgs = {
  prompt: string;
  guildId?: string;
  channelId?: string;
  channelName?: string;
  userId: string;
  userName: string;
  visibleChannelIds?: string[];
  memory: boolean;
  useDiscordMemory: boolean;
  verbose: boolean;
  json: boolean;
  saveFilesDir: string;
};

type ChannelPick = {
  id: string;
  name: string | null;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt.trim()) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!args.verbose) {
    process.env.LOG_LEVEL = "warn";
  }

  const [
    { handleAgentRequest },
    { loadConfig },
    { runMigrations },
    { createPool },
    { DiscordAiAgentRepository },
    { PaymentRepository },
    { OpenRouterClient },
    { PrivyTempoWalletProvider },
    { WalletService },
    { startJobs },
    { runWithTrace }
  ] = await Promise.all([
    import("../src/agent/router.js"),
    import("../src/config/env.js"),
    import("../src/db/migrate.js"),
    import("../src/db/pool.js"),
    import("../src/db/repositories.js"),
    import("../src/db/paymentRepository.js"),
    import("../src/models/openrouter.js"),
    import("../src/payments/privyTempoWalletProvider.js"),
    import("../src/payments/walletService.js"),
    import("../src/jobs/queue.js"),
    import("../src/util/trace.js")
  ]);

  const config = loadConfig();
  if (!config.openRouter.apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for local prompting.");
  }
  await runMigrations(config.databaseUrl);

  const pool = createPool(config);
  const repo = new DiscordAiAgentRepository(pool);
  const paymentRepo = new PaymentRepository(pool);
  const openRouter = new OpenRouterClient(config.openRouter);
  const walletProvider = config.payments.walletEnabled && config.payments.privyAppId && config.payments.privyAppSecret
    ? new PrivyTempoWalletProvider({
        appId: config.payments.privyAppId,
        appSecret: config.payments.privyAppSecret,
        network: config.payments.tempoNetwork
      })
    : undefined;
  const walletService = walletProvider
    ? new WalletService(config.payments, paymentRepo, walletProvider)
    : undefined;
  const jobs = await startJobs({
    config,
    repo,
    crawler: {
      crawlConfiguredGuild: async () => undefined
    },
    worker: false,
    crawlWorker: false,
    embeddingWorker: false,
    taskWorker: false
  });

  try {
    applyLocalPromptDefaults(args, config);
    const guildId = args.guildId ?? config.discord.guildId;
    const currentChannel = await resolveCurrentChannel(pool, guildId, args);
    const visibleChannelIds = args.visibleChannelIds ?? (await allIndexedChannelIds(pool, guildId));
    const threadKey = args.useDiscordMemory ? discordChannelThreadKey(guildId, currentChannel.id) : localPromptThreadKey(guildId, currentChannel.id, args.userId);
    const priorSessionMessages = args.memory
      ? await loadPromptMemory(repo, {
          threadKey,
          guildId,
          channelId: currentChannel.id,
          useDiscordMemory: args.useDiscordMemory
        })
      : [];

    if (args.memory) {
      await repo.appendConversationMessage({
        threadKey,
        role: "user",
        authorId: args.userId,
        authorDisplayName: args.userName,
        content: args.prompt,
        metadata: {
          source: "local_prompt",
          channelId: currentChannel.id,
          channelName: currentChannel.name
        }
      });
    }

    const requestId = `local-${randomUUID().slice(0, 8)}`;
    await repo.upsertProcessRun({
      runId: requestId,
      traceId: requestId,
      kind: "prompt",
      status: "running",
      title: `Local prompt: ${args.prompt.slice(0, 80)}`,
      summary: args.prompt,
      guildId,
      channelId: currentChannel.id,
      userId: args.userId,
      requester: args.userName,
      source: "cli.prompt",
      metadata: {
        memory: args.memory,
        useDiscordMemory: args.useDiscordMemory,
        visibleChannelCount: visibleChannelIds.length,
        threadKey: args.memory ? threadKey : null
      }
    });
    await repo.storeProcessRunArtifact({
      runId: requestId,
      kind: "prompt",
      name: "CLI prompt",
      content: args.prompt,
      contentType: "text/plain",
      metadata: { channelId: currentChannel.id, channelName: currentChannel.name }
    });
    const agentStartedAt = Date.now();
    const response = await runWithTrace(
      {
        traceId: requestId,
        requestId,
        guildId,
        channelId: currentChannel.id,
        userId: args.userId
      },
      async () => {
        try {
          return await handleAgentRequest(
            {
              config,
              repo,
              openRouter,
              jobs,
              walletService,
              guildId,
              channelId: currentChannel.id,
              userId: args.userId,
              userDisplayName: args.userName,
              visibleChannelIds: uniqueStrings([currentChannel.id, ...visibleChannelIds]),
              mentionedUserIds: explicitUserMentionIds(args.prompt, config.discord.clientId),
              mentionedChannelIds: explicitChannelMentionIds(args.prompt),
              threadKey,
              sessionMessages: priorSessionMessages,
              requestId
            },
            stripOptionalBotAddress(args.prompt, config.discord.clientId, config.discord.botName)
          );
        } catch (error) {
          await repo.recordProcessRunSpan({
            runId: requestId,
            spanId: "agent.request",
            name: "Run local prompt",
            status: "failed",
            startedAt: new Date(agentStartedAt),
            completedAt: new Date(),
            durationMs: Date.now() - agentStartedAt,
            metadata: { error: error instanceof Error ? error.message : String(error) }
          });
          await repo.updateProcessRun({
            runId: requestId,
            status: "failed",
            summary: error instanceof Error ? error.message : String(error),
            metadata: { error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - agentStartedAt }
          });
          throw error;
        }
      }
    );
    await repo.recordProcessRunSpan({
      runId: requestId,
      spanId: "agent.request",
      name: "Run local prompt",
      status: "succeeded",
      startedAt: new Date(agentStartedAt),
      completedAt: new Date(),
      durationMs: Date.now() - agentStartedAt,
      metadata: { responseChars: response.content.length, fileCount: response.files?.length ?? 0 }
    });
    await repo.storeProcessRunArtifact({
      runId: requestId,
      kind: "response",
      name: "CLI response",
      content: response.content,
      contentType: "text/plain",
      metadata: { fileCount: response.files?.length ?? 0 }
    });
    await repo.updateProcessRun({
      runId: requestId,
      status: "succeeded",
      summary: `Answered with ${response.content.length} characters.`,
      metadata: { responseChars: response.content.length, durationMs: Date.now() - agentStartedAt }
    });

    const savedFiles = await saveAgentFiles(response.files ?? [], args.saveFilesDir);
    if (args.memory) {
      for (const memoryEvent of response.memoryEvents ?? []) {
        await repo.appendConversationMessage({
          threadKey,
          role: memoryEvent.role,
          authorId: config.discord.clientId,
          authorDisplayName: config.discord.botName,
          content: memoryEvent.content,
          metadata: {
            ...memoryEvent.metadata,
            source: "local_prompt"
          }
        });
      }

      await repo.appendConversationMessage({
        threadKey,
        role: "assistant",
        authorId: config.discord.clientId,
        authorDisplayName: config.discord.botName,
        content: response.content,
        metadata: {
          source: "local_prompt",
          files: savedFiles
        }
      });
    }

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            runId: requestId,
            traceId: requestId,
            guildId,
            channelId: currentChannel.id,
            channelName: currentChannel.name,
            visibleChannelCount: visibleChannelIds.length,
            threadKey: args.memory ? threadKey : null,
            durationMs: Date.now() - agentStartedAt,
            content: response.content,
            files: savedFiles
          },
          null,
          2
        )}\n`
      );
    } else {
      process.stdout.write(`${response.content}\n`);
      for (const file of savedFiles) {
        process.stdout.write(`\nSaved file: ${file.path}\n`);
      }
    }
  } finally {
    await jobs.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

function parseArgs(argv: string[]): PromptArgs {
  const promptParts: string[] = [];
  const args: PromptArgs = {
    prompt: "",
    userId: "local-cli",
    userName: "Local CLI",
    memory: true,
    useDiscordMemory: false,
    verbose: false,
    json: false,
    saveFilesDir: ".discord-ai-agent/prompt-files"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--no-memory") {
      args.memory = false;
    } else if (arg === "--use-discord-memory") {
      args.useDiscordMemory = true;
    } else if (arg === "--verbose") {
      args.verbose = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg.startsWith("--guild-id=")) {
      args.guildId = valueAfterEquals(arg);
    } else if (arg === "--guild-id") {
      args.guildId = requiredNext(argv, ++index, arg);
    } else if (arg.startsWith("--channel-id=")) {
      args.channelId = valueAfterEquals(arg);
    } else if (arg === "--channel-id") {
      args.channelId = requiredNext(argv, ++index, arg);
    } else if (arg.startsWith("--channel=")) {
      args.channelName = valueAfterEquals(arg);
    } else if (arg === "--channel") {
      args.channelName = requiredNext(argv, ++index, arg);
    } else if (arg.startsWith("--user-id=")) {
      args.userId = valueAfterEquals(arg);
    } else if (arg === "--user-id") {
      args.userId = requiredNext(argv, ++index, arg);
    } else if (arg.startsWith("--user-name=")) {
      args.userName = valueAfterEquals(arg);
    } else if (arg === "--user-name") {
      args.userName = requiredNext(argv, ++index, arg);
    } else if (arg.startsWith("--visible-channel-ids=")) {
      args.visibleChannelIds = commaSeparated(valueAfterEquals(arg));
    } else if (arg === "--visible-channel-ids") {
      args.visibleChannelIds = commaSeparated(requiredNext(argv, ++index, arg));
    } else if (arg.startsWith("--save-files-dir=")) {
      args.saveFilesDir = valueAfterEquals(arg);
    } else if (arg === "--save-files-dir") {
      args.saveFilesDir = requiredNext(argv, ++index, arg);
    } else {
      promptParts.push(arg);
    }
  }

  args.prompt = promptParts.join(" ").trim();
  return args;
}

function applyLocalPromptDefaults(args: PromptArgs, config: ReturnType<typeof import("../src/config/env.js").loadConfig>) {
  void args;
  void config;
}

async function resolveCurrentChannel(pool: DbPool, guildId: string, args: PromptArgs): Promise<ChannelPick> {
  if (args.channelId) {
    const result = await pool.query(
      `
        SELECT id, name
        FROM channels
        WHERE guild_id = $1
          AND id = $2
        LIMIT 1
      `,
      [guildId, args.channelId]
    );
    const row = result.rows[0];
    return row ? { id: String(row.id), name: row.name == null ? null : String(row.name) } : { id: args.channelId, name: null };
  }

  if (args.channelName) {
    const exact = await pool.query(
      `
        SELECT c.id, c.name, count(m.id)::int AS messages
        FROM channels c
        LEFT JOIN messages m ON m.channel_id = c.id
        WHERE c.guild_id = $1
          AND lower(c.name) = lower($2)
          AND c.is_excluded = false
        GROUP BY c.id, c.name
        ORDER BY messages DESC, c.id
        LIMIT 1
      `,
      [guildId, args.channelName.replace(/^#/, "")]
    );
    const exactRow = exact.rows[0];
    if (exactRow) return { id: String(exactRow.id), name: exactRow.name == null ? null : String(exactRow.name) };

    const fuzzy = await pool.query(
      `
        SELECT c.id, c.name, count(m.id)::int AS messages
        FROM channels c
        LEFT JOIN messages m ON m.channel_id = c.id
        WHERE c.guild_id = $1
          AND c.name ILIKE $2
          AND c.is_excluded = false
        GROUP BY c.id, c.name
        ORDER BY messages DESC, c.id
        LIMIT 1
      `,
      [guildId, `%${args.channelName.replace(/^#/, "")}%`]
    );
    const fuzzyRow = fuzzy.rows[0];
    if (fuzzyRow) return { id: String(fuzzyRow.id), name: fuzzyRow.name == null ? null : String(fuzzyRow.name) };
    throw new Error(`Could not find a channel named "${args.channelName}" in guild ${guildId}.`);
  }

  const result = await pool.query(
    `
      SELECT c.id, c.name, count(m.id)::int AS messages
      FROM channels c
      JOIN messages m ON m.channel_id = c.id
      WHERE c.guild_id = $1
        AND c.is_excluded = false
      GROUP BY c.id, c.name
      ORDER BY messages DESC, c.id
      LIMIT 1
    `,
    [guildId]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`No indexed channels found for guild ${guildId}. Crawl or index the server first.`);
  return { id: String(row.id), name: row.name == null ? null : String(row.name) };
}

async function allIndexedChannelIds(pool: DbPool, guildId: string) {
  const result = await pool.query(
    `
      SELECT DISTINCT c.id
      FROM channels c
      JOIN messages m ON m.channel_id = c.id
      LEFT JOIN channels parent ON parent.id = c.parent_id
      WHERE c.guild_id = $1
        AND c.is_excluded = false
        AND coalesce(parent.is_excluded, false) = false
      ORDER BY c.id
    `,
    [guildId]
  );
  return result.rows.map((row) => String(row.id));
}

async function loadPromptMemory(
  repo: DiscordAiAgentRepository,
  input: { threadKey: string; guildId: string; channelId: string; useDiscordMemory: boolean }
) {
  await repo.ensureConversationSession({
    threadKey: input.threadKey,
    guildId: input.guildId,
    channelId: input.channelId,
    metadata: {
      kind: input.useDiscordMemory ? "discord_channel" : "local_prompt",
      source: "scripts/prompt.ts"
    }
  });
  return repo.recentConversationMessages({
    threadKey: input.threadKey,
    limit: SESSION_CONTEXT_MESSAGE_LIMIT
  });
}

async function saveAgentFiles(files: AgentFile[], outputDir: string) {
  if (files.length === 0) return [];
  await fs.mkdir(outputDir, { recursive: true });
  const saved: Array<{ name: string; contentType?: string; bytes: number; path: string }> = [];
  for (const file of files) {
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeFileName(file.name)}`;
    const outputPath = path.resolve(outputDir, name);
    await fs.writeFile(outputPath, file.data);
    saved.push({
      name: file.name,
      contentType: file.contentType,
      bytes: file.data.length,
      path: outputPath
    });
  }
  return saved;
}

function stripOptionalBotAddress(text: string, botUserId: string, botName: string) {
  return text
    .replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g"), "")
    .replace(new RegExp(`^@?${escapeRegExp(botName)}\\b`, "i"), "")
    .trim();
}

function explicitUserMentionIds(content: string, excludedUserId?: string): string[] {
  return uniqueStrings([...content.matchAll(/<@!?(\d+)>/g)].map((match) => match[1]).filter((id) => id && id !== excludedUserId));
}

function explicitChannelMentionIds(content: string): string[] {
  return uniqueStrings([...content.matchAll(/<#(\d+)>/g)].map((match) => match[1]).filter(Boolean));
}

function localPromptThreadKey(guildId: string, channelId: string, userId: string) {
  return `local-prompt:${guildId}:${channelId}:${userId}`;
}

function discordChannelThreadKey(guildId: string, channelId: string) {
  return `discord:${guildId}:${channelId}`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function commaSeparated(value: string) {
  return uniqueStrings(value.split(",").map((item) => item.trim()));
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

function valueAfterEquals(arg: string) {
  return arg.slice(arg.indexOf("=") + 1).trim();
}

function requiredNext(argv: string[], index: number, option: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printUsage() {
  process.stdout.write(`Usage:
  npm run prompt -- "what are the main recurring topics in each channel"
  npm run prompt -- --channel=stonks "summarize this thread"
  npm run prompt -- --no-memory "status"

Options:
  --channel <name>              Use a channel by name for current-channel context.
  --channel-id <id>             Use a channel ID for current-channel context.
  --visible-channel-ids <ids>   Comma-separated visible channel IDs; defaults to all indexed channels.
  --user-id <id>                Local requester ID. Defaults to local-cli.
  --user-name <name>            Local requester display name. Defaults to Local CLI.
  --no-memory                   Do not load or store CLI conversation memory.
  --use-discord-memory          Use the real Discord channel memory thread. Default uses separate CLI memory.
  --verbose                     Show normal Discord AI Agent debug/info logs.
  --json                        Print structured JSON.
  --save-files-dir <path>       Directory for generated files. Defaults to .discord-ai-agent/prompt-files.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
