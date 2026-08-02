import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { deploymentToolset } from "../../src/tools/toolScope.js";

describe("deployment toolset", () => {
  it("exposes one stable complete contract without a tool-expansion protocol", () => {
    const tools = deploymentToolset(loadConfig());
    const names = tools.localTools.map((tool) => tool.name);
    expect(names).toContain("loadSkillContext");
    expect(names).toContain("composeDiscordResponse");
    expect(names).toContain("drawRandom");
    expect(names).not.toContain("requestAdditionalTools");
  });

  it("still applies deployment-specific presentation schemas", () => {
    const previous = process.env.DISCORD_PREMIUM_SKU_IDS;
    process.env.DISCORD_PREMIUM_SKU_IDS = "123456789012345678";
    try {
      const tools = deploymentToolset(loadConfig());
      expect(JSON.stringify(tools.localTools.find((tool) => tool.name === "composeDiscordResponse")?.parameters))
        .toContain('"premium"');
    } finally {
      if (previous === undefined) delete process.env.DISCORD_PREMIUM_SKU_IDS;
      else process.env.DISCORD_PREMIUM_SKU_IDS = previous;
    }
  });
});
