import { describe, expect, it } from "vitest";
import { assertExecutionConfig, assertOpenRouterConfig, loadConfig } from "../../src/config/env.js";

describe("config", () => {
  it("loads defaults", () => {
    withEnvUnset(
      [
        "DISCORD_CLIENT_ID",
        "DISCORD_GUILD_ID",
        "BOT_NAME",
        "RUN_MIGRATIONS",
        "OPENROUTER_CHAT_MODEL",
        "OPENROUTER_CODEGEN_MODEL",
        "GITHUB_REPOSITORY",
        "INTERNAL_API_HOST",
        "INTERNAL_API_PORT",
        "CONTROL_UI_AUTH_PASSWORD",
        "CONTROL_UI_PUBLIC_URL",
        "CONTROL_PLANE_INTERNAL_URL",
        "TASK_SIGNING_SECRET",
        "KUBERNETES_NAMESPACE",
        "SANDBOX_IMAGE",
        "SANDBOX_CACHE_DIR",
        "SANDBOX_CACHE_PVC_NAME"
      ],
      () => {
        const config = loadConfig();
        expect(config.processRole).toBe("bot");
        expect(config.discord.clientId).toBe("");
        expect(config.discord.guildId).toBe("");
        expect(config.discord.botName).toBe("ai");
        expect(config.runMigrations).toBe(true);
        expect(config.embeddingDimensions).toBe(1536);
        expect(config.openRouter.chatModel).toBe("z-ai/glm-5.2");
        expect(config.openRouter.codegenModel).toBe("z-ai/glm-5.2");
        expect(config.github.repository).toBe("owner/repo");
        expect(config.internalApi.host).toBe("0.0.0.0");
        expect(config.internalApi.port).toBe(8080);
        expect(config.controlUi.authPassword).toBe("");
        expect(config.controlUi.publicUrl).toBeNull();
        expect(config.execution.controlPlaneInternalUrl).toBe("http://discord-ai-agent-api:8080");
        expect(config.execution.taskSigningSecret).toBe("");
        expect(config.execution.kubernetes.namespace).toBe("discord-ai-agent");
        expect(config.execution.kubernetes.sandboxImage).toBe("discord-ai-agent-sandbox:latest");
        expect(config.execution.kubernetes.cacheDir).toBe("/var/cache/discord-ai-agent");
        expect(config.execution.kubernetes.cachePvcName).toBeNull();
        expect(config.discordAgentResponseTimeoutMs).toBe(1_800_000);
        expect(config.crawlFetchRetries).toBe(3);
        expect(config.crawlRetryBaseMs).toBe(1000);
        expect(config.crawlRetryMaxMs).toBe(30_000);
      }
    );
  });

  it("throws when OpenRouter is required but missing", () => {
    const config = loadConfig();
    if (config.openRouter.apiKey) return;
    expect(() => assertOpenRouterConfig(config)).toThrow(/OPENROUTER_API_KEY/);
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

  it("allows codegen to use a different model than normal chat", () => {
    withEnv({ OPENROUTER_CHAT_MODEL: "z-ai/glm-5.2", OPENROUTER_CODEGEN_MODEL: "openai/gpt-5.5" }, () => {
      const config = loadConfig();
      expect(config.openRouter.chatModel).toBe("z-ai/glm-5.2");
      expect(config.openRouter.codegenModel).toBe("openai/gpt-5.5");
    });
  });

  it("normalizes the public control UI URL", () => {
    withEnv({ CONTROL_UI_PUBLIC_URL: "https://agent.example/" }, () => {
      expect(loadConfig().controlUi.publicUrl).toBe("https://agent.example");
    });
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
