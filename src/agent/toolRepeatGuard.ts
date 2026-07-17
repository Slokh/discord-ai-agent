import type { AgentResponse, ToolContext } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import type { AgentToolRoute } from "./routerShared.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export async function skippedRedundantToolResult(
  ctx: ToolContext,
  input: { text: string; route: AgentToolRoute; toolUseCount: number },
): Promise<AgentResponse> {
  await recordAgentEvent(ctx, {
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "agentToolRepeatGuard",
      argumentsSummary: input.text,
      resultSummary: `skipped redundant ${input.route.name} call ${input.toolUseCount}: ${previewText(input.route.argumentsText, 200)}`,
    },
  });
  return {
    content: `Skipped redundant ${input.route.name} call. Use the earlier ${input.route.name} evidence already provided in this turn.`,
  };
}

export function toolRouteKey(route: AgentToolRoute): string {
  return `${route.name}:${JSON.stringify(canonicalToolArguments(route.arguments ?? {}))}`;
}

/**
 * Signature for detecting repeated tool results. Strips lines that echo the
 * model's arguments (question/query headers) so a rephrased search that
 * returns identical evidence still counts as a repeat.
 */
export function toolResultSignature(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^(Question|Effective query):/.test(line))
    .join("\n")
    .trim();
}

function canonicalToolArguments(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalToolArguments);
    if (items.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
      return [...items].sort((a, b) => String(a).localeCompare(String(b)));
    }
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalToolArguments(nested)]),
    );
  }
  return value ?? null;
}
