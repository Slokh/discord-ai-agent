import { loadSkills, renderSkillsForPrompt } from "../skills/loader.js";
import { validateSkillMarkdown } from "../skills/policy.js";
import { slugify, summarizeForAudit } from "../util/text.js";
import type { ToolContext } from "./types.js";

export type SkillDraftInput = {
  skillName: string;
  instruction: string;
};

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
    const response = await ctx.openRouter.chat({
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
      maxTokens: 1000
    });
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
