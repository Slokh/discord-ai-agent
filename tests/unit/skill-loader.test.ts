import { describe, expect, it } from "vitest";
import { renderSkillsForPrompt } from "../../src/skills/loader.js";

describe("skill prompt rendering", () => {
  it("warns the model not to treat truncated context as the complete inventory", () => {
    const rendered = renderSkillsForPrompt([
      { name: "one", path: "database:one", source: "database", content: "A".repeat(200) },
      { name: "two", path: "database:two", source: "database", content: "B".repeat(200) },
    ], 180);

    expect(rendered.length).toBeLessThanOrEqual(180);
    expect(rendered).toContain("Use manageSkills with action=list for the complete inventory");
  });
});
