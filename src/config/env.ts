import "dotenv/config";
import { existsSync } from "node:fs";
import { z } from "zod";
import { parseGitHubRepository } from "../github/repository.js";
import { assertNoRetiredEnvironmentVariables, environmentVariableNames } from "./environment.js";

type ProcessRole = "all" | "api" | "bot" | "worker";
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
    chat: "openai/gpt-5.6-luna",
    codegen: "openai/gpt-5.6-terra",
    utility: "openai/gpt-5.6-luna",
    embedding: "qwen/qwen3-embedding-8b",
    image: "google/gemini-3.1-flash-image",
    transcription: "openai/whisper-large-v3-turbo",
    embeddingDimensions: 1_536
  },
  github: { repository: new URL(PUBLIC_REPOSITORY_URL).pathname.slice(1), baseBranch: "main" },
  control: {
    host: "0.0.0.0",
    port: 8_080,
    internalUrl: "http://discord-ai-agent-api:8080"
  },
  sandbox: {
    namespace: "discord-ai-agent",
    image: "discord-ai-agent-sandbox:latest",
    imagePullPolicy: "IfNotPresent",
    serviceAccountName: "discord-ai-agent-sandbox",
    cpuRequest: "500m",
    cpuLimit: "2",
    memoryRequest: "512Mi",
    memoryLimit: "2Gi",
    taskTimeoutSeconds: 1_800,
    ttlSecondsAfterFinished: 3_600
  },
  retention: { eventsDays: 60, auditDays: 90, embeddingRunsDays: 14, runtimeDays: 90 },
  memory: { compactionThreshold: 100, compactionKeepRecent: 30 },
  crawl: { batchSize: 100, fetchRetries: 3, retryBaseMs: 1_000, retryMaxMs: 30_000, scheduleCron: "0 6 * * *" },
  context: { maxHistoryResults: 10, maxThreadSummaryMessages: 80, agentPromptMaxConcurrency: 4 },
  chatTimeouts: { silenceMs: 120_000, hardMs: 600_000 },
  payments: { balancesPublic: true, network: "mainnet" as "moderato" | "mainnet", usdToken: "USDC.e", initialGrantUsd: 0.1 },
  spotifyMarket: "US",
  promptOverlayPath: ".discord-ai-agent/prompt-overlay.md"
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_REVISION: z.string().trim().default("unknown"),
  RELEASE_VERIFICATION_ID: z.string().trim().default(""),
  PREVIOUS_APP_REVISION: z.string().trim().default(""),
  RELEASE_NOTES_CHANNEL_ID: z.string().trim().default(""),

  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().trim().default(""),
  DISCORD_GUILD_ID: z.string().trim().default(""),
  DISCORD_PREMIUM_SKU_IDS: z.string().trim().default("").refine(
    (value) => value === "" || value.split(",").every((id) => /^\d{17,20}$/.test(id.trim())),
    "DISCORD_PREMIUM_SKU_IDS must be a comma-separated list of Discord snowflakes."
  ),
  DATABASE_URL: z.string().default(defaultDatabaseUrl()),
  OPENROUTER_API_KEY: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_APP_ID: z.string().trim().default(""),
  GITHUB_APP_PRIVATE_KEY: z.string().default(""),
  GITHUB_APP_INSTALLATION_ID: z.string().trim().default(""),
  TASK_SIGNING_SECRET: z.string().default(""),
  CONTROL_API_AUTH_PASSWORD: z.string().default(""),
  CONTROL_API_PUBLIC_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),

  BOT_OWNER_USER_ID: z.string().trim().default(""),
  OPS_ALLOWLIST_USER_IDS: z.string().default(""),
  SPOTIFY_CLIENT_ID: z.string().default(""),
  SPOTIFY_CLIENT_SECRET: z.string().default(""),
  PRIVY_APP_ID: z.string().trim().optional(),
  PRIVY_APP_SECRET: z.string().trim().optional(),

  POD_NAMESPACE: z.string().trim().optional(),
  SANDBOX_IMAGE: z.string().trim().optional()
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
  assertControlApiConfig(env.CONTROL_API_PUBLIC_URL, env.CONTROL_API_AUTH_PASSWORD, processRole, env.NODE_ENV);
  const walletEnabled = Boolean(env.PRIVY_APP_ID?.trim() && env.PRIVY_APP_SECRET?.trim());

  return {
    nodeEnv: env.NODE_ENV,
    appRevision: env.APP_REVISION || "unknown",
    releaseNotes: {
      verificationId: env.RELEASE_VERIFICATION_ID || null,
      previousRevision: env.PREVIOUS_APP_REVISION || null,
      channelId: env.RELEASE_NOTES_CHANNEL_ID || null
    },
    logLevel: defaultLogLevel(env.NODE_ENV),
    processRole,
    runMigrations: env.NODE_ENV !== "production",
    discord: {
      token: env.DISCORD_TOKEN,
      clientId: env.DISCORD_CLIENT_ID,
      guildId: env.DISCORD_GUILD_ID,
      botName: productConfig.discord.botName,
      loadingReaction: productConfig.discord.loadingReaction,
      premiumSkuIds: parseCsv(env.DISCORD_PREMIUM_SKU_IDS)
    },
    databaseUrl: env.DATABASE_URL,
    embeddingDimensions: productConfig.models.embeddingDimensions,
    openRouter: {
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: productConfig.models.baseUrl,
      appTitle: productConfig.models.appTitle,
      httpReferer: productConfig.models.httpReferer,
      chatModel: productConfig.models.chat,
      codegenModel: productConfig.models.codegen,
      utilityModel: productConfig.models.utility,
      embeddingModel: productConfig.models.embedding,
      imageModel: productConfig.models.image,
      transcriptionModel: productConfig.models.transcription
    },
    github: {
      token: env.GITHUB_TOKEN,
      repository: productConfig.github.repository,
      baseBranch: productConfig.github.baseBranch,
      appId: env.GITHUB_APP_ID,
      appPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
      appInstallationId: env.GITHUB_APP_INSTALLATION_ID
    },
    internalApi: { host: productConfig.control.host, port: productConfig.control.port },
    controlApi: { authPassword: env.CONTROL_API_AUTH_PASSWORD, publicUrl: env.CONTROL_API_PUBLIC_URL?.replace(/\/$/, "") || null },
    execution: {
      taskSigningSecret: env.TASK_SIGNING_SECRET,
      sandbox: { taskTimeoutSeconds: productConfig.sandbox.taskTimeoutSeconds },
      kubernetes: {
        namespace: env.POD_NAMESPACE || productConfig.sandbox.namespace,
        sandboxImage: env.SANDBOX_IMAGE || productConfig.sandbox.image,
        imagePullPolicy: productConfig.sandbox.imagePullPolicy,
        serviceAccountName: productConfig.sandbox.serviceAccountName,
        cpuRequest: productConfig.sandbox.cpuRequest,
        cpuLimit: productConfig.sandbox.cpuLimit,
        memoryRequest: productConfig.sandbox.memoryRequest,
        memoryLimit: productConfig.sandbox.memoryLimit,
        ttlSecondsAfterFinished: productConfig.sandbox.ttlSecondsAfterFinished
      }
    },
    worker: {
      crawlEnabled: true,
      embeddingEnabled: true,
      taskEnabled: true,
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
    spotify: { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET, market: productConfig.spotifyMarket },
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
  return argv.find((arg): arg is ProcessRole => arg === "all" || arg === "api" || arg === "bot" || arg === "worker") ?? "bot";
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

function assertControlApiConfig(publicUrl: string | undefined, password: string, processRole: ProcessRole, nodeEnv: string) {
  if (publicUrl) {
    const url = new URL(publicUrl);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !local) throw new Error("CONTROL_API_PUBLIC_URL must use HTTPS outside localhost.");
  }
  const servesApi = processRole === "api" || processRole === "all";
  if (servesApi && !password && (Boolean(publicUrl) || nodeEnv === "production")) {
    throw new Error("CONTROL_API_AUTH_PASSWORD is required when the API serves production or publicly routed control endpoints.");
  }
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

export function assertTaskCallbackConfig(config: AppConfig): asserts config is AppConfig & {
  execution: AppConfig["execution"] & { taskSigningSecret: string };
} {
  if (!config.execution.taskSigningSecret) throw new Error("TASK_SIGNING_SECRET is required for sandbox task callbacks.");
}

export function assertExecutionConfig(config: AppConfig): asserts config is AppConfig & {
  execution: AppConfig["execution"] & { taskSigningSecret: string };
  openRouter: AppConfig["openRouter"] & { apiKey: string };
} {
  assertTaskCallbackConfig(config);
  const missing: string[] = [];
  if (!config.openRouter.apiKey) missing.push("OPENROUTER_API_KEY");
  if (!hasGitHubTaskCredential(config)) missing.push("GITHUB_TOKEN or GitHub App credentials");
  if (missing.length > 0) throw new Error(`Missing required sandbox execution secret/config values: ${missing.join(", ")}`);
  parseGitHubRepository(config.github.repository);
}

export function hasGitHubTaskCredential(config: AppConfig) {
  return Boolean(config.github.token || (config.github.appId && config.github.appPrivateKey && config.github.appInstallationId));
}
