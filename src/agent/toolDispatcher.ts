import type { AgentResponse, ToolContext } from "../tools/types.js";
import { toolByName, toolRegistry } from "../tools/registry.js";
import { bindToolHandlers } from "../tools/toolDefinition.js";
import type { AgentToolRoute } from "./routerShared.js";
import { restrictedToolGate } from "./toolGate.js";
import { invalidToolCallResponse } from "../tools/toolContractValidation.js";
import { installedToolHandlers } from "../capabilities/catalog.js";
import { logger } from "../util/logger.js";

export { stringArgument, stringArrayArgument } from "../tools/handlers/arguments.js";

const localToolHandlers = bindToolHandlers(toolRegistry, installedToolHandlers);

export async function executeLocalToolRoute(ctx: ToolContext, route: AgentToolRoute, originalText: string): Promise<AgentResponse> {
  ctx.abortSignal?.throwIfAborted();
  const invalidArguments = invalidToolCallResponse({ ...route, config: ctx.config });
  if (invalidArguments) return invalidArguments;
  const gate = await restrictedToolGate(ctx, route.name);
  ctx.abortSignal?.throwIfAborted();
  if (!gate.allowed) return { content: gate.message, status: "error", errorCode: "tool_not_authorized", retryable: false };

  const handler = localToolHandlers[route.name];
  if (handler) {
    try {
      return await handler(ctx, route, originalText);
    } catch (error) {
      if (ctx.abortSignal?.aborted || toolByName(route.name)?.mutates) throw error;
      logger.error(
        { err: error, toolName: route.name, callId: route.id },
        "Non-mutating tool failed; returning a typed limitation",
      );
      return {
        content:
          "The requested lookup failed before returning usable evidence. Briefly state that this part could not be completed. " +
          "Do not invent a result, expose internal error details, or retry the same lookup in this turn.",
        status: "error",
        errorCode: "tool_execution_failed",
        retryable: false,
        limitation: "The selected non-mutating capability failed before returning usable evidence.",
      };
    }
  }

  return { content: `Tool ${route.name} is registered but has no local execution handler.`, status: "error", errorCode: "missing_tool_handler" };
}
