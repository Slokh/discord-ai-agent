import "dotenv/config";
import { existsSync } from "node:fs";
import { z } from "zod";
import { assertNoRetiredEnvironmentVariables, environmentVariableNames } from "./environment.js";
import { CONSOLE_PUBLIC_URL } from "../console/constants.js";

type ProcessRole = "all" | "bot" | "worker" | "console";
const PUBLIC_REPOSITORY_URL = "https://github.com/Slokh/discord-ai-agent";

/**
 * Product and architecture decisions belong in source control, not in the
 * deployment environment. Change these deliberately and ship them through CI.
 */
export const productConfig = {
  discord: {
    botName: "ai",
    loadingReaction: "⏳",
    maxReplyChars: 1_800,
    responseTimeoutMs: 30 * 60 * 1_000
  },
  models: {
    baseUrl: "https://openrouter.ai/api/v1",
    appTitle: "Discord AI Agent",
    httpReferer: PUBLIC_REPOSITORY_URL,
    chat: "openai/gpt-6-luna",
    utility: "openai/gpt-6-luna",
    embedding: "qwen/qwen3-embedding-8b",
    image: "google/gemini-3.1-flash-image",
    transcription: "openai/whisper-large-v3-turbo",
    embeddingDimensions: 1_536
  },
  console: { host: "0.0.0.0", port: 8_081, publicUrl: CONSOLE_PUBLIC_URL },
  retention: { runtimeEventsDays: 60, auditDays: 90, runtimeSessionsDays: 90, terminalRemindersDays: 90 },
  memory: { compactionThreshold: 100, compactionKeepRecent: 30 },
  crawl: { batchSize: 100, fetchRetries: 3, retryBaseMs: 1_000, retryMaxMs: 30_000, scheduleCron: "0 6 * * *" },
  context: { maxHistoryResults: 10, maxThreadSummaryMessages: 80, agentPromptMaxConcurrency: 4 },
  chatTimeouts: { silenceMs: 120_000, hardMs: 600_000 },
  payments: { balancesPublic: true, network: "mainnet" as "moderato" | "mainnet", usdToken: "USDC.e", initialGrantUsd: 0.1 },
  promptOverlayPath: ".discord-ai-agent/prompt-overlay.md"
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_REVISION: z.string().trim().default("unknown"),
  RELEASE_VERIFICATION_ID: z.string().trim().default(""),
  PREVIOUS_APP_REVISION: z.string().trim().default(""),

  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().trim().default(""),
  DISCORD_CLIENT_SECRET: z.string().trim().default(""),
  DISCORD_GUILD_ID: z.string().trim().default(""),
  DATABASE_URL: z.string().default(defaultDatabaseUrl()),
  OPENROUTER_API_KEY: z.string().optional(),

  CONSOLE_SESSION_SECRET: z.string().trim().default("").refine(
    (value) => value === "" || value.length >= 32,
    "CONSOLE_SESSION_SECRET must contain at least 32 characters.",
  ),

  BOT_OWNER_USER_ID: z.string().trim().default(""),
  OPS_ALLOWLIST_USER_IDS: z.string().default(""),
  PRIVY_APP_ID: z.string().trim().optional(),
  PRIVY_APP_SECRET: z.string().trim().optional(),
});

const runtimeEnvironmentSchemaNames = new Set(Object.keys(envSchema.shape));
const missingManifestVariables = [...runtimeEnvironmentSchemaNames].filter((name) => !environmentVariableNames.has(name));
const unusedManifestVariables = [...environmentVariableNames].filter((name) => !runtimeEnvironmentSchemaNames.has(name));
if (missingManifestVariables.length || unusedManifestVariables.length) {
  throw new Error(
    `Environment manifest/schema mismatch (missing from manifest: ${missingManifestVariables.join(", ") || "none"}; ` +
    `missing from runtime schema: ${unusedManifestVariables.join(", ") || "none"}).`,
  );
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(argv = process.argv) {
  // Production must surface stale deployment configuration. Local shells may
  // still carry old dotenv keys while developers migrate; those keys are not
  // parsed and therefore cannot change runtime behavior.
  if (process.env.NODE_ENV === "production") assertNoRetiredEnvironmentVariables(process.env);
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }
  const env = parsed.data;
  const processRole = processRoleFromArgs(argv);
  const walletEnabled = Boolean(env.PRIVY_APP_ID?.trim() && env.PRIVY_APP_SECRET?.trim());

  return {
    nodeEnv: env.NODE_ENV,
    appRevision: env.APP_REVISION || "unknown",
    releaseNotes: {
      verificationId: env.RELEASE_VERIFICATION_ID || null,
      previousRevision: env.PREVIOUS_APP_REVISION || null
    },
    logLevel: defaultLogLevel(env.NODE_ENV),
    processRole,
    runMigrations: env.NODE_ENV !== "production",
    discord: {
      token: env.DISCORD_TOKEN,
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      guildId: env.DISCORD_GUILD_ID,
      botName: productConfig.discord.botName,
      loadingReaction: productConfig.discord.loadingReaction,
    },
    databaseUrl: env.DATABASE_URL,
    embeddingDimensions: productConfig.models.embeddingDimensions,
    openRouter: {
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: productConfig.models.baseUrl,
      appTitle: productConfig.models.appTitle,
      httpReferer: productConfig.models.httpReferer,
      chatModel: productConfig.models.chat,
      utilityModel: productConfig.models.utility,
      embeddingModel: productConfig.models.embedding,
      imageModel: productConfig.models.image,
      transcriptionModel: productConfig.models.transcription
    },
    consoleServer: { host: productConfig.console.host, port: productConfig.console.port },
    consoleAuth: {
      publicUrl: productConfig.console.publicUrl,
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      guildId: env.DISCORD_GUILD_ID,
      sessionSecret: env.CONSOLE_SESSION_SECRET,
    },
    worker: {
      crawlEnabled: true,
      // Structured and keyword retrieval are the production default. Keep the
      // optional paid embedding consumer dormant unless it is redesigned as an
      // explicit, bounded backfill.
      embeddingEnabled: false,
      agentRuntimeEnabled: true,
      retention: productConfig.retention,
      memoryCompaction: {
        threshold: productConfig.memory.compactionThreshold,
        keepRecent: productConfig.memory.compactionKeepRecent
      }
    },
    crawlBatchSize: productConfig.crawl.batchSize,
    crawlFetchRetries: productConfig.crawl.fetchRetries,
    crawlRetryBaseMs: productConfig.crawl.retryBaseMs,
    crawlRetryMaxMs: productConfig.crawl.retryMaxMs,
    crawlScheduleCron: productConfig.crawl.scheduleCron,
    maxHistoryResults: productConfig.context.maxHistoryResults,
    maxThreadSummaryMessages: productConfig.context.maxThreadSummaryMessages,
    maxReplyChars: productConfig.discord.maxReplyChars,
    discordAgentResponseTimeoutMs: productConfig.discord.responseTimeoutMs,
    agentPromptMaxConcurrency: productConfig.context.agentPromptMaxConcurrency,
    allowlists: {
      ownerUserId: env.BOT_OWNER_USER_ID || null,
      opsUserIds: parseCsv(env.OPS_ALLOWLIST_USER_IDS),
      imageToolsAllowlistOnly: false
    },
    chatTimeouts: productConfig.chatTimeouts,
    payments: {
      walletEnabled,
      userWalletsEnabled: walletEnabled,
      balancesPublic: productConfig.payments.balancesPublic,
      privyAppId: env.PRIVY_APP_ID?.trim() || null,
      privyAppSecret: env.PRIVY_APP_SECRET?.trim() || null,
      tempoNetwork: productConfig.payments.network,
      usdToken: productConfig.payments.usdToken,
      initialGrantUsd: productConfig.payments.initialGrantUsd
    },
    promptOverlayPath: productConfig.promptOverlayPath
  };
}

function processRoleFromArgs(argv = process.argv): ProcessRole {
  return argv.find((arg): arg is ProcessRole => ["all", "bot", "worker", "console"].includes(arg)) ?? "bot";
}

function defaultDatabaseUrl() {
  return existsSync("/.dockerenv")
    ? "postgres://discord_ai_agent:discord_ai_agent@postgres:5432/discord_ai_agent"
    : "postgres://discord_ai_agent:discord_ai_agent@localhost:5433/discord_ai_agent";
}

function defaultLogLevel(nodeEnv: string) {
  if (nodeEnv === "test") return "silent";
  if (nodeEnv === "production") return "info";
  return "debug";
}

function parseCsv(value: string) {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

export function assertDiscordConfig(config: AppConfig): asserts config is AppConfig & {
  discord: { token: string; clientId: string; guildId: string; botName: string };
} {
  const missing = [
    ["DISCORD_TOKEN", config.discord.token],
    ["DISCORD_CLIENT_ID", config.discord.clientId],
    ["DISCORD_GUILD_ID", config.discord.guildId]
  ].filter(([, value]) => !value);
  if (missing.length > 0) throw new Error(`Missing required Discord secret/config values: ${missing.map(([name]) => name).join(", ")}`);
}

export function assertConsoleAuthConfig(config: AppConfig): asserts config is AppConfig & {
  consoleAuth: { publicUrl: string; clientId: string; clientSecret: string; guildId: string; sessionSecret: string };
} {
  const missing = [
    ["DISCORD_CLIENT_ID", config.consoleAuth.clientId],
    ["DISCORD_CLIENT_SECRET", config.consoleAuth.clientSecret],
    ["DISCORD_GUILD_ID", config.consoleAuth.guildId],
    ["CONSOLE_SESSION_SECRET", config.consoleAuth.sessionSecret],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    throw new Error(`Missing required Console authentication values: ${missing.map(([name]) => name).join(", ")}`);
  }
}

export function missingPaymentConfig(config: AppConfig): string[] {
  const missing: string[] = [];
  if (!config.payments.privyAppId) missing.push("PRIVY_APP_ID");
  if (!config.payments.privyAppSecret) missing.push("PRIVY_APP_SECRET");
  return missing;
}

export function assertPaymentConfig(config: AppConfig): asserts config is AppConfig & {
  payments: AppConfig["payments"] & { privyAppId: string; privyAppSecret: string };
} {
  const missing = missingPaymentConfig(config);
  if (missing.length > 0) throw new Error(`Wallet payments are enabled but required configuration is missing: ${missing.join(", ")}`);
}

export function assertOpenRouterConfig(config: AppConfig): asserts config is AppConfig & {
  openRouter: AppConfig["openRouter"] & { apiKey: string };
} {
  if (!config.openRouter.apiKey) throw new Error("OPENROUTER_API_KEY is required for model calls.");
}
