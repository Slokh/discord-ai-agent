import { describe, expect, it } from "vitest";
import { loadSkills, renderSkillsForPrompt } from "../../src/skills/loader.js";

describe("skill prompt rendering", () => {
  it("renders only repository skills and uses a neutral truncation notice", async () => {
    const repo = {
      listEnabledDatabaseSkills: async () => [
        { name: "database-only", content: "# Database\n\nDo not load me.", version: 1 },
      ],
    };
    await expect(loadSkills({
      skillsDir: "/definitely/missing/skills",
      repo,
    } as never)).resolves.toEqual([]);

    const rendered = renderSkillsForPrompt([
      { name: "one", path: "skills/one.md", source: "repo", content: "A".repeat(200) },
      { name: "two", path: "skills/two.md", source: "repo", content: "B".repeat(200) },
    ], 180);

    expect(rendered.length).toBeLessThanOrEqual(180);
    expect(rendered).toContain("Additional repository skill context was truncated");
    expect(rendered).not.toContain("manageSkills");
  });
});
