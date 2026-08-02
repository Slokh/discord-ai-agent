import type { AgentResponse, ToolContext } from "../tools/types.js";
import { toolRegistry } from "../tools/registry.js";
import { bindToolHandlers } from "../tools/toolDefinition.js";
import type { AgentToolRoute } from "./routerShared.js";
import { restrictedToolGate } from "./toolGate.js";
import { invalidToolCallResponse } from "../tools/toolContractValidation.js";
import { handlerDefinitions } from "../tools/handlers/index.js";

export { stringArgument, stringArrayArgument } from "../tools/handlers/arguments.js";

const localToolHandlers = bindToolHandlers(toolRegistry, handlerDefinitions);

export async function executeLocalToolRoute(ctx: ToolContext, route: AgentToolRoute, originalText: string): Promise<AgentResponse> {
  ctx.abortSignal?.throwIfAborted();
  const invalidArguments = invalidToolCallResponse({ ...route, config: ctx.config });
  if (invalidArguments) return invalidArguments;
  const gate = await restrictedToolGate(ctx, route.name);
  ctx.abortSignal?.throwIfAborted();
  if (!gate.allowed) return { content: gate.message, status: "error", errorCode: "tool_not_authorized", retryable: false };

  const handler = localToolHandlers[route.name];
  if (handler) return handler(ctx, route, originalText);

  return { content: `Tool ${route.name} is registered but has no local execution handler.`, status: "error", errorCode: "missing_tool_handler" };
}
