import { getDeploymentStatus } from "../agentTaskTools.js";
import { setAgentModel } from "../agentModelTools.js";
import { inspectAgentLogs, reportStatus } from "../discordOpsTools.js";
import { getSpendSummary } from "../spendTools.js";
import { cleanToolResponse } from "../responseFormatting.js";
import { stringArgument, numberArgument } from "./arguments.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";

export const opsToolHandlers = {
  "reportStatus": async (ctx, _route, _originalText) => {
    return {
          content: cleanToolResponse(await reportStatus(ctx), ctx.config.maxReplyChars),
        };
  },
  "setAgentModel": async (ctx, route, _originalText) => {
    const response = await setAgentModel(ctx, {
          action: stringArgument(route.arguments, "action"),
          model: stringArgument(route.arguments, "model"),
        });
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
  "inspectAgentLogs": async (ctx, route, _originalText) => {
    return {
          content: cleanToolResponse(
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
          content: cleanToolResponse(
            await getDeploymentStatus(ctx),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getSpendSummary": async (ctx, route, _originalText) => {
    return {
          content: cleanToolResponse(
            await getSpendSummary(ctx, {
              period: stringArgument(route.arguments, "period") === "month" ? "month" : "today",
              limit: numberArgument(route.arguments, "limit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
