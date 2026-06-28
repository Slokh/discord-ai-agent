export type SkillPolicyResult = {
  ok: boolean;
  reasons: string[];
};

const blockedPatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(DISCORD_TOKEN|OPENROUTER_API_KEY|GITHUB_TOKEN|DATABASE_URL|RAILWAY_TOKEN)\b/i, reason: "mentions sensitive secret env vars" },
  { pattern: /\b(api[_-]?key|access[_-]?token|password|private[_-]?key|secret)\b/i, reason: "appears to request or embed credentials" },
  { pattern: /disable (permission|privacy|access) (check|filter|control)/i, reason: "attempts to disable core permission controls" },
  { pattern: /\b(turn|shut) off\b.*\b(permission|privacy|access)\b.*\b(filter|filtering|check|control)s?\b/i, reason: "attempts to disable core permission controls" },
  { pattern: /\b(bypass|skip|remove)\b.*\b(permission|privacy|access)\b.*\b(check|filter|control)s?\b/i, reason: "attempts to bypass core permission controls" },
  { pattern: /ignore (all )?(previous|system|developer|core) instructions/i, reason: "attempts to override core instructions" },
  { pattern: /\b(override|bypass|disable)\b.*\b(core|safety|system|developer)\b.*\b(rule|instruction|policy)s?\b/i, reason: "attempts to override core safety rules" },
  { pattern: /reveal .*private channel/i, reason: "attempts to reveal private channel content" },
  { pattern: /run .*shell.*without/i, reason: "unsafe execution instruction" }
];

export function validateSkillMarkdown(markdown: string): SkillPolicyResult {
  const reasons = blockedPatterns.filter(({ pattern }) => pattern.test(markdown)).map(({ reason }) => reason);
  if (!/^#\s+/m.test(markdown)) reasons.push("skill must include a Markdown heading");
  if (markdown.trim().length < 20) reasons.push("skill is too short to be useful");
  if (markdown.length > 20_000) reasons.push("skill is too large for the local milestone");
  return { ok: reasons.length === 0, reasons };
}

export function isMarkdownOnlySkillPath(filePath: string) {
  return /^skills\/[a-z0-9][a-z0-9-]*\.md$/.test(filePath);
}
