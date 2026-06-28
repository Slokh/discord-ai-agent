import fs from "node:fs/promises";
import path from "node:path";

export type LoadedSkill = {
  name: string;
  path: string;
  content: string;
  source: "repo" | "database";
  version?: number;
};

export type DatabaseSkillStore = {
  listEnabledDatabaseSkills(): Promise<Array<{ name: string; content: string; version: number }>>;
};

export async function loadSkills(input: { skillsDir?: string; repo?: DatabaseSkillStore } = {}): Promise<LoadedSkill[]> {
  const skillsDir = input.skillsDir ?? path.resolve(process.cwd(), "skills");
  const byName = new Map<string, LoadedSkill>();

  for (const skill of await loadRepoSkills(skillsDir)) {
    byName.set(skill.name, skill);
  }

  if (input.repo && typeof input.repo.listEnabledDatabaseSkills === "function") {
    for (const skill of await input.repo.listEnabledDatabaseSkills()) {
      byName.set(skill.name, {
        name: skill.name,
        path: `database:${skill.name}`,
        content: skill.content,
        source: "database",
        version: skill.version
      });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function loadRepoSkills(skillsDir: string): Promise<LoadedSkill[]> {
  let files: string[];
  try {
    files = await fs.readdir(skillsDir);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const skills: LoadedSkill[] = [];
  for (const file of files.filter((item) => item.endsWith(".md")).sort()) {
    const fullPath = path.join(skillsDir, file);
    const content = await fs.readFile(fullPath, "utf8");
    skills.push({
      name: file.replace(/\.md$/, ""),
      path: fullPath,
      content,
      source: "repo"
    });
  }
  return skills;
}

export function renderSkillsForPrompt(skills: LoadedSkill[], maxChars = 8000): string {
  const rendered = skills.map((skill) => `# Skill: ${skill.name}\n${skill.content}`).join("\n\n---\n\n");
  return rendered.length <= maxChars ? rendered : rendered.slice(0, maxChars).trimEnd();
}
