import { getGameWalletBalance } from "../tools/walletTools.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentToolRoute } from "./routerShared.js";

export async function executeWalletToolRoute(ctx: ToolContext, route: AgentToolRoute): Promise<AgentResponse | null> {
  if (route.name !== "getGameWalletBalance") return null;
  return { content: cleanResponse(await getGameWalletBalance(ctx), ctx.config.maxReplyChars) };
}
