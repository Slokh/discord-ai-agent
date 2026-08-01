import { createAgentUpdateFromRequest, cancelAgentTask, getAgentTaskStatus, listAgentTasks, retryAgentTask } from "../../tools/agentTaskTools.js";
import { cleanResponse } from "../../tools/responseFormatting.js";
import { stringArgument, stringArrayArgument, numberArgument } from "./arguments.js";
import type { ToolName } from "../../tools/registry.js";
import type { LocalToolHandler } from "./types.js";

export const codegenToolHandlers = {
  "runCodingAgent": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await createAgentUpdateFromRequest(
              ctx,
              stringArgument(route.arguments, "request") ?? originalText,
              stringArgument(route.arguments, "title"),
              {
                taskType: stringArgument(route.arguments, "mode") === "diagnosis" ? "diagnosis" : "code_update",
                targetBranch: stringArgument(route.arguments, "targetBranch"),
                targetPullRequestNumber: numberArgument(
                  route.arguments,
                  "targetPullRequestNumber",
                ),
                targetPullRequestUrl: stringArgument(
                  route.arguments,
                  "targetPullRequestUrl",
                ),
              },
            ),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getAgentTaskStatus": async (ctx, route, _originalText) => {
    return {
          content: cleanResponse(
            await getAgentTaskStatus(ctx, {
              taskId: stringArgument(route.arguments, "taskId"),
              limit: numberArgument(route.arguments, "limit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "listAgentTasks": async (ctx, route, _originalText) => {
    return {
          content: cleanResponse(
            await listAgentTasks(ctx, {
              statuses: stringArrayArgument(route.arguments, "statuses"),
              limit: numberArgument(route.arguments, "limit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "retryAgentTask": async (ctx, route, _originalText) => {
    return {
          content: cleanResponse(
            await retryAgentTask(ctx, {
              taskId: stringArgument(route.arguments, "taskId"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "cancelAgentTask": async (ctx, route, _originalText) => {
    return {
          content: cleanResponse(
            await cancelAgentTask(ctx, {
              taskId: stringArgument(route.arguments, "taskId"),
              reason: stringArgument(route.arguments, "reason"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
