import { getBotPaymentStatus, getGameWalletBalance, reconcileBotPayments } from "../tools/walletTools.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentToolRoute } from "./routerShared.js";

export async function executeWalletToolRoute(ctx: ToolContext, route: AgentToolRoute): Promise<AgentResponse | null> {
  if (route.name === "getGameWalletBalance") {
    return { content: cleanResponse(await getGameWalletBalance(ctx), ctx.config.maxReplyChars) };
  }
  if (route.name === "getBotPaymentStatus") {
    return {
      content: cleanResponse(
        await getBotPaymentStatus(ctx, { limit: numberArgument(route.arguments, "limit") }),
        ctx.config.maxReplyChars
      )
    };
  }
  if (route.name === "reconcileBotPayments") {
    return { content: cleanResponse(await reconcileBotPayments(ctx), ctx.config.maxReplyChars) };
  }
  return null;
}

function numberArgument(args: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = args?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
