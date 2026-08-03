import {
  adminSetWalletStarterAmount,
  adminTransferWalletFunds,
  getWagerHistory,
  getWalletBalance,
  getWalletFeeSummary,
  listWalletBalances,
  reconcileWalletTransfers,
  requestStarterFunds,
  transferWalletFunds,
} from "../walletTools.js";
import { awaitRandomWagerAction } from "../gameSessionTools.js";
import { cleanToolResponse } from "../responseFormatting.js";
import type { ToolName } from "../toolDefinition.js";
import type { AgentResponse } from "../types.js";
import { numberArgument, recordArgument, stringArgument, stringArrayArgument } from "./arguments.js";
import type { LocalToolHandler } from "./types.js";

export const walletToolHandlers = {
  "awaitRandomWagerAction": async (ctx, route, _originalText) =>
    awaitRandomWagerAction(ctx, {
      expectedVersion: numberArgument(route.arguments, "expectedVersion"),
      state: recordArgument(route.arguments, "state"),
      allowedActions: stringArrayArgument(route.arguments, "allowedActions"),
      prompt: stringArgument(route.arguments, "prompt"),
    }),
  "getWalletBalance": async (ctx, route, _originalText) => ({
    content: cleanToolResponse(await getWalletBalance(ctx, {
      owner: stringArgument(route.arguments, "owner") as "requester" | "bot" | "user" | undefined,
      userId: stringArgument(route.arguments, "userId"),
    }), ctx.config.maxReplyChars),
  }),
  "listWalletBalances": async (ctx, route, _originalText) =>
    listWalletBalances(ctx, {
      view: stringArgument(route.arguments, "view") as "balances" | "addresses" | "both" | undefined,
    }),
  "getWagerHistory": async (ctx, route, _originalText) => ({
    content: cleanToolResponse(await getWagerHistory(ctx, {
      game: stringArgument(route.arguments, "game"),
      limit: numberArgument(route.arguments, "limit"),
    }), Math.max(ctx.config.maxReplyChars, 6_000)),
  }),
  "transferWalletFunds": async (ctx, route, _originalText) => cleanWalletAction(transferWalletFunds(ctx, {
      destination: stringArgument(route.arguments, "destination") as "bot" | "user" | undefined,
      destinationUserId: stringArgument(route.arguments, "destinationUserId"),
      amountUsd: numberArgument(route.arguments, "amountUsd"),
      entireBalance: route.arguments?.entireBalance === true,
    }), ctx.config.maxReplyChars),
  "requestStarterFunds": async (ctx, _route, _originalText) =>
    cleanWalletAction(requestStarterFunds(ctx), ctx.config.maxReplyChars),
  "adminTransferWalletFunds": async (ctx, route, _originalText) => cleanWalletAction(adminTransferWalletFunds(ctx, {
      source: stringArgument(route.arguments, "source") as "bot" | "user" | undefined,
      sourceUserId: stringArgument(route.arguments, "sourceUserId"),
      destination: stringArgument(route.arguments, "destination") as "bot" | "user" | undefined,
      destinationUserId: stringArgument(route.arguments, "destinationUserId"),
      amountUsd: numberArgument(route.arguments, "amountUsd"),
      reason: stringArgument(route.arguments, "reason"),
    }), ctx.config.maxReplyChars),
  "adminSetWalletStarterAmount": async (ctx, route, _originalText) => cleanWalletAction(adminSetWalletStarterAmount(ctx, {
      amountUsd: numberArgument(route.arguments, "amountUsd"),
      rebalanceExisting: route.arguments?.rebalanceExisting === true,
      reason: stringArgument(route.arguments, "reason"),
    }), ctx.config.maxReplyChars),
  "getWalletFeeSummary": async (ctx, _route, _originalText) => ({
    content: cleanToolResponse(await getWalletFeeSummary(ctx), ctx.config.maxReplyChars),
  }),
  "reconcileWalletTransfers": async (ctx, _route, _originalText) =>
    cleanWalletAction(reconcileWalletTransfers(ctx), ctx.config.maxReplyChars),
} satisfies Partial<Record<ToolName, LocalToolHandler>>;

async function cleanWalletAction(response: Promise<AgentResponse>, maxChars: number) {
  const result = await response;
  return { ...result, content: cleanToolResponse(result.content, maxChars) };
}
