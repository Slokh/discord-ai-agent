import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { deploymentToolset } from "../../src/tools/toolScope.js";

describe("deployment toolset", () => {
  it("exposes one stable complete contract without a tool-expansion protocol", () => {
    const tools = deploymentToolset(loadConfig());
    const names = tools.localTools.map((tool) => tool.name);
    expect(names).toContain("loadSkillContext");
    expect(names.map(String)).not.toContain("composeDiscordResponse");
    expect(names).toContain("drawRandom");
    expect(names).toContain("web__run");
    expect(names).not.toContain("requestAdditionalTools");
  });
});
