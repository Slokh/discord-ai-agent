import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { describeOverlays, loadOverlaySkills, loadOverlaySystemPrompts } from "../../src/overlays/loader.js";
import { loadSkills } from "../../src/skills/loader.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("filesystem overlays", () => {
  it("loads system prompt overlays in configured order", async () => {
    const first = await tempRoot();
    const second = await tempRoot();
    await writeFile(path.join(first, "services/sandbox/SYSTEM_PROMPT.md"), "First private prompt.\n");
    await writeFile(path.join(second, "services/sandbox/SYSTEM_PROMPT.md"), "Second private prompt.\n");

    const prompts = await loadOverlaySystemPrompts([first, second]);

    expect(prompts.map((prompt) => prompt.content)).toEqual(["First private prompt.", "Second private prompt."]);
    expect(prompts.map((prompt) => prompt.root)).toEqual([first, second]);
  });

  it("loads flat and agent-style skills from overlays", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "skills/movie-night.md"), "# Movie Night\n\nUse the movie poll.");
    await writeFile(
      path.join(root, ".agents/skills/server-tone/SKILL.md"),
      "---\nname: server-tone\ndescription: Tone rules.\n---\n\n# Server Tone\n\nBe direct."
    );

    const skills = await loadOverlaySkills([root]);

    expect(skills.map((skill) => ({ name: skill.name, relativePath: path.relative(root, skill.path) }))).toEqual([
      { name: "movie-night", relativePath: "skills/movie-night.md" },
      { name: "server-tone", relativePath: ".agents/skills/server-tone/SKILL.md" }
    ]);
  });

  it("applies repo, overlay, then database skill precedence", async () => {
    const skillsDir = await tempRoot();
    const overlay = await tempRoot();
    await writeFile(path.join(skillsDir, "persona.md"), "# Repo Persona\n\nRepo default.");
    await writeFile(path.join(overlay, "skills/persona.md"), "# Overlay Persona\n\nOverlay default.");
    await writeFile(path.join(overlay, "skills/private-bit.md"), "# Private Bit\n\nOverlay-only.");

    const skills = await loadSkills({
      skillsDir,
      overlayDirs: [overlay],
      repo: {
        listEnabledDatabaseSkills: async () => [{ name: "persona", content: "# DB Persona\n\nLive learned.", version: 3 }]
      }
    });

    expect(skills.find((skill) => skill.name === "persona")).toMatchObject({
      source: "database",
      content: "# DB Persona\n\nLive learned.",
      version: 3
    });
    expect(skills.find((skill) => skill.name === "private-bit")).toMatchObject({
      source: "overlay",
      content: "# Private Bit\n\nOverlay-only."
    });
  });

  it("describes mounted and missing overlays", async () => {
    const root = await tempRoot();
    const missing = path.join(root, "missing");
    await writeFile(path.join(root, "services/sandbox/SYSTEM_PROMPT.md"), "Private prompt.");
    await writeFile(path.join(root, "skills/example.md"), "# Example\n");

    await expect(describeOverlays([root, missing])).resolves.toEqual([
      {
        root,
        exists: true,
        systemPrompt: true,
        skillCount: 1
      },
      {
        root: missing,
        exists: false,
        systemPrompt: false,
        skillCount: 0
      }
    ]);
  });
});

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-ai-agent-overlay-"));
  tempRoots.push(root);
  return root;
}

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}
