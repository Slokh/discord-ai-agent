import { toolByName, type ToolName } from "../tools/registry.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { previewText } from "../util/logger.js";
import { executeLocalToolRoute } from "./toolDispatcher.js";
import { toolRouteKey } from "./toolRepeatGuard.js";
import type { AgentToolRoute } from "./routerShared.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export async function executeIndependentToolRoutesInParallel(
  ctx: ToolContext,
  routes: AgentToolRoute[],
  successfulToolCallKeys: Set<string>,
  originalText: string,
) {
  const results = new Map<
    string,
    { result: AgentResponse; startedAt: number }
  >();
  const names = new Set<ToolName>();
  const eligible =
    routes.length > 1 &&
    routes.every((route) => {
      const tool = toolByName(route.name);
      if (
        !tool ||
        tool.mutates ||
        tool.group === "generated-data" ||
        route.name === "requestAdditionalTools"
      ) {
        return false;
      }
      if (
        names.has(route.name) ||
        successfulToolCallKeys.has(toolRouteKey(route))
      ) {
        return false;
      }
      names.add(route.name);
      return true;
    });
  if (!eligible) return results;

  await Promise.all(
    routes.map(async (route) => {
      const startedAt = Date.now();
      await recordAgentEvent(ctx, {
        eventName: "agent.tool.started",
        summary: route.name,
        metadata: {
          toolName: route.name,
          argumentsPreview: previewText(route.argumentsText, 300),
          parallel: true,
        },
      });
      const result = await executeLocalToolRoute(ctx, route, originalText);
      results.set(route.id, { result, startedAt });
    }),
  );
  return results;
}
