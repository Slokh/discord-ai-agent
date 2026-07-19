import {
  toolByName,
  toolSupportsCsvFormat,
  type ToolName,
  type ToolRegistryEntry,
} from "../tools/registry.js";
import { previewText } from "../util/logger.js";
import type { AgentToolRoute } from "./routerShared.js";
import { coerceStructuredToolArgumentStrings, parseToolArgumentsWithMetadata } from "./toolArguments.js";

export function selectModelToolRoutes(
  toolCalls: Array<{ id: string; name: string; argumentsText: string }>,
  availableTools?: readonly ToolRegistryEntry[],
): AgentToolRoute[] {
  const routes: AgentToolRoute[] = [];
  for (const call of toolCalls) {
    const tool = availableTools?.find((candidate) => candidate.name === call.name) ?? toolByName(call.name);
    if (!tool) continue;
    const parsed = parseToolArgumentsWithMetadata(call.argumentsText);
    const parsedArguments = parsed.value;
    const coercedArguments = coerceStructuredToolArgumentStrings(
      parsedArguments,
      tool.parameters as Record<string, unknown>,
    );
    const argumentsNormalized = parsed.repaired || coercedArguments !== parsedArguments;
    routes.push({
      id: call.id,
      name: tool.name,
      arguments: coercedArguments,
      argumentsText: argumentsNormalized ? JSON.stringify(coercedArguments) : call.argumentsText,
      argumentsNormalized: argumentsNormalized || undefined,
    });
  }
  return routes;
}

export function coerceGeneratedCsvProducerRoutes(
  routes: AgentToolRoute[],
): AgentToolRoute[] {
  if (!routes.some((route) => route.name === "queryGeneratedCsv")) return routes;
  return routes.map((route) => {
    if (!toolSupportsCsvFormat(route.name)) return route;
    const existingFormat = typeof route.arguments?.format === "string"
      ? route.arguments.format.trim()
      : "";
    if (existingFormat) return route;
    const args = { ...(route.arguments ?? {}), format: "csv" };
    return { ...route, arguments: args, argumentsText: JSON.stringify(args) };
  });
}

/**
 * Pausing and settling are mutually exclusive state transitions. Models can
 * request multiple tools in one response, so keep the safe pause when both
 * transitions are proposed instead of executing a settlement against state
 * that was just persisted in the same Discord turn.
 */
export function selectExclusiveWagerTransition(
  routes: AgentToolRoute[],
): AgentToolRoute[] {
  const hasPause = routes.some((route) => route.name === "awaitRandomWagerAction");
  const hasSettlement = routes.some((route) => route.name === "settleRandomWager");
  if (!hasPause || !hasSettlement) return routes;
  return routes.filter((route) => route.name !== "settleRandomWager");
}

export function selectNextRoundToolChoice(input: {
  forceWagerResolution: boolean;
  forceToolUse: boolean;
  forcedWagerResolutionTool?: "awaitRandomWagerAction" | "settleRandomWager";
  initialForcedTool?: ToolName;
}) {
  if (input.forcedWagerResolutionTool) {
    return { type: "function" as const, function: { name: input.forcedWagerResolutionTool } };
  }
  if (input.forceWagerResolution) return "required" as const;
  if (input.initialForcedTool) {
    return { type: "function" as const, function: { name: input.initialForcedTool } };
  }
  return input.forceToolUse ? "required" as const : undefined;
}

export class WagerResolutionRouter {
  private forceResolution = false;
  private forcedTool: "awaitRandomWagerAction" | "settleRandomWager" | null = null;

  arm(forceResolution: boolean, forcedTool: "awaitRandomWagerAction" | "settleRandomWager" | null) {
    this.forceResolution = forceResolution;
    this.forcedTool = forceResolution ? forcedTool : null;
  }

  take(input: { forceToolUse: boolean; initialForcedTool?: ToolName }) {
    const forceResolution = this.forceResolution;
    const forcedTool = this.forcedTool;
    this.forceResolution = false;
    this.forcedTool = null;
    return {
      toolChoice: selectNextRoundToolChoice({
        forceWagerResolution: forceResolution,
        forcedWagerResolutionTool: forcedTool ?? undefined,
        ...input,
      }),
      forcedToolName: forcedTool ?? (forceResolution ? "wager_resolution" : input.initialForcedTool),
    };
  }
}

export function traceToolRequestMetadata(call: {
  id: string;
  name: string;
  argumentsText: string;
  argumentsNormalized?: boolean;
}) {
  return {
    id: call.id,
    name: call.name,
    argumentsText: previewText(call.argumentsText, 2_000),
    argumentsNormalized: call.argumentsNormalized || undefined,
  };
}
