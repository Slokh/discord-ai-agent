import { describe, expect, it } from "vitest";
import { assertExecutionConfig, assertOpenRouterConfig, assertPaymentConfig, loadConfig } from "../../src/config/env.js";

describe("config", () => {
  it("loads defaults", () => {
    withEnvUnset(
      [
        "DISCORD_CLIENT_ID",
        "DISCORD_GUILD_ID",
        "APP_REVISION",
        "PREVIOUS_APP_REVISION",
        "RELEASE_NOTES_CHANNEL_ID",
        "BOT_NAME",
        "DISCORD_LOADING_REACTION",
        "DISCORD_PREMIUM_SKU_IDS",
        "RUN_MIGRATIONS",
        "OPENROUTER_CHAT_MODEL",
        "OPENROUTER_CODEGEN_MODEL",
        "OPENROUTER_UTILITY_MODEL",
        "GITHUB_REPOSITORY",
        "INTERNAL_API_HOST",
        "INTERNAL_API_PORT",
        "CONTROL_UI_AUTH_PASSWORD",
        "CONTROL_UI_PUBLIC_URL",
        "CONTROL_PLANE_INTERNAL_URL",
        "TASK_SIGNING_SECRET",
        "CODEGEN_HARNESS",
        "CODEGEN_EXECUTION_BACKEND",
        "KUBERNETES_NAMESPACE",
        "SANDBOX_IMAGE",
        "SANDBOX_CACHE_DIR",
        "SANDBOX_CACHE_PVC_NAME",
        "CODEGEN_LEASE_HEARTBEAT_SECONDS",
        "CODEGEN_LEASE_STALE_SECONDS",
        "CODEGEN_LEASE_ACQUIRE_TIMEOUT_SECONDS",
        "CODEGEN_LEASE_ACQUIRE_POLL_SECONDS",
        "WORKER_CRAWL_ENABLED",
        "WORKER_EMBEDDING_ENABLED",
        "WORKER_TASK_ENABLED",
        "WORKER_DISCORD_AGENT_ENABLED",
        "SPOTIFY_CLIENT_ID",
        "SPOTIFY_CLIENT_SECRET",
        "SPOTIFY_MARKET",
        "TOOLSET_SCOPING",
        "WALLET_ENABLED",
        "USER_WALLETS_ENABLED",
        "WALLET_BALANCES_PUBLIC",
        "PRIVY_APP_ID",
        "PRIVY_APP_SECRET",
        "TEMPO_USD_TOKEN"
      ],
      () => {
        const config = loadConfig();
        expect(config.processRole).toBe("bot");
        expect(config.appRevision).toBe("unknown");
        expect(config.releaseNotes).toEqual({ previousRevision: null, channelId: null });
        expect(config.discord.clientId).toBe("");
        expect(config.discord.guildId).toBe("");
        expect(config.discord.botName).toBe("ai");
        expect(config.discord.loadingReaction).toBe("⏳");
        expect(config.discord.premiumSkuIds).toEqual([]);
        expect(config.runMigrations).toBe(true);
        expect(config.embeddingDimensions).toBe(1536);
        expect(config.openRouter.chatModel).toBe("z-ai/glm-5.2");
        expect(config.openRouter.codegenModel).toBe("z-ai/glm-5.2");
        expect(config.openRouter.utilityModel).toBe("z-ai/glm-5.2");
        expect(config.github.repository).toBe("owner/repo");
        expect(config.internalApi.host).toBe("0.0.0.0");
        expect(config.internalApi.port).toBe(8080);
        expect(config.controlUi.authPassword).toBe("");
        expect(config.controlUi.publicUrl).toBeNull();
        expect(config.execution.controlPlaneInternalUrl).toBe("http://discord-ai-agent-api:8080");
        expect(config.execution.taskSigningSecret).toBe("");
        expect(config.execution.codegenHarness).toBe("opencode");
        expect(config.execution.codegenBackend).toBe("local-process");
        expect(config.execution.sandbox.cacheDir).toBe("/var/cache/discord-ai-agent");
        expect(config.execution.sandbox.taskTimeoutSeconds).toBe(1800);
        expect(config.execution.kubernetes.namespace).toBe("discord-ai-agent");
        expect(config.execution.kubernetes.sandboxImage).toBe("discord-ai-agent-sandbox:latest");
        expect(config.execution.kubernetes.cachePvcName).toBeNull();
        expect(config.execution.codegenLease).toEqual({
          heartbeatMs: 15_000,
          staleMs: 120_000,
          acquireTimeoutMs: 1_800_000,
          acquirePollMs: 5_000
        });
        expect(config.worker).toEqual({
          crawlEnabled: true,
          embeddingEnabled: true,
          taskEnabled: true,
          discordAgentEnabled: true,
          retention: {
            eventsDays: 60,
            auditDays: 90,
            embeddingRunsDays: 14,
            runtimeDays: 90
          },
          memoryCompaction: {
            threshold: 100,
            keepRecent: 30
          }
        });
        expect(config.spotify).toEqual({
          clientId: "",
          clientSecret: "",
          market: "US"
        });
        expect(config.discordAgentResponseTimeoutMs).toBe(1_800_000);
        expect(config.agentPromptMaxConcurrency).toBe(4);
        expect(config.toolsetScoping).toBe(true);
        expect(config.crawlFetchRetries).toBe(3);
        expect(config.crawlRetryBaseMs).toBe(1000);
        expect(config.crawlRetryMaxMs).toBe(30_000);
        expect(config.payments).toEqual({
          walletEnabled: false,
          userWalletsEnabled: false,
          balancesPublic: false,
          privyAppId: null,
          privyAppSecret: null,
          tempoNetwork: "moderato",
          usdToken: "USDC.e",
          initialGrantUsd: 1
        });
      }
    );
  });

  it("throws when OpenRouter is required but missing", () => {
    const config = loadConfig();
    if (config.openRouter.apiKey) return;
    expect(() => assertOpenRouterConfig(config)).toThrow(/OPENROUTER_API_KEY/);
  });

  it("requires Privy credentials when payment features are enabled", () => {
    withEnvUnset(["PRIVY_APP_ID", "PRIVY_APP_SECRET"], () => {
      withEnv({ WALLET_ENABLED: "true" }, () => {
        expect(() => assertPaymentConfig(loadConfig())).toThrow(/PRIVY_APP_ID, PRIVY_APP_SECRET/);
      });
    });
  });

  it("validates user-wallet dependencies", () => {
    withEnv({ WALLET_ENABLED: "false", USER_WALLETS_ENABLED: "true", PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "secret" }, () => {
      expect(() => assertPaymentConfig(loadConfig())).toThrow(/USER_WALLETS_ENABLED requires WALLET_ENABLED/);
    });
  });

  it("allows opting into a public server wallet directory", () => {
    withEnv({ WALLET_BALANCES_PUBLIC: "true" }, () => {
      expect(loadConfig().payments.balancesPublic).toBe(true);
    });
  });

  it("requires USDC.e as the single wallet USD rail", () => {
    withEnv({ WALLET_ENABLED: "true", TEMPO_USD_TOKEN: "pathUSD", PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "secret" }, () => {
      expect(() => assertPaymentConfig(loadConfig())).toThrow(/TEMPO_USD_TOKEN must be USDC\.e/);
    });
  });

  it("accepts the internal API process role", () => {
    withEnv({ DISCORD_AI_AGENT_PROCESS_ROLE: "api" }, () => {
      expect(loadConfig().processRole).toBe("api");
    });
  });

  it("allows configuring the Discord response timeout", () => {
    withEnv({ DISCORD_AGENT_RESPONSE_TIMEOUT_MS: "900000" }, () => {
      expect(loadConfig().discordAgentResponseTimeoutMs).toBe(900_000);
    });
  });

  it("includes the deployed application revision", () => {
    withEnv({ APP_REVISION: "abc123", PREVIOUS_APP_REVISION: "def456", RELEASE_NOTES_CHANNEL_ID: "123" }, () => {
      expect(loadConfig()).toEqual(expect.objectContaining({
        appRevision: "abc123",
        releaseNotes: { previousRevision: "def456", channelId: "123" }
      }));
    });
  });

  it("rejects embedding dimensions that do not match the migrated vector index", () => {
    withEnv({ EMBEDDING_DIMENSIONS: "3072" }, () => {
      expect(() => loadConfig()).toThrow(/must remain 1536/);
    });
  });

  it("allows disabling toolset scoping", () => {
    withEnv({ TOOLSET_SCOPING: "false" }, () => {
      expect(loadConfig().toolsetScoping).toBe(false);
    });
  });

  it("treats empty optional string env values as unset so defaults apply", () => {
    withEnv({ SPOTIFY_MARKET: "", DISCORD_LOADING_REACTION: "" }, () => {
      const config = loadConfig();
      expect(config.spotify.market).toBe("US");
      expect(config.discord.loadingReaction).toBe("⏳");
    });
  });

  it("allows configuring the Discord loading reaction", () => {
    withEnv({ DISCORD_LOADING_REACTION: "<a:loading:123456789012345678>" }, () => {
      expect(loadConfig().discord.loadingReaction).toBe("<a:loading:123456789012345678>");
    });
  });

  it("validates and parses configured Discord premium SKU capabilities", () => {
    withEnv({ DISCORD_PREMIUM_SKU_IDS: "123456789012345678, 223456789012345678" }, () => {
      expect(loadConfig().discord.premiumSkuIds).toEqual(["123456789012345678", "223456789012345678"]);
    });
    withEnv({ DISCORD_PREMIUM_SKU_IDS: "not-a-snowflake" }, () => {
      expect(() => loadConfig()).toThrow(/premium.*snowflakes/i);
    });
  });

  it("allows codegen to use a different model than normal chat", () => {
    withEnv({ OPENROUTER_CHAT_MODEL: "z-ai/glm-5.2", OPENROUTER_CODEGEN_MODEL: "openai/gpt-5.5" }, () => {
      const config = loadConfig();
      expect(config.openRouter.chatModel).toBe("z-ai/glm-5.2");
      expect(config.openRouter.codegenModel).toBe("openai/gpt-5.5");
    });
  });

  it("allows utility calls to use a different model than normal chat", () => {
    withEnv({ OPENROUTER_CHAT_MODEL: "z-ai/glm-5.2", OPENROUTER_UTILITY_MODEL: "openai/gpt-4o-mini" }, () => {
      const config = loadConfig();
      expect(config.openRouter.chatModel).toBe("z-ai/glm-5.2");
      expect(config.openRouter.utilityModel).toBe("openai/gpt-4o-mini");
    });
  });

  it("allows selecting the kubernetes-job codegen backend", () => {
    withEnv({ CODEGEN_EXECUTION_BACKEND: "kubernetes-job" }, () => {
      expect(loadConfig().execution.codegenBackend).toBe("kubernetes-job");
    });
  });

  it("allows selecting the OpenCode codegen harness", () => {
    withEnv({ CODEGEN_HARNESS: "opencode" }, () => {
      expect(loadConfig().execution.codegenHarness).toBe("opencode");
    });
  });

  it("allows tuning warm codegen lease timings", () => {
    withEnv(
      {
        CODEGEN_LEASE_HEARTBEAT_SECONDS: "10",
        CODEGEN_LEASE_STALE_SECONDS: "45",
        CODEGEN_LEASE_ACQUIRE_TIMEOUT_SECONDS: "90",
        CODEGEN_LEASE_ACQUIRE_POLL_SECONDS: "3"
      },
      () => {
        expect(loadConfig().execution.codegenLease).toEqual({
          heartbeatMs: 10_000,
          staleMs: 45_000,
          acquireTimeoutMs: 90_000,
          acquirePollMs: 3_000
        });
      }
    );
  });

  it("allows splitting worker queues across deployments", () => {
    withEnv(
      {
        WORKER_CRAWL_ENABLED: "false",
        WORKER_EMBEDDING_ENABLED: "0",
        WORKER_TASK_ENABLED: "true",
        WORKER_DISCORD_AGENT_ENABLED: "no"
      },
      () => {
        expect(loadConfig().worker).toEqual({
          crawlEnabled: false,
          embeddingEnabled: false,
          taskEnabled: true,
          discordAgentEnabled: false,
          retention: {
            eventsDays: 60,
            auditDays: 90,
            embeddingRunsDays: 14,
            runtimeDays: 90
          },
          memoryCompaction: {
            threshold: 100,
            keepRecent: 30
          }
        });
      }
    );
  });

  it("normalizes the public control UI URL", () => {
    withEnv({ CONTROL_UI_PUBLIC_URL: "https://agent.example/" }, () => {
      expect(loadConfig().controlUi.publicUrl).toBe("https://agent.example");
    });
  });

  it("loads optional Spotify client-credentials settings", () => {
    withEnv(
      {
        SPOTIFY_CLIENT_ID: "spotify-client",
        SPOTIFY_CLIENT_SECRET: "spotify-secret",
        SPOTIFY_MARKET: "GB"
      },
      () => {
        expect(loadConfig().spotify).toEqual({
          clientId: "spotify-client",
          clientSecret: "spotify-secret",
          market: "GB"
        });
      }
    );
  });

  it("rejects placeholder GitHub repositories for sandbox execution", () => {
    withEnv(
      {
        OPENROUTER_API_KEY: "sk-test",
        TASK_SIGNING_SECRET: "secret",
        GITHUB_TOKEN: "github-token",
        GITHUB_REPOSITORY: "owner/repo"
      },
      () => {
        expect(() => assertExecutionConfig(loadConfig())).toThrow(/placeholder/i);
      }
    );
  });
});

function withEnv(values: Record<string, string>, callback: () => void) {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function withEnvUnset(names: string[], callback: () => void) {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
