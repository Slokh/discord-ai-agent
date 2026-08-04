import path from "node:path";
import { slugify } from "../util/text.js";

const CODE_UPDATE_BRANCH_PREFIX = "agent";
const CODE_UPDATE_BRANCH_SLUG_MAX_CHARS = 40;
const CODE_UPDATE_BRANCH_SUFFIX_CHARS = 4;
const MAX_PUBLIC_DIFF_CHARS = 40_000;
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

export type CodeUpdatePullRequestMetadata = {
  title: string;
  body: string;
  source: "diff_model" | "deterministic_fallback";
  model?: string;
  estimatedCostUsd?: number;
  fallbackReason?: string;
};

export type PullRequestMetadataCompletion = (input: {
  systemPrompt: string;
  userPrompt: string;
}) => Promise<{ content: string; model?: string; estimatedCostUsd?: number }>;

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

export async function codeUpdatePullRequestMetadata(input: {
  diffStat: string;
  diffPatch: string;
  complete: PullRequestMetadataCompletion;
}): Promise<CodeUpdatePullRequestMetadata> {
  const fallback = deterministicPullRequestMetadata(input.diffStat, input.diffPatch);
  const systemPrompt = [
    "Write accurate public GitHub pull-request metadata from a source-code diff.",
    "The diff is the only authority. Describe the behavior and implementation that actually changed.",
    "Do not mention task IDs, Discord message IDs, private improvement cases, agents, sandboxes, prompts, or workflow metadata.",
    "Avoid generic wording such as 'implement the requested change', 'update files', or 'add tests'.",
    "Return one JSON object with exactly these fields:",
    "- title: imperative, specific, no trailing punctuation, at most 72 characters",
    "- why: one concise sentence explaining the behavior or defect addressed",
    "- changes: an array of 1 to 4 concise implementation bullets",
  ].join("\n");
  const userPrompt = [
    "Diff stat:",
    input.diffStat.trim() || "(not available)",
    "",
    "Patch:",
    boundedPublicDiff(input.diffPatch),
  ].join("\n");

  try {
    const completion = await input.complete({ systemPrompt, userPrompt });
    const parsed = parsePullRequestMetadata(completion.content);
    if (!parsed) return { ...fallback, fallbackReason: "metadata model returned an invalid result" };
    return {
      title: parsed.title,
      body: renderPullRequestBody(parsed.why, parsed.changes),
      source: "diff_model",
      ...(completion.model ? { model: completion.model } : {}),
      ...(completion.estimatedCostUsd != null ? { estimatedCostUsd: completion.estimatedCostUsd } : {}),
    };
  } catch (error) {
    return {
      ...fallback,
      fallbackReason: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
    };
  }
}

export function deterministicPullRequestMetadata(diffStat: string, diffPatch: string): CodeUpdatePullRequestMetadata {
  const changedPaths = changedPathsFromPatch(diffPatch);
  const implementationPaths = changedPaths.filter((file) => !isSupportFile(file));
  const primaryPath = implementationPaths[0] ?? changedPaths[0] ?? "source";
  const title = `Improve ${humanizeSourcePath(primaryPath)}`.slice(0, 72).trimEnd();
  const listedPaths = changedPaths.slice(0, 4);
  const changes = listedPaths.length > 0
    ? listedPaths.map((file) => `Update \`${file}\` according to the resulting code diff.`)
    : ["Apply the implementation captured in the resulting code diff."];
  const extraCount = Math.max(0, changedPaths.length - listedPaths.length);
  if (extraCount > 0) changes.push(`Update ${extraCount} additional changed file${extraCount === 1 ? "" : "s"}.`);
  const statSummary = diffStat.trim().split("\n").at(-1)?.trim();
  const why = `Updates ${humanizeSourcePath(primaryPath)} based on the implementation that was actually produced${statSummary ? ` (${statSummary})` : ""}.`;
  return {
    title,
    body: renderPullRequestBody(why, changes),
    source: "deterministic_fallback",
  };
}

function renderPullRequestBody(why: string, changes: string[]) {
  return [
    "## Why",
    "",
    why,
    "",
    "## Changes",
    "",
    ...changes.map((change) => `- ${change}`),
    "",
    "## Testing",
    "",
    "- `npm run verify`: passed",
    "- Required pull-request checks run again on the published revision.",
  ].join("\n");
}

function parsePullRequestMetadata(content: string): { title: string; why: string; changes: string[] } | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  const title = singleLine(candidate.title, 72);
  const why = singleLine(candidate.why, 320);
  const changes = Array.isArray(candidate.changes)
    ? candidate.changes.map((change) => singleLine(change, 240)).filter((change): change is string => Boolean(change)).slice(0, 4)
    : [];
  if (
    !title
    || !why
    || changes.length === 0
  ) return null;
  return { title: title.replace(/[.!?]+$/g, ""), why, changes };
}

function singleLine(value: unknown, maxChars: number) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/^[-*#\s]+/, "").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxChars).trimEnd() : null;
}

function boundedPublicDiff(diffPatch: string) {
  if (diffPatch.length <= MAX_PUBLIC_DIFF_CHARS) return diffPatch.trim() || "(not available)";
  const sections = diffPatch.split(/(?=^diff --git )/m).filter((section) => section.trim());
  if (sections.length <= 1) return `${diffPatch.slice(0, MAX_PUBLIC_DIFF_CHARS).trimEnd()}\n\n[diff truncated]`;
  const marker = "\n\n[diff sampled across changed files]";
  const contentBudget = MAX_PUBLIC_DIFF_CHARS - marker.length;
  const selected = evenlySampleDiffSections(sections, Math.max(2, Math.floor(contentBudget / 200)));
  const sectionBudget = Math.max(1, Math.floor((contentBudget - selected.length * 2) / selected.length));
  const sampled = selected.map((section) => sampleDiffSection(section, sectionBudget)).join("\n\n");
  return `${sampled.slice(0, MAX_PUBLIC_DIFF_CHARS - marker.length).trimEnd()}${marker}`;
}

function evenlySampleDiffSections(sections: string[], limit: number) {
  if (sections.length <= limit) return sections;
  return Array.from({ length: limit }, (_, index) =>
    sections[Math.round(index * (sections.length - 1) / (limit - 1))]!,
  );
}

function sampleDiffSection(section: string, budget: number) {
  if (section.length <= budget) return section.trimEnd();
  const gap = "\n[section truncated]\n";
  const available = Math.max(1, budget - gap.length);
  const headChars = Math.ceil(available * 0.7);
  return `${section.slice(0, headChars).trimEnd()}${gap}${section.slice(-(available - headChars)).trimStart()}`;
}

function changedPathsFromPatch(diffPatch: string) {
  return [...diffPatch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]
    .map((match) => match[2]?.trim())
    .filter((file): file is string => Boolean(file));
}

function isSupportFile(file: string) {
  return /^(?:tests?|docs?)\//.test(file) || /(?:^|\/)(?:README|CHANGELOG)(?:\.|$)/i.test(file);
}

function humanizeSourcePath(file: string) {
  const basename = path.basename(file).replace(/\.(?:[cm]?[jt]sx?|json|md)$/i, "");
  const words = basename
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const label = words || "source behavior";
  return label
    .replace(/\bnanocodex\b/g, "NanoCodex")
    .replace(/\bpr\b/g, "PR")
    .replace(/^./, (character) => character.toUpperCase());
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
