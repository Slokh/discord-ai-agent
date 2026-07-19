import { getDeploymentStatus } from "../../tools/agentTaskTools.js";
import { inspectAgentLogs, reportStatus, setUserTurnLimit } from "../../tools/discordOpsTools.js";
import { createSkillFromRequest, manageSkills } from "../../tools/skillTools.js";
import { getSpendSummary } from "../../tools/spendTools.js";
import { cleanResponse } from "../../tools/responseFormatting.js";
import { stringArgument, stringArrayArgument, numberArgument } from "./arguments.js";
import type { ToolName } from "../../tools/registry.js";
import type { LocalToolHandler } from "./types.js";

// Uniform signatures intentionally expose only the inputs each tool needs.
/* eslint-disable @typescript-eslint/no-unused-vars */
export const opsToolHandlers = {
  "reportStatus": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(await reportStatus(ctx), ctx.config.maxReplyChars),
        };
  },
  "setUserTurnLimit": async (ctx, route, originalText) => {
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
  "inspectAgentLogs": async (ctx, route, originalText) => {
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
  "createSkillDraft": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await createSkillFromRequest(ctx, {
              skillName:
                stringArgument(route.arguments, "skillName") ?? "server-note",
              instruction:
                stringArgument(route.arguments, "instruction") ?? originalText,
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "manageSkills": async (ctx, route, originalText) => {
    const action = stringArgument(route.arguments, "action");
    return {
          content: cleanResponse(
            await manageSkills(ctx, {
              action: action === "enable" || action === "disable" || action === "delete" ? action : "list",
              skillNames: stringArrayArgument(route.arguments, "skillNames"),
              all: route.arguments?.all === true,
              query: stringArgument(route.arguments, "query"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getDeploymentStatus": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await getDeploymentStatus(ctx),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getSpendSummary": async (ctx, route, originalText) => {
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
/* eslint-enable @typescript-eslint/no-unused-vars */
