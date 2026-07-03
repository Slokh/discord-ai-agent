import { slugify } from "../util/text.js";

const CODE_UPDATE_BRANCH_PREFIX = "ai";
const CODE_UPDATE_BRANCH_SLUG_MAX_CHARS = 40;
const CODE_UPDATE_BRANCH_SUFFIX_CHARS = 4;
const CODE_UPDATE_BRANCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "can",
  "for",
  "from",
  "in",
  "instead",
  "of",
  "on",
  "or",
  "please",
  "the",
  "to",
  "with",
  "you"
]);

export function codeUpdateBranchName(title: string, taskId?: string) {
  const suffix = codeUpdateBranchSuffix(taskId);
  const maxSlugChars = suffix
    ? Math.max(12, CODE_UPDATE_BRANCH_SLUG_MAX_CHARS - suffix.length - 1)
    : CODE_UPDATE_BRANCH_SLUG_MAX_CHARS;
  const slug = conciseBranchSlug(title, maxSlugChars) || "update";
  return `${CODE_UPDATE_BRANCH_PREFIX}/${suffix ? `${slug}-${suffix}` : slug}`;
}

export function codeUpdatePullRequestTitle(title: string) {
  const trimmed = title.trim().replace(/(?:--?retry)$/i, "").trim();
  const humanized = looksLikeKebabTitle(trimmed) ? trimmed.split("-").filter(Boolean).join(" ") : trimmed;
  const cleaned = humanized
    .replace(/\b(?:open|create|make)\s+(?:a\s+)?(?:github\s+)?(?:pull request|pr)\b[.!?]?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!cleaned) return "Agent update";
  return `${cleaned[0]?.toUpperCase() ?? ""}${cleaned.slice(1)}`;
}

export function codeUpdatePullRequestBody(input: { env: { taskRequest: string; requestedBy: string } }) {
  return [
    "## Why",
    "",
    input.env.taskRequest.trim(),
    "",
    "## Changes",
    "",
    "- Implemented by the Discord AI Agent sandbox.",
    "- See the PR diff for the exact code changes.",
    "",
    "## Testing",
    "",
    "- Agent ran focused checks in the sandbox where applicable.",
    "- `npm run scan:release`: passed",
    "- Full verification is handled by CI after the PR opens.",
    "",
    "---",
    "",
    `Prompted by: ${input.env.requestedBy}`
  ].join("\n");
}

function conciseBranchSlug(title: string, maxChars: number) {
  const words = slugify(codeUpdatePullRequestTitle(title))
    .split("-")
    .filter((word) => word && !CODE_UPDATE_BRANCH_STOP_WORDS.has(word));
  const slug = words.join("-") || slugify(title);
  return trimSlug(slug, maxChars);
}

function trimSlug(slug: string, maxChars: number) {
  if (slug.length <= maxChars) return slug;
  return slug.slice(0, maxChars).replace(/-[^-]*$/, "").replace(/^-+|-+$/g, "") || slug.slice(0, maxChars).replace(/^-+|-+$/g, "");
}

function codeUpdateBranchSuffix(taskId: string | undefined) {
  if (!taskId) return "";
  return taskId.replace(/[^a-z0-9]/gi, "").slice(-CODE_UPDATE_BRANCH_SUFFIX_CHARS).toLowerCase();
}

function looksLikeKebabTitle(value: string) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(value);
}
