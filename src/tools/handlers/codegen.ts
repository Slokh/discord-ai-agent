import { createAgentUpdateFromRequest, cancelAgentTask, getAgentTaskStatus, listAgentTasks, retryAgentTask } from "../agentTaskTools.js";
import { cleanToolResponse } from "../responseFormatting.js";
import { stringArgument, stringArrayArgument, numberArgument } from "./arguments.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";

export const codegenToolHandlers = {
  "runCodingAgent": async (ctx, route, _originalText) => {
    const response = await createAgentUpdateFromRequest(
              ctx,
              stringArgument(route.arguments, "request")!,
              stringArgument(route.arguments, "title")!,
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
            );
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
  "getAgentTaskStatus": async (ctx, route, _originalText) => {
    return {
          content: cleanToolResponse(
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
          content: cleanToolResponse(
            await listAgentTasks(ctx, {
              statuses: stringArrayArgument(route.arguments, "statuses"),
              limit: numberArgument(route.arguments, "limit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "retryAgentTask": async (ctx, route, _originalText) => {
    const response = await retryAgentTask(ctx, {
              taskId: stringArgument(route.arguments, "taskId"),
            });
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
  "cancelAgentTask": async (ctx, route, _originalText) => {
    const response = await cancelAgentTask(ctx, {
              taskId: stringArgument(route.arguments, "taskId"),
              reason: stringArgument(route.arguments, "reason"),
            });
    return { ...response, content: cleanToolResponse(response.content, ctx.config.maxReplyChars) };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
