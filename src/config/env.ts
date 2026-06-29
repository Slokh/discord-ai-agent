import "dotenv/config";
import { existsSync } from "node:fs";
import { z } from "zod";

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (typeof value === "boolean") return value;
    if (value == null || value === "") return undefined;
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  });

type ProcessRole = "all" | "bot" | "worker" | "codegen";

function defaultProcessRole(argv = process.argv): ProcessRole {
  const role = argv.find((arg): arg is ProcessRole => arg === "all" || arg === "bot" || arg === "worker" || arg === "codegen");
  return role ?? "bot";
}

function defaultDatabaseUrl() {
  return existsSync("/.dockerenv")
    ? "postgres://discord_ai_agent:discord_ai_agent@postgres:5432/discord_ai_agent"
    : "postgres://discord_ai_agent:discord_ai_agent@localhost:5433/discord_ai_agent";
}

function defaultLogLevel(nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv === "test") return "silent";
  if (nodeEnv === "production") return "info";
  return "debug";
}

const defaults = {
  nodeEnv: "development",
  logLevel: defaultLogLevel(),
  processRole: defaultProcessRole(),
  discordClientId: "",
  discordGuildId: "",
  discordBotName: "ai",
  databaseUrl: defaultDatabaseUrl(),
  embeddingDimensions: 1536,
  openRouterBaseUrl: "https://openrouter.ai/api/v1",
  openRouterAppTitle: "Discord AI Agent",
  openRouterHttpReferer: "http://localhost",
  openRouterChatModel: "deepseek/deepseek-v4-flash",
  openRouterEmbeddingModel: "qwen/qwen3-embedding-8b",
  openRouterImageModel: "google/gemini-3.1-flash-image",
  githubRepository: "owner/discord-ai-agent" as string,
  githubBaseBranch: "main",
  githubDryRun: false,
  githubDryRunDir: ".discord-ai-agent/dry-runs",
  railwayProjectId: "",
  railwayEnvironment: "production",
  railwayLogOwnerUserIds: "",
  crawlBatchSize: 100,
  crawlFetchRetries: 3,
  crawlRetryBaseMs: 1000,
  crawlRetryMaxMs: 30_000,
  maxHistoryResults: 10,
  maxThreadSummaryMessages: 80,
  maxReplyChars: 1800
} as const;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default(defaults.nodeEnv),
  LOG_LEVEL: z.string().default(defaults.logLevel),
  DISCORD_AI_AGENT_PROCESS_ROLE: z.enum(["all", "bot", "worker", "codegen"]).default(defaults.processRole),

  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().default(defaults.discordClientId),
  DISCORD_GUILD_ID: z.string().default(defaults.discordGuildId),
  BOT_NAME: z.string().default(defaults.discordBotName),

  DATABASE_URL: z.string().default(defaults.databaseUrl),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(defaults.embeddingDimensions),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default(defaults.openRouterBaseUrl),
  OPENROUTER_APP_TITLE: z.string().default(defaults.openRouterAppTitle),
  OPENROUTER_HTTP_REFERER: z.string().default(defaults.openRouterHttpReferer),
  OPENROUTER_CHAT_MODEL: z.string().default(defaults.openRouterChatModel),
  OPENROUTER_EMBEDDING_MODEL: z.string().default(defaults.openRouterEmbeddingModel),
  OPENROUTER_IMAGE_MODEL: z.string().default(defaults.openRouterImageModel),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPOSITORY: z.string().default(defaults.githubRepository),
  GITHUB_BASE_BRANCH: z.string().default(defaults.githubBaseBranch),
  GITHUB_DRY_RUN: booleanFromEnv.default(defaults.githubDryRun),
  GITHUB_DRY_RUN_DIR: z.string().default(defaults.githubDryRunDir),

  RAILWAY_TOKEN: z.string().optional(),
  RAILWAY_PROJECT_ID: z.string().default(defaults.railwayProjectId),
  RAILWAY_ENVIRONMENT: z.string().default(defaults.railwayEnvironment),
  RAILWAY_LOG_OWNER_USER_IDS: z.string().default(defaults.railwayLogOwnerUserIds),

  CRAWL_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(defaults.crawlBatchSize),
  CRAWL_FETCH_RETRIES: z.coerce.number().int().min(0).max(10).default(defaults.crawlFetchRetries),
  CRAWL_RETRY_BASE_MS: z.coerce.number().int().min(0).max(60_000).default(defaults.crawlRetryBaseMs),
  CRAWL_RETRY_MAX_MS: z.coerce.number().int().min(0).max(300_000).default(defaults.crawlRetryMaxMs),
  MAX_HISTORY_RESULTS: z.coerce.number().int().min(1).max(25).default(defaults.maxHistoryResults),
  MAX_THREAD_SUMMARY_MESSAGES: z.coerce.number().int().min(5).max(200).default(defaults.maxThreadSummaryMessages),
  MAX_REPLY_CHARS: z.coerce.number().int().min(500).max(1900).default(defaults.maxReplyChars)
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    processRole: parsed.data.DISCORD_AI_AGENT_PROCESS_ROLE,
    discord: {
      token: parsed.data.DISCORD_TOKEN,
      clientId: parsed.data.DISCORD_CLIENT_ID,
      guildId: parsed.data.DISCORD_GUILD_ID,
      botName: parsed.data.BOT_NAME
    },
    databaseUrl: parsed.data.DATABASE_URL,
    embeddingDimensions: parsed.data.EMBEDDING_DIMENSIONS,
    openRouter: {
      apiKey: parsed.data.OPENROUTER_API_KEY,
      baseUrl: parsed.data.OPENROUTER_BASE_URL.replace(/\/$/, ""),
      appTitle: parsed.data.OPENROUTER_APP_TITLE,
      httpReferer: parsed.data.OPENROUTER_HTTP_REFERER,
      chatModel: parsed.data.OPENROUTER_CHAT_MODEL,
      embeddingModel: parsed.data.OPENROUTER_EMBEDDING_MODEL,
      imageModel: parsed.data.OPENROUTER_IMAGE_MODEL
    },
    github: {
      token: parsed.data.GITHUB_TOKEN,
      repository: parsed.data.GITHUB_REPOSITORY,
      baseBranch: parsed.data.GITHUB_BASE_BRANCH,
      dryRun: parsed.data.GITHUB_DRY_RUN,
      dryRunDir: parsed.data.GITHUB_DRY_RUN_DIR
    },
    railway: {
      token: parsed.data.RAILWAY_TOKEN,
      projectId: parsed.data.RAILWAY_PROJECT_ID,
      environment: parsed.data.RAILWAY_ENVIRONMENT,
      logOwnerUserIds: parseCsv(parsed.data.RAILWAY_LOG_OWNER_USER_IDS)
    },
    crawlBatchSize: parsed.data.CRAWL_BATCH_SIZE,
    crawlFetchRetries: parsed.data.CRAWL_FETCH_RETRIES,
    crawlRetryBaseMs: parsed.data.CRAWL_RETRY_BASE_MS,
    crawlRetryMaxMs: parsed.data.CRAWL_RETRY_MAX_MS,
    maxHistoryResults: parsed.data.MAX_HISTORY_RESULTS,
    maxThreadSummaryMessages: parsed.data.MAX_THREAD_SUMMARY_MESSAGES,
    maxReplyChars: parsed.data.MAX_REPLY_CHARS
  };
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function assertDiscordConfig(config: AppConfig): asserts config is AppConfig & {
  discord: { token: string; clientId: string; guildId: string; botName: string };
} {
  const missing = [
    ["DISCORD_TOKEN", config.discord.token],
    ["DISCORD_CLIENT_ID", config.discord.clientId],
    ["DISCORD_GUILD_ID", config.discord.guildId]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(`Missing required Discord secret/config values: ${missing.map(([name]) => name).join(", ")}`);
  }
}

export function assertOpenRouterConfig(config: AppConfig): asserts config is AppConfig & {
  openRouter: AppConfig["openRouter"] & { apiKey: string };
} {
  if (!config.openRouter.apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for model calls.");
  }
}
