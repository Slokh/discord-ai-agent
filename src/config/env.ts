import "dotenv/config";
import { existsSync } from "node:fs";
import { z } from "zod";
import { parseGitHubRepository } from "../github/repository.js";

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (typeof value === "boolean") return value;
    if (value == null || value === "") return undefined;
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  });

// Treat empty env values ("KEY=" lines in .env) as unset so defaults apply.
const emptyAsUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
function nonEmptyStringWithDefault(defaultValue: string) {
  return z.preprocess(emptyAsUndefined, z.string().trim().min(1).default(defaultValue));
}

type ProcessRole = "all" | "api" | "bot" | "worker";
type CodegenExecutionBackend = "kubernetes-job" | "local-process";
type CodegenHarness = "codex" | "opencode";
type TempoNetwork = "moderato" | "mainnet";

function defaultProcessRole(argv = process.argv): ProcessRole {
  const role = argv.find((arg): arg is ProcessRole => arg === "all" || arg === "api" || arg === "bot" || arg === "worker");
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
  appRevision: "unknown",
  previousAppRevision: "",
  releaseNotesChannelId: "",
  logLevel: defaultLogLevel(),
  processRole: defaultProcessRole(),
  runMigrations: true,
  discordClientId: "",
  discordGuildId: "",
  discordBotName: "ai",
  discordLoadingReaction: "⏳",
  discordPremiumSkuIds: "",
  databaseUrl: defaultDatabaseUrl(),
  embeddingDimensions: 1536,
  openRouterBaseUrl: "https://openrouter.ai/api/v1",
  openRouterAppTitle: "Discord AI Agent",
  openRouterHttpReferer: "http://localhost",
  openRouterChatModel: "z-ai/glm-5.2",
  openRouterEmbeddingModel: "qwen/qwen3-embedding-8b",
  openRouterImageModel: "google/gemini-3.1-flash-image",
  openRouterTranscriptionModel: "openai/whisper-large-v3-turbo",
  githubRepository: "owner/repo" as string,
  githubBaseBranch: "main",
  githubAppId: "",
  githubAppPrivateKey: "",
  githubAppInstallationId: "",
  internalApiHost: "0.0.0.0",
  internalApiPort: 8080,
  controlUiAuthPassword: "",
  controlUiPublicUrl: "",
  controlPlaneInternalUrl: "http://discord-ai-agent-api:8080",
  taskSigningSecret: "",
  codegenHarness: "opencode" as CodegenHarness,
  codegenExecutionBackend: "local-process" as CodegenExecutionBackend,
  kubernetesNamespace: process.env.POD_NAMESPACE || "discord-ai-agent",
  sandboxImage: "discord-ai-agent-sandbox:latest",
  sandboxImagePullPolicy: "IfNotPresent",
  sandboxServiceAccountName: "discord-ai-agent-sandbox",
  sandboxCpuRequest: "500m",
  sandboxCpuLimit: "2",
  sandboxMemoryRequest: "512Mi",
  sandboxMemoryLimit: "2Gi",
  sandboxTaskTimeoutSeconds: 1800,
  sandboxTtlSecondsAfterFinished: 3600,
  sandboxCacheDir: "/var/cache/discord-ai-agent",
  sandboxCachePvcName: "",
  codegenLeaseHeartbeatSeconds: 15,
  codegenLeaseStaleSeconds: 120,
  codegenLeaseAcquireTimeoutSeconds: 1800,
  codegenLeaseAcquirePollSeconds: 5,
  workerCrawlEnabled: true,
  workerEmbeddingEnabled: true,
  workerTaskEnabled: true,
  workerDiscordAgentEnabled: true,
  retentionEventsDays: 60,
  retentionAuditDays: 90,
  retentionEmbeddingRunsDays: 14,
  retentionRuntimeDays: 90,
  memoryCompactionThreshold: 100,
  memoryCompactionKeepRecent: 30,
  crawlBatchSize: 100,
  crawlFetchRetries: 3,
  crawlRetryBaseMs: 1000,
  crawlRetryMaxMs: 30_000,
  crawlScheduleCron: "0 6 * * *",
  maxHistoryResults: 10,
  maxThreadSummaryMessages: 80,
  maxReplyChars: 1800,
  discordAgentResponseTimeoutMs: 30 * 60 * 1000,
  agentPromptMaxConcurrency: 4,
  budgetUserTurnsPerDay: 50,
  budgetUserImagesPerDay: 10,
  budgetUserCodegenPerDay: 1,
  budgetGuildDailyUsd: 10,
  botOwnerUserId: "",
  opsAllowlistUserIds: "",
  imageToolsAllowlistOnly: false,
  chatSilenceTimeoutMs: 120_000,
  chatHardTimeoutMs: 600_000,
  spotifyClientId: "",
  spotifyClientSecret: "",
  spotifyMarket: "US",
  walletEnabled: false,
  userWalletsEnabled: false,
  walletBalancesPublic: false,
  tempoNetwork: "moderato" as TempoNetwork,
  tempoUsdToken: "USDC.e",
  walletInitialGrantUsd: 1,
  promptOverlayPath: ".discord-ai-agent/prompt-overlay.md",
  toolsetScoping: true
} as const;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default(defaults.nodeEnv),
  APP_REVISION: z.string().trim().default(defaults.appRevision),
  PREVIOUS_APP_REVISION: z.string().trim().default(defaults.previousAppRevision),
  RELEASE_NOTES_CHANNEL_ID: z.string().trim().default(defaults.releaseNotesChannelId),
  LOG_LEVEL: z.string().default(defaults.logLevel),
  DISCORD_AI_AGENT_PROCESS_ROLE: z.enum(["all", "api", "bot", "worker"]).default(defaults.processRole),
  RUN_MIGRATIONS: booleanFromEnv.default(defaults.runMigrations),

  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().default(defaults.discordClientId),
  DISCORD_GUILD_ID: z.string().default(defaults.discordGuildId),
  BOT_NAME: z.string().default(defaults.discordBotName),
  DISCORD_LOADING_REACTION: nonEmptyStringWithDefault(defaults.discordLoadingReaction),
  DISCORD_PREMIUM_SKU_IDS: z.string().trim().default(defaults.discordPremiumSkuIds).refine(
    (value) => value === "" || value.split(",").every((id) => /^\d{17,20}$/.test(id.trim())),
    "DISCORD_PREMIUM_SKU_IDS must be a comma-separated list of Discord snowflakes."
  ),

  DATABASE_URL: z.string().default(defaults.databaseUrl),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().refine((value) => value === 1536, {
    message: "EMBEDDING_DIMENSIONS must remain 1536 unless the vector column and HNSW index are migrated together."
  }).default(defaults.embeddingDimensions),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default(defaults.openRouterBaseUrl),
  OPENROUTER_APP_TITLE: z.string().default(defaults.openRouterAppTitle),
  OPENROUTER_HTTP_REFERER: z.string().default(defaults.openRouterHttpReferer),
  OPENROUTER_CHAT_MODEL: z.string().default(defaults.openRouterChatModel),
  OPENROUTER_CODEGEN_MODEL: z.string().optional(),
  OPENROUTER_UTILITY_MODEL: z.string().optional(),
  OPENROUTER_EMBEDDING_MODEL: z.string().default(defaults.openRouterEmbeddingModel),
  OPENROUTER_IMAGE_MODEL: z.string().default(defaults.openRouterImageModel),
  OPENROUTER_TRANSCRIPTION_MODEL: z.string().default(defaults.openRouterTranscriptionModel),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPOSITORY: z.string().default(defaults.githubRepository),
  GITHUB_BASE_BRANCH: z.string().default(defaults.githubBaseBranch),
  GITHUB_APP_ID: z.string().default(defaults.githubAppId),
  GITHUB_APP_PRIVATE_KEY: z.string().default(defaults.githubAppPrivateKey),
  GITHUB_APP_INSTALLATION_ID: z.string().default(defaults.githubAppInstallationId),
  INTERNAL_API_HOST: z.string().default(defaults.internalApiHost),
  INTERNAL_API_PORT: z.coerce.number().int().positive().default(defaults.internalApiPort),
  CONTROL_UI_AUTH_PASSWORD: z.string().default(defaults.controlUiAuthPassword),
  CONTROL_UI_PUBLIC_URL: z.string().default(defaults.controlUiPublicUrl),
  CONTROL_PLANE_INTERNAL_URL: z.string().url().default(defaults.controlPlaneInternalUrl),
  TASK_SIGNING_SECRET: z.string().default(defaults.taskSigningSecret),
  CODEGEN_HARNESS: z.enum(["codex", "opencode"]).default(defaults.codegenHarness),
  CODEGEN_EXECUTION_BACKEND: z.enum(["kubernetes-job", "local-process"]).default(defaults.codegenExecutionBackend),

  KUBERNETES_NAMESPACE: z.string().default(defaults.kubernetesNamespace),
  SANDBOX_IMAGE: z.string().default(defaults.sandboxImage),
  SANDBOX_IMAGE_PULL_POLICY: z.string().default(defaults.sandboxImagePullPolicy),
  SANDBOX_SERVICE_ACCOUNT_NAME: z.string().default(defaults.sandboxServiceAccountName),
  SANDBOX_CPU_REQUEST: z.string().default(defaults.sandboxCpuRequest),
  SANDBOX_CPU_LIMIT: z.string().default(defaults.sandboxCpuLimit),
  SANDBOX_MEMORY_REQUEST: z.string().default(defaults.sandboxMemoryRequest),
  SANDBOX_MEMORY_LIMIT: z.string().default(defaults.sandboxMemoryLimit),
  SANDBOX_TASK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(defaults.sandboxTaskTimeoutSeconds),
  SANDBOX_TTL_SECONDS_AFTER_FINISHED: z.coerce.number().int().positive().default(defaults.sandboxTtlSecondsAfterFinished),
  SANDBOX_CACHE_DIR: z.string().default(defaults.sandboxCacheDir),
  SANDBOX_CACHE_PVC_NAME: z.string().default(defaults.sandboxCachePvcName),
  CODEGEN_LEASE_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).max(300).default(defaults.codegenLeaseHeartbeatSeconds),
  CODEGEN_LEASE_STALE_SECONDS: z.coerce.number().int().min(10).max(3600).default(defaults.codegenLeaseStaleSeconds),
  CODEGEN_LEASE_ACQUIRE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(7200).default(defaults.codegenLeaseAcquireTimeoutSeconds),
  CODEGEN_LEASE_ACQUIRE_POLL_SECONDS: z.coerce.number().int().min(1).max(300).default(defaults.codegenLeaseAcquirePollSeconds),

  WORKER_CRAWL_ENABLED: booleanFromEnv.default(defaults.workerCrawlEnabled),
  WORKER_EMBEDDING_ENABLED: booleanFromEnv.default(defaults.workerEmbeddingEnabled),
  WORKER_TASK_ENABLED: booleanFromEnv.default(defaults.workerTaskEnabled),
  WORKER_DISCORD_AGENT_ENABLED: booleanFromEnv.default(defaults.workerDiscordAgentEnabled),

  RETENTION_EVENTS_DAYS: z.coerce.number().int().min(0).max(3650).default(defaults.retentionEventsDays),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().min(0).max(3650).default(defaults.retentionAuditDays),
  RETENTION_EMBEDDING_RUNS_DAYS: z.coerce.number().int().min(0).max(3650).default(defaults.retentionEmbeddingRunsDays),
  RETENTION_RUNTIME_DAYS: z.coerce.number().int().min(0).max(3650).default(defaults.retentionRuntimeDays),
  MEMORY_COMPACTION_THRESHOLD: z.coerce.number().int().min(0).max(100_000).default(defaults.memoryCompactionThreshold),
  MEMORY_COMPACTION_KEEP_RECENT: z.coerce.number().int().min(1).max(10_000).default(defaults.memoryCompactionKeepRecent),

  CRAWL_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(defaults.crawlBatchSize),
  CRAWL_FETCH_RETRIES: z.coerce.number().int().min(0).max(10).default(defaults.crawlFetchRetries),
  CRAWL_RETRY_BASE_MS: z.coerce.number().int().min(0).max(60_000).default(defaults.crawlRetryBaseMs),
  CRAWL_RETRY_MAX_MS: z.coerce.number().int().min(0).max(300_000).default(defaults.crawlRetryMaxMs),
  CRAWL_SCHEDULE_CRON: z.string().default(defaults.crawlScheduleCron),
  MAX_HISTORY_RESULTS: z.coerce.number().int().min(1).max(25).default(defaults.maxHistoryResults),
  MAX_THREAD_SUMMARY_MESSAGES: z.coerce.number().int().min(5).max(200).default(defaults.maxThreadSummaryMessages),
  MAX_REPLY_CHARS: z.coerce.number().int().min(500).max(1900).default(defaults.maxReplyChars),
  DISCORD_AGENT_RESPONSE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(60 * 60 * 1000)
    .default(defaults.discordAgentResponseTimeoutMs),
  AGENT_PROMPT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(defaults.agentPromptMaxConcurrency),
  BUDGET_USER_TURNS_PER_DAY: z.coerce.number().int().min(-1).default(defaults.budgetUserTurnsPerDay),
  BUDGET_USER_IMAGES_PER_DAY: z.coerce.number().int().min(-1).default(defaults.budgetUserImagesPerDay),
  BUDGET_USER_CODEGEN_PER_DAY: z.coerce.number().int().min(-1).default(defaults.budgetUserCodegenPerDay),
  BUDGET_GUILD_DAILY_USD: z.coerce.number().min(-1).default(defaults.budgetGuildDailyUsd),
  BOT_OWNER_USER_ID: z.string().default(defaults.botOwnerUserId),
  OPS_ALLOWLIST_USER_IDS: z.string().default(defaults.opsAllowlistUserIds),
  IMAGE_TOOLS_ALLOWLIST_ONLY: booleanFromEnv.default(defaults.imageToolsAllowlistOnly),
  CHAT_SILENCE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(60 * 60 * 1000).default(defaults.chatSilenceTimeoutMs),
  CHAT_HARD_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(60 * 60 * 1000).default(defaults.chatHardTimeoutMs),

  SPOTIFY_CLIENT_ID: z.string().default(defaults.spotifyClientId),
  SPOTIFY_CLIENT_SECRET: z.string().default(defaults.spotifyClientSecret),
  SPOTIFY_MARKET: nonEmptyStringWithDefault(defaults.spotifyMarket),
  WALLET_ENABLED: booleanFromEnv.default(defaults.walletEnabled),
  USER_WALLETS_ENABLED: booleanFromEnv.default(defaults.userWalletsEnabled),
  WALLET_BALANCES_PUBLIC: booleanFromEnv.default(defaults.walletBalancesPublic),
  PRIVY_APP_ID: z.string().trim().optional(),
  PRIVY_APP_SECRET: z.string().trim().optional(),
  TEMPO_NETWORK: z.enum(["moderato", "mainnet"]).default(defaults.tempoNetwork),
  TEMPO_USD_TOKEN: nonEmptyStringWithDefault(defaults.tempoUsdToken),
  WALLET_INITIAL_GRANT_USD: z.coerce.number().min(0).max(100).default(defaults.walletInitialGrantUsd),
  PROMPT_OVERLAY_PATH: z.string().trim().default(defaults.promptOverlayPath),
  TOOLSET_SCOPING: booleanFromEnv.default(defaults.toolsetScoping)
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }
  const chatModel = parsed.data.OPENROUTER_CHAT_MODEL;
  const codegenModel = parsed.data.OPENROUTER_CODEGEN_MODEL?.trim() || chatModel;
  const utilityModel = parsed.data.OPENROUTER_UTILITY_MODEL?.trim() || chatModel;

  return {
    nodeEnv: parsed.data.NODE_ENV,
    appRevision: parsed.data.APP_REVISION || defaults.appRevision,
    releaseNotes: {
      previousRevision: parsed.data.PREVIOUS_APP_REVISION || null,
      channelId: parsed.data.RELEASE_NOTES_CHANNEL_ID || null
    },
    logLevel: parsed.data.LOG_LEVEL,
    processRole: parsed.data.DISCORD_AI_AGENT_PROCESS_ROLE,
    runMigrations: parsed.data.RUN_MIGRATIONS,
    discord: {
      token: parsed.data.DISCORD_TOKEN,
      clientId: parsed.data.DISCORD_CLIENT_ID,
      guildId: parsed.data.DISCORD_GUILD_ID,
      botName: parsed.data.BOT_NAME,
      loadingReaction: parsed.data.DISCORD_LOADING_REACTION,
      premiumSkuIds: parsed.data.DISCORD_PREMIUM_SKU_IDS.split(",").map((id) => id.trim()).filter(Boolean)
    },
    databaseUrl: parsed.data.DATABASE_URL,
    embeddingDimensions: parsed.data.EMBEDDING_DIMENSIONS,
    openRouter: {
      apiKey: parsed.data.OPENROUTER_API_KEY,
      baseUrl: parsed.data.OPENROUTER_BASE_URL.replace(/\/$/, ""),
      appTitle: parsed.data.OPENROUTER_APP_TITLE,
      httpReferer: parsed.data.OPENROUTER_HTTP_REFERER,
      chatModel,
      codegenModel,
      utilityModel,
      embeddingModel: parsed.data.OPENROUTER_EMBEDDING_MODEL,
      imageModel: parsed.data.OPENROUTER_IMAGE_MODEL,
      transcriptionModel: parsed.data.OPENROUTER_TRANSCRIPTION_MODEL
    },
    github: {
      token: parsed.data.GITHUB_TOKEN,
      repository: parsed.data.GITHUB_REPOSITORY,
      baseBranch: parsed.data.GITHUB_BASE_BRANCH,
      appId: parsed.data.GITHUB_APP_ID,
      appPrivateKey: parsed.data.GITHUB_APP_PRIVATE_KEY,
      appInstallationId: parsed.data.GITHUB_APP_INSTALLATION_ID
    },
    internalApi: {
      host: parsed.data.INTERNAL_API_HOST,
      port: parsed.data.INTERNAL_API_PORT
    },
    controlUi: {
      authPassword: parsed.data.CONTROL_UI_AUTH_PASSWORD,
      publicUrl: parsed.data.CONTROL_UI_PUBLIC_URL.trim().replace(/\/$/, "") || null
    },
    execution: {
      controlPlaneInternalUrl: parsed.data.CONTROL_PLANE_INTERNAL_URL.replace(/\/$/, ""),
      taskSigningSecret: parsed.data.TASK_SIGNING_SECRET,
      codegenHarness: parsed.data.CODEGEN_HARNESS,
      codegenBackend: parsed.data.CODEGEN_EXECUTION_BACKEND,
      sandbox: {
        cacheDir: parsed.data.SANDBOX_CACHE_DIR,
        taskTimeoutSeconds: parsed.data.SANDBOX_TASK_TIMEOUT_SECONDS
      },
      kubernetes: {
        namespace: parsed.data.KUBERNETES_NAMESPACE,
        sandboxImage: parsed.data.SANDBOX_IMAGE,
        imagePullPolicy: parsed.data.SANDBOX_IMAGE_PULL_POLICY,
        serviceAccountName: parsed.data.SANDBOX_SERVICE_ACCOUNT_NAME,
        cpuRequest: parsed.data.SANDBOX_CPU_REQUEST,
        cpuLimit: parsed.data.SANDBOX_CPU_LIMIT,
        memoryRequest: parsed.data.SANDBOX_MEMORY_REQUEST,
        memoryLimit: parsed.data.SANDBOX_MEMORY_LIMIT,
        ttlSecondsAfterFinished: parsed.data.SANDBOX_TTL_SECONDS_AFTER_FINISHED,
        cachePvcName: parsed.data.SANDBOX_CACHE_PVC_NAME.trim() || null
      },
      codegenLease: {
        heartbeatMs: parsed.data.CODEGEN_LEASE_HEARTBEAT_SECONDS * 1000,
        staleMs: parsed.data.CODEGEN_LEASE_STALE_SECONDS * 1000,
        acquireTimeoutMs: parsed.data.CODEGEN_LEASE_ACQUIRE_TIMEOUT_SECONDS * 1000,
        acquirePollMs: parsed.data.CODEGEN_LEASE_ACQUIRE_POLL_SECONDS * 1000
      }
    },
    worker: {
      crawlEnabled: parsed.data.WORKER_CRAWL_ENABLED ?? defaults.workerCrawlEnabled,
      embeddingEnabled: parsed.data.WORKER_EMBEDDING_ENABLED ?? defaults.workerEmbeddingEnabled,
      taskEnabled: parsed.data.WORKER_TASK_ENABLED ?? defaults.workerTaskEnabled,
      discordAgentEnabled: parsed.data.WORKER_DISCORD_AGENT_ENABLED ?? defaults.workerDiscordAgentEnabled,
      retention: {
        eventsDays: parsed.data.RETENTION_EVENTS_DAYS,
        auditDays: parsed.data.RETENTION_AUDIT_DAYS,
        embeddingRunsDays: parsed.data.RETENTION_EMBEDDING_RUNS_DAYS,
        runtimeDays: parsed.data.RETENTION_RUNTIME_DAYS
      },
      memoryCompaction: {
        threshold: parsed.data.MEMORY_COMPACTION_THRESHOLD,
        keepRecent: parsed.data.MEMORY_COMPACTION_KEEP_RECENT
      }
    },
    crawlBatchSize: parsed.data.CRAWL_BATCH_SIZE,
    crawlFetchRetries: parsed.data.CRAWL_FETCH_RETRIES,
    crawlRetryBaseMs: parsed.data.CRAWL_RETRY_BASE_MS,
    crawlRetryMaxMs: parsed.data.CRAWL_RETRY_MAX_MS,
    crawlScheduleCron: parsed.data.CRAWL_SCHEDULE_CRON,
    maxHistoryResults: parsed.data.MAX_HISTORY_RESULTS,
    maxThreadSummaryMessages: parsed.data.MAX_THREAD_SUMMARY_MESSAGES,
    maxReplyChars: parsed.data.MAX_REPLY_CHARS,
    discordAgentResponseTimeoutMs: parsed.data.DISCORD_AGENT_RESPONSE_TIMEOUT_MS,
    agentPromptMaxConcurrency: parsed.data.AGENT_PROMPT_MAX_CONCURRENCY,
    budget: {
      userTurnsPerDay: parsed.data.BUDGET_USER_TURNS_PER_DAY,
      userImagesPerDay: parsed.data.BUDGET_USER_IMAGES_PER_DAY,
      userCodegenPerDay: parsed.data.BUDGET_USER_CODEGEN_PER_DAY,
      guildDailyUsd: parsed.data.BUDGET_GUILD_DAILY_USD
    },
    allowlists: {
      ownerUserId: parsed.data.BOT_OWNER_USER_ID.trim() || null,
      opsUserIds: parseCsvIds(parsed.data.OPS_ALLOWLIST_USER_IDS),
      imageToolsAllowlistOnly: parsed.data.IMAGE_TOOLS_ALLOWLIST_ONLY ?? defaults.imageToolsAllowlistOnly
    },
    chatTimeouts: {
      silenceMs: parsed.data.CHAT_SILENCE_TIMEOUT_MS,
      hardMs: parsed.data.CHAT_HARD_TIMEOUT_MS
    },
    spotify: {
      clientId: parsed.data.SPOTIFY_CLIENT_ID,
      clientSecret: parsed.data.SPOTIFY_CLIENT_SECRET,
      market: parsed.data.SPOTIFY_MARKET
    },
    payments: {
      walletEnabled: parsed.data.WALLET_ENABLED ?? defaults.walletEnabled,
      userWalletsEnabled: parsed.data.USER_WALLETS_ENABLED ?? defaults.userWalletsEnabled,
      balancesPublic: parsed.data.WALLET_BALANCES_PUBLIC ?? defaults.walletBalancesPublic,
      privyAppId: parsed.data.PRIVY_APP_ID?.trim() || null,
      privyAppSecret: parsed.data.PRIVY_APP_SECRET?.trim() || null,
      tempoNetwork: parsed.data.TEMPO_NETWORK,
      usdToken: parsed.data.TEMPO_USD_TOKEN,
      initialGrantUsd: parsed.data.WALLET_INITIAL_GRANT_USD
    },
    promptOverlayPath: parsed.data.PROMPT_OVERLAY_PATH,
    toolsetScoping: parsed.data.TOOLSET_SCOPING ?? defaults.toolsetScoping
  };
}

function parseCsvIds(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
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

export function missingPaymentConfig(config: AppConfig): string[] {
  const missing: string[] = [];
  if (!config.payments.privyAppId) missing.push("PRIVY_APP_ID");
  if (!config.payments.privyAppSecret) missing.push("PRIVY_APP_SECRET");
  return missing;
}

export function assertPaymentConfig(config: AppConfig): asserts config is AppConfig & {
  payments: AppConfig["payments"] & { privyAppId: string; privyAppSecret: string };
} {
  if (config.payments.userWalletsEnabled && !config.payments.walletEnabled) {
    throw new Error("USER_WALLETS_ENABLED requires WALLET_ENABLED");
  }
  if (config.payments.walletEnabled && config.payments.usdToken.toLowerCase() !== "usdc.e") {
    throw new Error("TEMPO_USD_TOKEN must be USDC.e so every wallet balance and transfer uses the same USD rail");
  }
  const missing = missingPaymentConfig(config);
  if (missing.length > 0) throw new Error(`Wallet payments are enabled but required configuration is missing: ${missing.join(", ")}`);
}

export function assertOpenRouterConfig(config: AppConfig): asserts config is AppConfig & {
  openRouter: AppConfig["openRouter"] & { apiKey: string };
} {
  if (!config.openRouter.apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for model calls.");
  }
}

export function assertTaskCallbackConfig(config: AppConfig): asserts config is AppConfig & {
  execution: AppConfig["execution"] & { taskSigningSecret: string };
} {
  if (!config.execution.taskSigningSecret) {
    throw new Error("TASK_SIGNING_SECRET is required for sandbox task callbacks.");
  }
}

export function assertExecutionConfig(config: AppConfig): asserts config is AppConfig & {
  execution: AppConfig["execution"] & { taskSigningSecret: string };
  openRouter: AppConfig["openRouter"] & { apiKey: string };
} {
  assertTaskCallbackConfig(config);
  const missing = [
    ["OPENROUTER_API_KEY", config.openRouter.apiKey]
  ].filter(([, value]) => !value);

  if (!hasGitHubTaskCredential(config)) {
    missing.push(["GITHUB_TOKEN or GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_APP_INSTALLATION_ID", ""]);
  }

  if (missing.length > 0) {
    throw new Error(`Missing required sandbox execution secret/config values: ${missing.map(([name]) => name).join(", ")}`);
  }

  parseGitHubRepository(config.github.repository);
}

export function hasGitHubTaskCredential(config: AppConfig) {
  return Boolean(
    config.github?.token ||
      (config.github?.appId?.trim() && config.github?.appPrivateKey?.trim() && config.github?.appInstallationId?.trim())
  );
}
