import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { DiscordAiAgentRepository } from "../src/db/repositories.js";

type SkillExport = {
  exportedAt: string;
  skills: Array<{ name: string; content: string; enabled: boolean; version: number }>;
};

async function main() {
  const config = loadConfig();
  const pool = createPool(config);
  const repo = new DiscordAiAgentRepository(pool);

  try {
    const [command = "help", ...args] = process.argv.slice(2);
    if (command === "list") {
      const includeDisabled = args.includes("--all");
      const skills = await repo.listDatabaseSkills({ includeDisabled });
      for (const skill of skills) {
        process.stdout.write(`${skill.enabled ? "enabled" : "disabled"} ${skill.name} v${skill.version} updated=${skill.updatedAt.toISOString()}\n`);
      }
      if (skills.length === 0) process.stdout.write("No database skills found.\n");
    } else if (command === "export") {
      const outputPath = path.resolve(args[0] ?? ".discord-ai-agent/skills-export.json");
      const skills = await repo.listDatabaseSkills({ includeDisabled: true });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      const payload: SkillExport = {
        exportedAt: new Date().toISOString(),
        skills: skills.map((skill) => ({
          name: skill.name,
          content: skill.content,
          enabled: skill.enabled,
          version: skill.version
        }))
      };
      await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      process.stdout.write(`Exported ${skills.length} database skills to ${outputPath}\n`);
    } else if (command === "import") {
      const inputPath = requireArg(args[0], "import requires a JSON export file path.");
      const payload = JSON.parse(await fs.readFile(path.resolve(inputPath), "utf8")) as SkillExport;
      for (const skill of payload.skills ?? []) {
        await repo.upsertDatabaseSkill({
          name: skill.name,
          content: skill.content,
          requesterId: "skills-import",
          request: `Imported from ${inputPath}`
        });
        if (!skill.enabled) {
          await repo.setDatabaseSkillEnabled({ name: skill.name, enabled: false, requesterId: "skills-import" });
        }
      }
      process.stdout.write(`Imported ${payload.skills?.length ?? 0} database skills from ${inputPath}\n`);
    } else if (command === "enable" || command === "disable") {
      const name = requireArg(args[0], `${command} requires a skill name.`);
      const skill = await repo.setDatabaseSkillEnabled({ name, enabled: command === "enable", requesterId: "skills-cli" });
      process.stdout.write(skill ? `${command === "enable" ? "Enabled" : "Disabled"} ${name}.\n` : `No database skill named ${name}.\n`);
    } else if (command === "delete") {
      const name = requireArg(args[0], "delete requires a skill name.");
      const deleted = await repo.deleteDatabaseSkill(name);
      process.stdout.write(deleted ? `Deleted ${name}.\n` : `No database skill named ${name}.\n`);
    } else {
      printUsage();
      if (command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 1;
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function requireArg(value: string | undefined, message: string) {
  if (!value) throw new Error(message);
  return value;
}

function printUsage() {
  process.stdout.write(`Usage:
  npm run skills -- list [--all]
  npm run skills -- export [path]
  npm run skills -- import <path>
  npm run skills -- enable <name>
  npm run skills -- disable <name>
  npm run skills -- delete <name>
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

