import {
  adminTransferWalletFunds,
  getWalletBalance,
  listWalletBalances,
  reconcileWalletTransfers,
  transferWalletFunds
} from "../tools/walletTools.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentToolRoute } from "./routerShared.js";

export async function executeWalletToolRoute(ctx: ToolContext, route: AgentToolRoute): Promise<AgentResponse | null> {
  if (route.name === "getWalletBalance") {
    return {
      content: cleanResponse(await getWalletBalance(ctx, {
        owner: stringArgument(route.arguments, "owner") as "requester" | "bot" | "user" | undefined,
        userId: stringArgument(route.arguments, "userId")
      }), ctx.config.maxReplyChars)
    };
  }
  if (route.name === "listWalletBalances") {
    return listWalletBalances(ctx);
  }
  if (route.name === "transferWalletFunds") {
    return {
      content: cleanResponse(await transferWalletFunds(ctx, {
        destination: stringArgument(route.arguments, "destination") as "bot" | "user" | undefined,
        destinationUserId: stringArgument(route.arguments, "destinationUserId"),
        amountUsd: numberArgument(route.arguments, "amountUsd")
      }), ctx.config.maxReplyChars)
    };
  }
  if (route.name === "adminTransferWalletFunds") {
    return {
      content: cleanResponse(await adminTransferWalletFunds(ctx, {
        source: stringArgument(route.arguments, "source") as "bot" | "user" | undefined,
        sourceUserId: stringArgument(route.arguments, "sourceUserId"),
        destination: stringArgument(route.arguments, "destination") as "bot" | "user" | undefined,
        destinationUserId: stringArgument(route.arguments, "destinationUserId"),
        amountUsd: numberArgument(route.arguments, "amountUsd"),
        reason: stringArgument(route.arguments, "reason")
      }), ctx.config.maxReplyChars)
    };
  }
  if (route.name === "reconcileWalletTransfers") {
    return { content: cleanResponse(await reconcileWalletTransfers(ctx), ctx.config.maxReplyChars) };
  }
  return null;
}

function stringArgument(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArgument(args: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = args?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
