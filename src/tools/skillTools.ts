import { loadSkills, renderSkillsForPrompt } from "../skills/loader.js";
import { runObservedModelCall } from "../agent/modelCallTelemetry.js";
import { validateSkillMarkdown } from "../skills/policy.js";
import { slugify, summarizeForAudit } from "../util/text.js";
import type { ToolContext } from "./types.js";

export type SkillDraftInput = {
  skillName: string;
  instruction: string;
};

export type ManageSkillsInput = {
  action: "list" | "enable" | "disable" | "delete";
  skillNames?: string[];
  all?: boolean;
  query?: string;
};

export async function manageSkills(ctx: ToolContext, input: ManageSkillsInput): Promise<string> {
  const databaseSkills = await ctx.repo.listDatabaseSkills({ includeDisabled: true });
  const query = input.query?.trim().toLowerCase();

  if (input.action === "list") {
    const repoSkills = await loadSkills();
    const byName = new Map<string, { name: string; source: string; enabled: boolean; version?: number; content: string }>(repoSkills.map((skill) => [skill.name, {
      name: skill.name,
      source: "repo",
      enabled: true,
      version: skill.version,
      content: skill.content,
    }]));
    for (const skill of databaseSkills) byName.set(skill.name, skill);
    const matches = [...byName.values()]
      .filter((skill) => !query || `${skill.name}\n${skill.content}`.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));
    await auditSkillManagement(ctx, input, { resultCount: matches.length });
    if (matches.length === 0) return query ? `No skills matched \`${input.query?.trim()}\`.` : "No skills are installed.";
    return [
      query ? `Skills matching \`${input.query?.trim()}\` (${matches.length}):` : `All skills (${matches.length}):`,
      ...matches.map((skill) => `- \`${skill.name}\` — ${skill.enabled ? "enabled" : "disabled"}, ${skill.source}${skill.version ? ` v${skill.version}` : ""}`),
    ].join("\n");
  }

  const requestedNames = input.all
    ? databaseSkills.map((skill) => skill.name)
    : [...new Set((input.skillNames ?? []).map((name) => name.trim()).filter(Boolean))];
  if (requestedNames.length === 0) return `Specify exact skillNames or set all=true to ${input.action} database skills.`;

  const databaseNames = new Map(databaseSkills.map((skill) => [skill.name.toLowerCase(), skill.name]));
  const found = requestedNames.map((name) => databaseNames.get(name.toLowerCase())).filter((name): name is string => Boolean(name));
  const missing = requestedNames.filter((name) => !databaseNames.has(name.toLowerCase()));
  const affected: string[] = [];
  for (const name of found) {
    const changed = input.action === "delete"
      ? await ctx.repo.deleteDatabaseSkill(name)
      : Boolean(await ctx.repo.setDatabaseSkillEnabled({ name, enabled: input.action === "enable", requesterId: ctx.userId }));
    if (changed) affected.push(name);
  }
  await auditSkillManagement(ctx, input, { affected, missing });
  const verb = input.action === "delete" ? "Deleted" : input.action === "enable" ? "Enabled" : "Disabled";
  return [
    affected.length > 0 ? `${verb} ${affected.length} database skill${affected.length === 1 ? "" : "s"}: ${affected.map((name) => `\`${name}\``).join(", ")}.` : `No database skills were ${verb.toLowerCase()}.`,
    missing.length > 0 ? `Not found: ${missing.map((name) => `\`${name}\``).join(", ")}.` : "",
  ].filter(Boolean).join("\n");
}

export async function createSkillFromRequest(ctx: ToolContext, input: SkillDraftInput): Promise<string> {
  const skillName = cleanSkillName(input.skillName);
  const instruction = input.instruction.trim();
  const request = instruction;
  if (!instruction) return "I need a durable instruction before I can save a skill.";

  const skills = await loadSkills({ repo: ctx.repo });
  const existingSkill = skills.find((skill) => skill.name === skillName);
  const existingSkills = renderSkillsForPrompt(skills, 4000);

  let markdown: string;
  if (ctx.config.openRouter.apiKey) {
    const response = await runObservedModelCall(ctx, { purpose: "skill_draft", chat: {
      messages: [
        {
          role: "system",
          content:
            "Draft a concise Markdown skill for Discord AI Agent. Skills are durable instructions/procedures, not raw secrets. " +
            "Return only Markdown. Include a top-level heading and practical bullet points. " +
            "When existing skill content is provided, update it instead of discarding useful prior instructions."
        },
        {
          role: "user",
          content: [
            `Requested by ${ctx.userDisplayName}: ${request}`,
            `Skill file target: skills/${skillName}.md`,
            `Instruction to incorporate: ${instruction}`,
            existingSkill ? `Existing target skill:\n${existingSkill.content}` : "Existing target skill: none",
            `Other existing skills:\n${existingSkills || "No existing skills."}`
          ].join("\n\n")
        }
      ],
      temperature: 0.2,
      maxTokens: 4096
    } });
    markdown = response.content.trim();
  } else {
    markdown = existingSkill
      ? `${existingSkill.content.trim()}\n\n## Update\n\nRequested by ${ctx.userDisplayName}.\n\n${instruction}\n`
      : `# ${skillName}\n\nRequested by ${ctx.userDisplayName}.\n\n${instruction}\n`;
  }

  const policy = validateSkillMarkdown(markdown);
  if (!policy.ok) {
    await ctx.repo.recordSkillChange({
      skillName,
      filePath: `database:${skillName}.md`,
      requesterId: ctx.userId,
      request,
      content: markdown,
      source: "database",
      merged: false,
      policyReasons: policy.reasons
    });

    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "createSkillDraft",
      argumentsSummary: summarizeForAudit({ request, skillName }),
      resultSummary: summarizeForAudit({ persisted: false, policyReasons: policy.reasons })
    });

    return `I drafted a skill, but it failed policy checks: ${policy.reasons.join("; ")}`;
  }

  const skill = await ctx.repo.upsertDatabaseSkill({
    name: skillName,
    content: markdown,
    requesterId: ctx.userId,
    request
  });

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "createSkillDraft",
    argumentsSummary: summarizeForAudit({ request, skillName }),
    resultSummary: summarizeForAudit({ persisted: true, source: skill.source, version: skill.version })
  });

  return `Saved private skill \`${skill.name}\` to the database (v${skill.version}).`;
}

function cleanSkillName(value: string) {
  return slugify(value).slice(0, 48) || "server-note";
}

async function auditSkillManagement(ctx: ToolContext, input: ManageSkillsInput, result: Record<string, unknown>) {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "manageSkills",
    argumentsSummary: summarizeForAudit(input),
    resultSummary: summarizeForAudit(result),
  });
}
