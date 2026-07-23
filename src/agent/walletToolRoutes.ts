import {
  adminSetWalletStarterAmount,
  adminTransferWalletFunds,
  getWagerHistory,
  getWalletBalance,
  getWalletFeeSummary,
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
import { numberArgument, recordArgument, stringArgument, stringArrayArgument } from "./toolHandlers/arguments.js";

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
  if (route.name === "getWagerHistory") {
    return {
      content: cleanResponse(await getWagerHistory(ctx, {
        game: stringArgument(route.arguments, "game"),
        limit: numberArgument(route.arguments, "limit"),
      }), Math.max(ctx.config.maxReplyChars, 6_000)),
    };
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
  if (route.name === "adminSetWalletStarterAmount") {
    return {
      content: cleanResponse(await adminSetWalletStarterAmount(ctx, {
        amountUsd: numberArgument(route.arguments, "amountUsd"),
        rebalanceExisting: route.arguments?.rebalanceExisting === true,
        reason: stringArgument(route.arguments, "reason")
      }), ctx.config.maxReplyChars)
    };
  }
  if (route.name === "getWalletFeeSummary") {
    return { content: cleanResponse(await getWalletFeeSummary(ctx), ctx.config.maxReplyChars) };
  }
  if (route.name === "reconcileWalletTransfers") {
    return { content: cleanResponse(await reconcileWalletTransfers(ctx), ctx.config.maxReplyChars) };
  }
  return null;
}
