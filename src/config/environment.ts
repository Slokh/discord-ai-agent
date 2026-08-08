export type EnvironmentVariableGroup = "core" | "github" | "access" | "integration" | "deployment";

export type EnvironmentVariableDefinition = {
  name: string;
  group: EnvironmentVariableGroup;
  description: string;
  requiredFor: string;
  example?: string;
  secret?: boolean;
  operator?: boolean;
};

/** The only environment variables consumed by the application runtime. */
export const environmentVariables = [
  { name: "DISCORD_TOKEN", group: "core", description: "Discord bot token.", requiredFor: "Discord bot and worker roles", secret: true, operator: true },
  { name: "DISCORD_CLIENT_ID", group: "core", description: "Discord application ID.", requiredFor: "Discord bot and worker roles", operator: true },
  { name: "DISCORD_GUILD_ID", group: "core", description: "Private community guild ID.", requiredFor: "Discord bot and worker roles", operator: true },
  { name: "DATABASE_URL", group: "core", description: "Postgres connection string with pgvector available.", requiredFor: "all roles", example: "postgres://discord_ai_agent:discord_ai_agent@localhost:5433/discord_ai_agent", secret: true, operator: true },
  { name: "OPENROUTER_API_KEY", group: "core", description: "OpenRouter credential for model and provider-backed tools.", requiredFor: "agent execution", secret: true, operator: true },
  { name: "TASK_SIGNING_SECRET", group: "core", description: "Shared HMAC secret for isolated task callbacks.", requiredFor: "code updates", secret: true, operator: true },

  { name: "GITHUB_TOKEN", group: "github", description: "GitHub token used for code-update publication when an App is not configured.", requiredFor: "code updates (token mode)", secret: true, operator: true },
  { name: "GITHUB_APP_ID", group: "github", description: "GitHub App ID.", requiredFor: "code updates (App mode)", operator: true },
  { name: "GITHUB_APP_PRIVATE_KEY", group: "github", description: "GitHub App private key.", requiredFor: "code updates (App mode)", secret: true, operator: true },
  { name: "GITHUB_APP_INSTALLATION_ID", group: "github", description: "GitHub App installation ID.", requiredFor: "code updates (App mode)", operator: true },

  { name: "BOT_OWNER_USER_ID", group: "access", description: "Discord user ID with owner authority.", requiredFor: "owner-only mutations", operator: true },
  { name: "OPS_ALLOWLIST_USER_IDS", group: "access", description: "Comma-separated Discord user IDs with operations authority.", requiredFor: "restricted operations", operator: true },
  { name: "DISCORD_PREMIUM_SKU_IDS", group: "access", description: "Comma-separated configured Discord premium SKU IDs.", requiredFor: "premium buttons", operator: true },

  { name: "SPOTIFY_CLIENT_ID", group: "integration", description: "Spotify application client ID.", requiredFor: "Spotify tools", operator: true },
  { name: "SPOTIFY_CLIENT_SECRET", group: "integration", description: "Spotify application client secret.", requiredFor: "Spotify tools", secret: true, operator: true },
  { name: "PRIVY_APP_ID", group: "integration", description: "Privy application ID; supplying both Privy values enables wallets.", requiredFor: "wallets", operator: true },
  { name: "PRIVY_APP_SECRET", group: "integration", description: "Privy application secret; supplying both Privy values enables wallets.", requiredFor: "wallets", secret: true, operator: true },

  { name: "NODE_ENV", group: "deployment", description: "Node runtime mode.", requiredFor: "runtime platform", example: "production" },
  { name: "APP_REVISION", group: "deployment", description: "Immutable deployed git revision.", requiredFor: "release workflow" },
  { name: "RELEASE_VERIFICATION_ID", group: "deployment", description: "Unique public identifier for this rollout's post-deploy promotion.", requiredFor: "release workflow" },
  { name: "PREVIOUS_APP_REVISION", group: "deployment", description: "Previously deployed git revision.", requiredFor: "release announcements" },
  { name: "DISCORD_BOT_CHANNEL_ID", group: "deployment", description: "Single Discord text channel for deployment announcements and improvement-report threads.", requiredFor: "deployment announcements and improvement conversations", operator: true },
  { name: "POD_NAMESPACE", group: "deployment", description: "Namespace where isolated code-update Jobs are created.", requiredFor: "Kubernetes worker" },
  { name: "SANDBOX_IMAGE", group: "deployment", description: "Immutable code-update sandbox image reference.", requiredFor: "Kubernetes worker" },
] as const satisfies readonly EnvironmentVariableDefinition[];

export const environmentVariableNames = new Set<string>(environmentVariables.map((definition) => definition.name));

/** Variables removed from the product contract; accepting them would hide deployment drift. */
export const retiredEnvironmentVariableNames = new Set([
  "AGENT_PROMPT_MAX_CONCURRENCY", "BOT_NAME", "CHAT_HARD_TIMEOUT_MS", "CHAT_SILENCE_TIMEOUT_MS",
  "CODEGEN_EXECUTION_BACKEND", "CONTROL_PLANE_INTERNAL_URL", "DISCORD_AGENT_RESPONSE_TIMEOUT_MS",
  "DISCORD_LOADING_REACTION", "GITHUB_BASE_BRANCH", "GITHUB_REPOSITORY", "IMAGE_TOOLS_ALLOWLIST_ONLY",
  "KUBERNETES_NAMESPACE", "MEMORY_COMPACTION_KEEP_RECENT", "MEMORY_COMPACTION_THRESHOLD",
  "OPENROUTER_CHAT_MODEL", "OPENROUTER_CODEGEN_MODEL", "OPENROUTER_EMBEDDING_MODEL", "OPENROUTER_IMAGE_MODEL",
  "OPENROUTER_TRANSCRIPTION_MODEL", "OPENROUTER_UTILITY_MODEL", "PROMPT_OVERLAY_PATH", "RETENTION_AUDIT_DAYS",
  "RETENTION_EMBEDDING_RUNS_DAYS", "RETENTION_EVENTS_DAYS", "RETENTION_RUNTIME_DAYS", "RUN_MIGRATIONS",
  "SANDBOX_CACHE_DIR", "SANDBOX_CACHE_PVC_NAME", "TEMPO_NETWORK", "TEMPO_USD_TOKEN", "USER_WALLETS_ENABLED",
  "WALLET_BALANCES_PUBLIC", "WALLET_ENABLED", "WALLET_INITIAL_GRANT_USD", "WORKER_TASK_ENABLED",
  "RELEASE_NOTES_CHANNEL_ID", "IMPROVEMENT_REPORT_CHANNEL_ID",
]);

export function assertNoRetiredEnvironmentVariables(env: NodeJS.ProcessEnv): void {
  const present = [...retiredEnvironmentVariableNames].filter((name) => env[name] !== undefined);
  if (present.length > 0) {
    throw new Error(
      `Removed environment variables are still configured: ${present.sort().join(", ")}. ` +
      "Delete them; stable product settings now live in src/config/env.ts.",
    );
  }
}
