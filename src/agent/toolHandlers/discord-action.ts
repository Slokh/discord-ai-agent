import { drawRandom, revealRandomness, settleRandomWager } from "../../tools/randomTools.js";
import { isSuccessfulRandomDrawResult } from "../randomOutcomeGuard.js";
import { undoConversationTurns } from "../../tools/agentMemoryTools.js";
import { cleanResponse } from "../../tools/responseFormatting.js";
import { stringArgument, stringArrayArgument, numberArgument, recordArgument } from "./arguments.js";
import type { ToolName } from "../../tools/registry.js";
import type { LocalToolHandler } from "./types.js";

// Uniform signatures intentionally expose only the inputs each tool needs.
/* eslint-disable @typescript-eslint/no-unused-vars */
export const discordActionToolHandlers = {
  "undoConversationTurns": async (ctx, route, originalText) => {
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
  "drawRandom": async (ctx, route, originalText) => {
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
            wager: recordArgument(route.arguments, "wager") as {
              playerUserId?: string;
              stakeUsd?: number;
              maxPayoutUsd?: number;
              game?: string;
            } | undefined,
          }),
          ctx.config.maxReplyChars,
        );
    return {
          content,
          status: isSuccessfulRandomDrawResult(content) ? "ok" : "error",
          retryable: !isSuccessfulRandomDrawResult(content),
        };
  },
  "revealRandomness": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await revealRandomness(ctx),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "settleRandomWager": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await settleRandomWager(ctx, {
              payoutUsd: numberArgument(route.arguments, "payoutUsd"),
              outcome: stringArgument(route.arguments, "outcome") as "player_win" | "player_loss" | "push" | undefined,
              resolutionSource: stringArgument(route.arguments, "resolutionSource") as "verified_randomness" | "player_decision" | undefined,
              explanation: stringArgument(route.arguments, "explanation"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
/* eslint-enable @typescript-eslint/no-unused-vars */
