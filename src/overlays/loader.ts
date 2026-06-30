import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

export type LoadedOverlayPrompt = {
  root: string;
  path: string;
  content: string;
};

export type LoadedOverlaySkill = {
  name: string;
  path: string;
  content: string;
};

export async function loadOverlaySystemPrompts(overlayDirs: string[] = []): Promise<LoadedOverlayPrompt[]> {
  const prompts: LoadedOverlayPrompt[] = [];
  for (const root of overlayDirs) {
    const promptPath = path.join(root, "services", "sandbox", "SYSTEM_PROMPT.md");
    const content = await readOptionalFile(promptPath);
    if (!content?.trim()) continue;
    prompts.push({
      root,
      path: promptPath,
      content: content.trim()
    });
  }
  return prompts;
}

export async function loadOverlaySkills(overlayDirs: string[] = []): Promise<LoadedOverlaySkill[]> {
  const skills: LoadedOverlaySkill[] = [];
  for (const root of overlayDirs) {
    skills.push(...(await loadFlatSkills(root)));
    skills.push(...(await loadAgentSkills(root)));
  }
  return skills;
}

export async function describeOverlays(overlayDirs: string[] = []) {
  const descriptions: Array<{
    root: string;
    exists: boolean;
    systemPrompt: boolean;
    skillCount: number;
  }> = [];

  for (const root of overlayDirs) {
    const exists = await pathExists(root);
    descriptions.push({
      root,
      exists,
      systemPrompt: exists && Boolean(await readOptionalFile(path.join(root, "services", "sandbox", "SYSTEM_PROMPT.md"))),
      skillCount: exists ? (await loadOverlaySkills([root])).length : 0
    });
  }

  return descriptions;
}

async function loadFlatSkills(root: string): Promise<LoadedOverlaySkill[]> {
  const skillsDir = path.join(root, "skills");
  const files = await readDirOptional(skillsDir);
  const skills: LoadedOverlaySkill[] = [];

  for (const file of files.filter((item) => item.endsWith(".md")).sort()) {
    const skillPath = path.join(skillsDir, file);
    const content = await readOptionalFile(skillPath);
    if (!content?.trim()) continue;
    skills.push({
      name: extractSkillName(content) ?? file.replace(/\.md$/, ""),
      path: skillPath,
      content
    });
  }

  return skills;
}

async function loadAgentSkills(root: string): Promise<LoadedOverlaySkill[]> {
  const skillsDir = path.join(root, ".agents", "skills");
  const entries = await readDirOptional(skillsDir, { withFileTypes: true });
  const skills: LoadedOverlaySkill[] = [];

  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    const content = await readOptionalFile(skillPath);
    if (!content?.trim()) continue;
    skills.push({
      name: extractSkillName(content) ?? entry.name,
      path: skillPath,
      content
    });
  }

  return skills;
}

function extractSkillName(content: string): string | undefined {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  const source = frontmatter?.[1] ?? "";
  const name = source.match(/^name:\s*["']?([^"'\n#]+)["']?\s*$/im)?.[1]?.trim();
  return name || undefined;
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function readDirOptional(dirPath: string): Promise<string[]>;
async function readDirOptional(dirPath: string, options: { withFileTypes: true }): Promise<Dirent[]>;
async function readDirOptional(dirPath: string, options?: { withFileTypes: true }): Promise<string[] | Dirent[]> {
  try {
    return options ? await fs.readdir(dirPath, options) : await fs.readdir(dirPath);
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}
