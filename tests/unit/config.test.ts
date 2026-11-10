import { describe, expect, it } from "vitest";
import { assertConsoleAuthConfig, assertOpenRouterConfig, assertPaymentConfig, loadConfig } from "../../src/config/env.js";

describe("config", () => {
  it("keeps stable product and architecture choices in source", () => {
    withCleanEnv(() => {
      const config = loadConfig();
      expect(config).toEqual(expect.objectContaining({
        processRole: "bot",
        appRevision: "unknown",
        runMigrations: true,
        embeddingDimensions: 1536,
        consoleServer: { host: "0.0.0.0", port: 8081 },
        discordAgentResponseTimeoutMs: 1_800_000,
        agentPromptMaxConcurrency: 4
      }));
      expect(config.discord).toEqual(expect.objectContaining({ botName: "ai", loadingReaction: "⏳" }));
      expect(config.discord).not.toHaveProperty("botChannelId");
      expect(config.discord).not.toHaveProperty("premiumSkuIds");
      for (const retired of ["execution", "github", "callbackServer", "spotify"]) {
        expect(config).not.toHaveProperty(retired);
      }
      expect(config.consoleAuth).toEqual({
        publicUrl: "https://console.mindcool.dev",
        clientId: "",
        clientSecret: "",
        guildId: "",
        sessionSecret: "",
      });
      expect(config.openRouter).toEqual(expect.objectContaining({
        chatModel: "openai/gpt-6-luna",
        utilityModel: "openai/gpt-6-luna"
      }));
      expect(config.openRouter).not.toHaveProperty("codegenModel");
      expect(config.worker).toEqual(expect.objectContaining({
        crawlEnabled: true,
        embeddingEnabled: false,
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
      PRIVY_APP_ID: "privy-app",
      PRIVY_APP_SECRET: "privy-secret"
    }, () => {
      const config = loadConfig();
      expect(config.releaseNotes).toEqual({ verificationId: "run-1", previousRevision: "def456" });
      expect(config.payments).toEqual(expect.objectContaining({ walletEnabled: true, userWalletsEnabled: true }));
      expect(() => assertPaymentConfig(config)).not.toThrow();
    });
  });

  it("ignores stale retired variables outside production", () => {
    withEnv({
      NODE_ENV: "development",
      DISCORD_BOT_CHANNEL_ID: "123456789012345678",
      DISCORD_PREMIUM_SKU_IDS: "123456789012345678",
      SPOTIFY_CLIENT_ID: "spotify-client",
      TASK_SIGNING_SECRET: "secret",
    }, () => {
      const config = loadConfig();
      expect(config.discord).not.toHaveProperty("botChannelId");
      expect(config).not.toHaveProperty("spotify");
      expect(config).not.toHaveProperty("execution");
    });
  });

  it("rejects removed tuning variables so deployment drift is visible", () => {
    withEnv({
      NODE_ENV: "production",
      DISCORD_BOT_CHANNEL_ID: "123456789012345678",
      SPOTIFY_CLIENT_ID: "spotify-client",
      TASK_SIGNING_SECRET: "secret",
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
        /Removed environment variables.*CODEGEN_EXECUTION_BACKEND.*DISCORD_BOT_CHANNEL_ID.*GITHUB_REPOSITORY.*IMPROVEMENT_REPORT_CHANNEL_ID.*OPENROUTER_CHAT_MODEL.*RELEASE_NOTES_CHANNEL_ID.*SPOTIFY_CLIENT_ID.*TASK_SIGNING_SECRET/,
      );
    });
  });

  it("requires model and console credentials at their capability boundaries", () => {
    withCleanEnv(() => {
      const config = loadConfig();
      expect(() => assertOpenRouterConfig(config)).toThrow(/OPENROUTER_API_KEY/);
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
    DISCORD_CLIENT_SECRET: "",
    CONSOLE_SESSION_SECRET: "",
    PRIVY_APP_ID: "",
    PRIVY_APP_SECRET: "",
    OPENROUTER_API_KEY: ""
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
