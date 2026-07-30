import type { ToolGroup } from "../tools/registry.js";
import type { ScopedToolset } from "../tools/toolScope.js";

const GROUP_GUIDANCE: Partial<Record<ToolGroup, string>> = {
  "discord-retrieval":
    "For server knowledge, resolve ambiguous people or channels first, then retrieve focused evidence. Use agent memory only for what the bot previously said or did; use Discord retrieval for claims about members or messages. Refresh dates, counts, links, and quoted history before stating them as fact.",
  "generated-data":
    "For a file or table created in this turn, use the generated-data query tools for exact rows, counts, filters, and rankings instead of estimating from its name or visible preview.",
  presentation:
    "Use native Discord presentation only when the user asks for interactive or rich UI, or when it materially improves a multi-step result. Keep ordinary replies conversational.",
  "discord-action":
    "Use Discord actions only for explicit current-turn requests. Chance outcomes must come from the randomness tools; continue an active game only through its scoped durable state, never by inventing an outcome or a second wager.",
  image:
    "Inspect an attached, replied-to, or explicitly linked image before describing visual details. Fetch an avatar before inspecting it. Use image generation for requested new or edited images, keeping exact visible text in the tool input.",
  spotify:
    "Use the Spotify tools for catalog and playlist facts. Do not claim access to a user's library, listening history, recommendations, or audio features unless a tool result provides it.",
  codegen:
    "For repository, PR, CI, deployment, or self-update work, start the coding agent. Use task-status tools only for a direct status follow-up; do not substitute a speculative chat answer for repository investigation.",
  ops:
    "For questions about a bot failure, slowness, tool choice, or a replied run, inspect the scoped run logs. Treat model settings and other admin changes as explicit current-turn mutations.",
  external:
    "Use web tools for current public facts or when reading a user-provided URL would improve the answer. Search before making current claims; source freshness matters more than a plausible answer.",
};

export function scopedToolGuidance(groups: Iterable<ToolGroup>): string | undefined {
  const selected = [...new Set(groups)]
    .filter((group) => group !== "core")
    .sort()
    .map((group) => GROUP_GUIDANCE[group])
    .filter((guidance): guidance is string => Boolean(guidance));
  if (selected.length === 0) return undefined;
  return [
    "Scoped operational guidance for the tools available in this turn:",
    ...selected.map((guidance) => `- ${guidance}`),
    "If the needed capability is not currently available, request the relevant tool group instead of guessing.",
  ].join("\n");
}

export function scopedToolGuidanceForToolset(toolset: ScopedToolset): string | undefined {
  return scopedToolGuidance(toolset.groups);
}
