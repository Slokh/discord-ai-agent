import type { AgentResponse, ToolContext } from "../tools/types.js";
import { toolRegistry, type ToolName } from "../tools/registry.js";
import { bindToolHandlers } from "../tools/toolDefinition.js";
import type { AgentToolRoute } from "./routerShared.js";
import { restrictedToolGate } from "./toolGate.js";
import { executeWalletToolRoute } from "./walletToolRoutes.js";
import { executeDiscordActionToolRoute } from "./discordActionToolRoutes.js";
import { invalidToolCallResponse } from "../tools/toolContractValidation.js";
import { handlerDefinitions } from "./toolHandlers/index.js";

export { stringArgument, stringArrayArgument } from "./toolHandlers/arguments.js";

const discordActionToolNames = new Set<ToolName>(["composeDiscordResponse", "createDiscordPoll", "updateBotAvatar", "createDiscordEmoji"]);
const walletToolNames = new Set<ToolName>([
  "awaitRandomWagerAction", "getWalletBalance", "listWalletBalances", "getWagerHistory", "transferWalletFunds",
  "requestStarterFunds", "adminTransferWalletFunds", "reconcileWalletTransfers",
]);
const localToolHandlers = bindToolHandlers(toolRegistry, handlerDefinitions, ["requestAdditionalTools", ...discordActionToolNames, ...walletToolNames]);

export async function executeLocalToolRoute(ctx: ToolContext, route: AgentToolRoute, originalText: string): Promise<AgentResponse> {
  ctx.abortSignal?.throwIfAborted();
  const invalidArguments = invalidToolCallResponse({ ...route, config: ctx.config });
  if (invalidArguments) return invalidArguments;
  const gate = await restrictedToolGate(ctx, route.name);
  ctx.abortSignal?.throwIfAborted();
  if (!gate.allowed) return { content: gate.message };

  const handler = localToolHandlers[route.name];
  if (handler) return handler(ctx, route, originalText);

  if (discordActionToolNames.has(route.name)) {
    const response = await executeDiscordActionToolRoute(ctx, route, originalText);
    if (response) return response;
  } else if (walletToolNames.has(route.name)) {
    const response = await executeWalletToolRoute(ctx, route);
    if (response) return response;
  }
  return { content: `Tool ${route.name} is registered but has no local execution handler.`, status: "error", errorCode: "missing_tool_handler" };
}
