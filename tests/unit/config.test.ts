import { describe, expect, it } from "vitest";
import { assertConsoleAuthConfig, assertExecutionConfig, assertOpenRouterConfig, assertPaymentConfig, loadConfig, productConfig } from "../../src/config/env.js";

describe("config", () => {
  it("keeps stable product and architecture choices in source", () => {
    withCleanEnv(() => {
      const config = loadConfig();
      expect(config).toEqual(expect.objectContaining({
        processRole: "bot",
        appRevision: "unknown",
        runMigrations: true,
        embeddingDimensions: 1536,
        github: expect.objectContaining({ repository: productConfig.github.repository, baseBranch: "main" }),
        callbackServer: { host: "0.0.0.0", port: 8080 },
        consoleServer: { host: "0.0.0.0", port: 8081 },
        discordAgentResponseTimeoutMs: 1_800_000,
        agentPromptMaxConcurrency: 4
      }));
      expect(config.discord).toEqual(expect.objectContaining({ botName: "ai", loadingReaction: "⏳", premiumSkuIds: [] }));
      expect(config.consoleAuth).toEqual({
        publicUrl: "https://console.mindcool.dev",
        clientId: "",
        clientSecret: "",
        guildId: "",
        sessionSecret: "",
      });
      expect(config.openRouter).toEqual(expect.objectContaining({
        chatModel: "openai/gpt-5.6-terra",
        codegenModel: "openai/gpt-5.6-terra",
        utilityModel: "openai/gpt-5.6-terra"
      }));
      expect(config.execution).not.toHaveProperty("codegenBackend");
      expect(config.execution).not.toHaveProperty("codegenLease");
      expect(config.worker).toEqual(expect.objectContaining({
        crawlEnabled: true,
        embeddingEnabled: true,
        taskEnabled: false,
        agentRuntimeEnabled: true
      }));
      expect(config.payments).toEqual({
        walletEnabled: false,
        userWalletsEnabled: false,
        balancesPublic: true,
        privyAppId: null,
        privyAppSecret: null,
        tempoNetwork: "mainnet",
        usdToken: "USDC.e",
        initialGrantUsd: 0.1
      });
    });
  });

  it("loads only secrets, identity, and deployment-provided image/revision values", () => {
    withEnv({
      APP_REVISION: "abc123",
      RELEASE_VERIFICATION_ID: "run-1",
      PREVIOUS_APP_REVISION: "def456",
      DISCORD_BOT_CHANNEL_ID: "123456789012345678",
      DISCORD_PREMIUM_SKU_IDS: "123456789012345678,111111111111111111",
      POD_NAMESPACE: "test-namespace",
      SANDBOX_IMAGE: "registry.example/sandbox:abc123",
      SPOTIFY_CLIENT_ID: "spotify-client",
      SPOTIFY_CLIENT_SECRET: "spotify-secret",
      PRIVY_APP_ID: "privy-app",
      PRIVY_APP_SECRET: "privy-secret"
    }, () => {
      const config = loadConfig();
      expect(config.releaseNotes).toEqual({ verificationId: "run-1", previousRevision: "def456" });
      expect(config.discord.botChannelId).toBe("123456789012345678");
      expect(config.discord.premiumSkuIds).toEqual(["123456789012345678", "111111111111111111"]);
      expect(config.execution.kubernetes).toEqual(expect.objectContaining({
        namespace: "test-namespace",
        sandboxImage: "registry.example/sandbox:abc123"
      }));
      expect(config.spotify).toEqual({ clientId: "spotify-client", clientSecret: "spotify-secret", market: "US" });
      expect(config.payments).toEqual(expect.objectContaining({ walletEnabled: true, userWalletsEnabled: true }));
      expect(() => assertPaymentConfig(config)).not.toThrow();
    });
  });

  it("rejects removed tuning variables so deployment drift is visible", () => {
    withEnv({
      NODE_ENV: "production",
      OPENROUTER_CHAT_MODEL: "anthropic/claude-sonnet-5",
      GITHUB_REPOSITORY: "somewhere/else",
      CODEGEN_EXECUTION_BACKEND: "local-process",
      RELEASE_NOTES_CHANNEL_ID: "123456789012345678",
      IMPROVEMENT_REPORT_CHANNEL_ID: "123456789012345678",
      WORKER_TASK_ENABLED: "false",
      WALLET_BALANCES_PUBLIC: "false",
      TEMPO_NETWORK: "moderato"
    }, () => {
      expect(() => loadConfig()).toThrow(
        /Removed environment variables.*CODEGEN_EXECUTION_BACKEND.*GITHUB_REPOSITORY.*IMPROVEMENT_REPORT_CHANNEL_ID.*OPENROUTER_CHAT_MODEL.*RELEASE_NOTES_CHANNEL_ID/,
      );
    });
  });

  it("validates Discord premium SKU identifiers", () => {
    withEnv({ DISCORD_PREMIUM_SKU_IDS: "not-a-snowflake" }, () => {
      expect(() => loadConfig()).toThrow(/premium.*snowflakes/i);
    });
  });

  it("validates the canonical bot channel identifier", () => {
    withEnv({ DISCORD_BOT_CHANNEL_ID: "not-a-snowflake" }, () => {
      expect(() => loadConfig()).toThrow(/bot channel.*snowflake/i);
    });
  });

  it("requires model and execution credentials at their capability boundaries", () => {
    withCleanEnv(() => {
      const config = loadConfig();
      expect(() => assertOpenRouterConfig(config)).toThrow(/OPENROUTER_API_KEY/);
      expect(() => assertExecutionConfig(config)).toThrow(/TASK_SIGNING_SECRET/);
      expect(() => assertConsoleAuthConfig(config)).toThrow(/DISCORD_CLIENT_SECRET.*CONSOLE_SESSION_SECRET/);
    });
  });

  it("does not run migrations inside production application pods", () => {
    withEnv({
      NODE_ENV: "production",
      OPENROUTER_CHAT_MODEL: undefined,
      OPENROUTER_UTILITY_MODEL: undefined,
      GITHUB_REPOSITORY: undefined,
    }, () => expect(loadConfig().runMigrations).toBe(false));
  });
});

function withCleanEnv(callback: () => void) {
  withEnv({
    APP_REVISION: "",
    PREVIOUS_APP_REVISION: "",
    DISCORD_BOT_CHANNEL_ID: "",
    DISCORD_PREMIUM_SKU_IDS: "",
    DISCORD_CLIENT_SECRET: "",
    CONSOLE_SESSION_SECRET: "",
    PRIVY_APP_ID: "",
    PRIVY_APP_SECRET: "",
    POD_NAMESPACE: "",
    SANDBOX_IMAGE: "",
    OPENROUTER_API_KEY: "",
    TASK_SIGNING_SECRET: "",
    GITHUB_TOKEN: "",
    GITHUB_APP_ID: "",
    GITHUB_APP_PRIVATE_KEY: "",
    GITHUB_APP_INSTALLATION_ID: ""
  }, callback);
}

function withEnv(values: Record<string, string | undefined>, callback: () => void) {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
