import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import {
  capabilityIndexForModel,
  requestAdditionalToolGroups,
  scopedToolset,
  selectToolGroups,
} from "../../src/tools/toolScope.js";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("tool scoping", () => {
  it("keeps normal turns to discovery and external tools regardless of wording", () => {
    const config = loadConfig();
    for (const text of [
      "what happened in the server yesterday",
      "switch the chat model to moonshotai/kimi-k3",
      "draw a wizard eating nachos",
      "can you fix the bot test failure",
      "roll 1d4",
    ]) {
      expect([...selectToolGroups({ text, hasImageAttachments: false, config })].sort()).toEqual(["core", "external"]);
    }
  });

  it("uses only attachment facts for the initial retrieval and image scope", () => {
    const config = loadConfig();
    expect([...selectToolGroups({ text: "what is this", hasImageAttachments: false, hasFileAttachments: true, config })].sort())
      .toEqual(["core", "discord-retrieval", "external"]);
    expect([...selectToolGroups({ text: "hello", hasImageAttachments: true, config })].sort())
      .toEqual(["core", "discord-retrieval", "external", "image"]);
  });

  it("publishes a compact, deployment-aware capability index for model-led loading", () => {
    withEnv({ SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" }, () => {
      const index = capabilityIndexForModel(loadConfig());
      expect(index).toContain("discord-retrieval:");
      expect(index).toContain("discord-action:");
      expect(index).toContain("spotify:");
      expect(index).not.toContain("core:");
      expect(index).not.toContain("external:");
    });
  });

  it("keeps disabled deployment capabilities out of the index and expansion", () => {
    withEnv({ SPOTIFY_CLIENT_ID: "", SPOTIFY_CLIENT_SECRET: "" }, () => {
      const config = loadConfig();
      expect(capabilityIndexForModel(config)).not.toContain("spotify:");
      const tools = requestAdditionalToolGroups({
        requestedGroups: ["spotify"],
        currentGroups: new Set(["core", "external"]),
        config,
      });
      expect(tools.groups.has("spotify")).toBe(false);
      expect(tools.localTools.some((tool) => tool.group === "spotify")).toBe(false);
    });
  });

  it("loads exactly the capability group the model requested", () => {
    const config = loadConfig();
    const tools = requestAdditionalToolGroups({
      requestedGroups: ["discord-action"],
      currentGroups: new Set(["core", "external"]),
      config,
    });
    expect(tools.groups.has("discord-action")).toBe(true);
    expect(tools.groups.has("discord-retrieval")).toBe(false);
    expect(tools.localTools.some((tool) => tool.name === "drawRandom")).toBe(true);
    expect(tools.groups.has("discord-retrieval")).toBe(false);
  });

  it("allows an intentional all-capabilities request but rejects unknown group names", () => {
    const config = loadConfig();
    const all = requestAdditionalToolGroups({ currentGroups: new Set(["core", "external"]), config });
    expect(all.groups.has("discord-action")).toBe(true);
    expect(all.groups.has("image")).toBe(true);

    const invalid = requestAdditionalToolGroups({
      requestedGroups: ["not-a-capability"],
      currentGroups: new Set(["core", "external"]),
      config,
    });
    expect(invalid.groups).toEqual(new Set(["core", "external"]));
  });

  it("still applies deployment-specific tool schemas after model-led expansion", () => {
    withEnv({ DISCORD_PREMIUM_SKU_IDS: "123456789012345678" }, () => {
      const tools = scopedToolset({ config: loadConfig(), groups: new Set(["presentation"]) }).localTools;
      expect(JSON.stringify(tools.find((tool) => tool.name === "composeDiscordResponse")?.parameters)).toContain('"premium"');
    });
  });

  it("does not expose removed database-skill management tools", () => {
    const names = scopedToolset({ config: loadConfig(), groups: new Set(["core"]) }).localTools.map((tool) => tool.name);
    expect(names).toContain("loadSkillContext");
    expect(names).not.toContain("manageSkills");
    expect(names).not.toContain("createSkillDraft");
  });
});
