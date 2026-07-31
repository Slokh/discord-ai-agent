import { drawRandom, revealRandomness, settleRandomWager } from "../../tools/randomTools.js";
import {
  isSuccessfulRandomDrawResult,
  RANDOM_ACTION_NOT_AUTHORIZED_RESPONSE,
} from "../randomOutcomeGuard.js";
import { undoConversationTurns } from "../../tools/agentMemoryTools.js";
import { cleanResponse } from "../../tools/responseFormatting.js";
import { stringArgument, stringArrayArgument, numberArgument, recordArgument } from "./arguments.js";
import type { ToolName } from "../../tools/registry.js";
import type { LocalToolHandler } from "./types.js";

export const discordActionToolHandlers = {
  "undoConversationTurns": async (ctx, route, _originalText) => {
    return {
          content: cleanResponse(
            await undoConversationTurns(
              ctx,
              numberArgument(route.arguments, "count"),
            ),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "drawRandom": async (ctx, route, _originalText) => {
    if (!ctx.randomActionAuthorized) {
      return {
        content: RANDOM_ACTION_NOT_AUTHORIZED_RESPONSE,
        status: "error",
        errorCode: "random_action_not_authorized",
        retryable: false,
      };
    }
    const wager = recordArgument(route.arguments, "wager") as {
      playerUserId?: string;
      stakeUsd?: number;
      maxPayoutUsd?: number;
      game?: string;
      interactionMode?: "automatic" | "player_decisions";
      rule?: { kind: "coin_side"; side: "heads" | "tails" } | { kind: "sum"; operator: ">=" | ">" | "<=" | "<" | "="; target: number } | { kind: "any_match" } | { kind: "all_distinct" };
    } | undefined;
    const content = cleanResponse(
          await drawRandom(ctx, {
            kind: stringArgument(route.arguments, "kind"),
            count: numberArgument(route.arguments, "count"),
            min: numberArgument(route.arguments, "min"),
            max: numberArgument(route.arguments, "max"),
            sides: numberArgument(route.arguments, "sides"),
            options: stringArrayArgument(route.arguments, "options"),
            deckCount: numberArgument(route.arguments, "deckCount"),
            reason: stringArgument(route.arguments, "reason"),
            wager,
          }),
          ctx.config.maxReplyChars,
        );
    return {
          content,
          status: isSuccessfulRandomDrawResult(content) ? "ok" : "error",
          retryable: !isSuccessfulRandomDrawResult(content),
          outcome: randomDrawOutcome(content, Boolean(wager)),
        };
  },
  "revealRandomness": async (ctx, _route, _originalText) => {
    return {
          content: cleanResponse(
            await revealRandomness(ctx),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "settleRandomWager": async (ctx, route, _originalText) => {
    const content = cleanResponse(
            await settleRandomWager(ctx, {
              payoutUsd: numberArgument(route.arguments, "payoutUsd"),
              outcome: stringArgument(route.arguments, "outcome") as "player_win" | "player_loss" | "push" | undefined,
              resolutionSource: stringArgument(route.arguments, "resolutionSource") as "verified_randomness" | "player_decision" | undefined,
              explanation: stringArgument(route.arguments, "explanation"),
            }),
            ctx.config.maxReplyChars,
          );
    return { content, status: content.startsWith("The scoped wallet wager settled.") ? "ok" : "error", outcome: { kind: "wager", state: content.startsWith("The scoped wallet wager settled.") ? "settled" : "failed" } };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;

function randomDrawOutcome(content: string, wagerActive: boolean) {
  if (!isSuccessfulRandomDrawResult(content)) return { kind: "rng_draw", state: "failed" as const };
  return { kind: "rng_draw", state: "succeeded" as const, wagerActive };
}
