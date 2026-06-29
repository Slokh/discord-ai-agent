import { describe, expect, it } from "vitest";
import { assertOpenRouterConfig, loadConfig } from "../../src/config/env.js";

describe("config", () => {
  it("loads defaults", () => {
    withEnvUnset(
      [
        "DISCORD_CLIENT_ID",
        "DISCORD_GUILD_ID",
        "BOT_NAME",
        "GITHUB_REPOSITORY",
        "GITHUB_DRY_RUN",
        "GITHUB_DRY_RUN_DIR",
        "RAILWAY_PROJECT_ID",
        "RAILWAY_ENVIRONMENT",
        "RAILWAY_LOG_OWNER_USER_IDS"
      ],
      () => {
        const config = loadConfig();
        expect(config.processRole).toBe("bot");
        expect(config.discord.clientId).toBe("");
        expect(config.discord.guildId).toBe("");
        expect(config.discord.botName).toBe("ai");
        expect(config.embeddingDimensions).toBe(1536);
        expect(config.github.repository).toBe("owner/discord-ai-agent");
        expect(config.github.dryRun).toBe(false);
        expect(config.github.dryRunDir).toBe(".discord-ai-agent/dry-runs");
        expect(config.railway.projectId).toBe("");
        expect(config.railway.environment).toBe("production");
        expect(config.railway.logOwnerUserIds).toEqual([]);
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

  it("accepts the Railway-native codegen process role", () => {
    withEnv({ DISCORD_AI_AGENT_PROCESS_ROLE: "codegen" }, () => {
      expect(loadConfig().processRole).toBe("codegen");
    });
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
