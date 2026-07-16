import {
  adminTransferWalletFunds,
  getWalletBalance,
  listWalletBalances,
  reconcileWalletTransfers,
  requestStarterFunds,
  transferWalletFunds
} from "../tools/walletTools.js";
import {
  awaitRandomWagerAction,
  isSuccessfulAwaitRandomWagerAction,
} from "../tools/gameSessionTools.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentToolRoute } from "./routerShared.js";

export async function executeWalletToolRoute(ctx: ToolContext, route: AgentToolRoute): Promise<AgentResponse | null> {
  if (route.name === "awaitRandomWagerAction") {
    const content = cleanResponse(await awaitRandomWagerAction(ctx, {
      expectedVersion: numberArgument(route.arguments, "expectedVersion"),
      state: recordArgument(route.arguments, "state"),
      allowedActions: stringArrayArgument(route.arguments, "allowedActions"),
      prompt: stringArgument(route.arguments, "prompt"),
    }), ctx.config.maxReplyChars);
    const succeeded = isSuccessfulAwaitRandomWagerAction(content);
    return { content, status: succeeded ? "ok" : "error", retryable: !succeeded };
  }
  if (route.name === "getWalletBalance") {
    return {
      content: cleanResponse(await getWalletBalance(ctx, {
        owner: stringArgument(route.arguments, "owner") as "requester" | "bot" | "user" | undefined,
        userId: stringArgument(route.arguments, "userId")
      }), ctx.config.maxReplyChars)
    };
  }
  if (route.name === "listWalletBalances") {
    return listWalletBalances(ctx, {
      view: stringArgument(route.arguments, "view") as "balances" | "addresses" | "both" | undefined
    });
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
  if (route.name === "requestStarterFunds") {
    return { content: cleanResponse(await requestStarterFunds(ctx), ctx.config.maxReplyChars) };
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

function recordArgument(args: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = args?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArrayArgument(args: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const value = args?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}
