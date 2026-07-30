import { describe, expect, it } from "vitest";
import { loadSkillContext, loadSkills, renderSkillInventoryForPrompt, renderSkillsForPrompt } from "../../src/skills/loader.js";

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

  it("renders a compact inventory and loads an exact named repository skill on demand", async () => {
    const skills = [
      { name: "deploy", path: "skills/deploy.md", source: "repo" as const, content: "# Deploy safely\n\nVerify the release before deployment." },
    ];
    expect(renderSkillInventoryForPrompt(skills)).toBe("- deploy: Deploy safely");

    const tempDir = await import("node:fs/promises").then(async ({ mkdtemp, writeFile }) => {
      const dir = await mkdtemp("/tmp/skill-loader-");
      await writeFile(`${dir}/deploy.md`, skills[0]!.content);
      return dir;
    });
    await expect(loadSkillContext("DEPLOY", { skillsDir: tempDir })).resolves.toMatchObject({ name: "deploy" });
    await expect(loadSkillContext("missing", { skillsDir: tempDir })).resolves.toBeNull();
  });
});
