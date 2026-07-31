import { getDeploymentStatus } from "../../tools/agentTaskTools.js";
import { setAgentModel } from "../../tools/agentModelTools.js";
import { inspectAgentLogs, reportStatus, setUserTurnLimit } from "../../tools/discordOpsTools.js";
import { getSpendSummary } from "../../tools/spendTools.js";
import { cleanResponse } from "../../tools/responseFormatting.js";
import { stringArgument, numberArgument } from "./arguments.js";
import type { ToolName } from "../../tools/registry.js";
import type { LocalToolHandler } from "./types.js";

export const opsToolHandlers = {
  "reportStatus": async (ctx, _route, _originalText) => {
    return {
          content: cleanResponse(await reportStatus(ctx), ctx.config.maxReplyChars),
        };
  },
  "setUserTurnLimit": async (ctx, route, _originalText) => {
    return {
          content: cleanResponse(
            await setUserTurnLimit(ctx, {
              action: stringArgument(route.arguments, "action"),
              userId: stringArgument(route.arguments, "userId"),
              turnsPerDay: numberArgument(route.arguments, "turnsPerDay"),
              reason: stringArgument(route.arguments, "reason"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "setAgentModel": async (ctx, route, _originalText) => {
    return {
      content: cleanResponse(
        await setAgentModel(ctx, {
          action: stringArgument(route.arguments, "action"),
          model: stringArgument(route.arguments, "model"),
        }),
        ctx.config.maxReplyChars,
      ),
    };
  },
  "inspectAgentLogs": async (ctx, route, _originalText) => {
    return {
          content: cleanResponse(
            await inspectAgentLogs(ctx, {
              traceId: stringArgument(route.arguments, "traceId"),
              limit: numberArgument(route.arguments, "limit"),
              detail: stringArgument(route.arguments, "detail") === "model_io" ? "model_io" : "summary",
            }),
            Math.max(ctx.config.maxReplyChars, 6_000),
          ),
        };
  },
  "getDeploymentStatus": async (ctx, _route, _originalText) => {
    return {
          content: cleanResponse(
            await getDeploymentStatus(ctx),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getSpendSummary": async (ctx, route, _originalText) => {
    return {
          content: cleanResponse(
            await getSpendSummary(ctx, {
              period: stringArgument(route.arguments, "period") === "month" ? "month" : "today",
              limit: numberArgument(route.arguments, "limit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
