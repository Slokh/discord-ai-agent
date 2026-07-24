import type { Logger } from "pino";
import type { ChatMessage } from "../models/openrouter.js";
import type { ToolName } from "../tools/registry.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type {
  AgentFile,
  AgentResponse,
  ToolContext,
} from "../tools/types.js";
import { durationMs } from "../util/logger.js";
import { synthesizeFinalAnswerWithoutTools } from "./finalSynthesis.js";
import type { ModelCallBudget } from "./routerShared.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export function isSuccessfulGeneratedImageArtifact(
  routeName: ToolName,
  result: AgentResponse,
): boolean {
  return routeName === "generateImage" &&
    result.status !== "error" &&
    (result.files?.length ?? 0) > 0;
}

export async function synthesizeGeneratedImageArtifactIfReady(
  ctx: ToolContext,
  input: {
    ready: boolean;
    text: string;
    messages: ChatMessage[];
    files: AgentFile[];
    memoryEvents: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
    modelCallBudget: ModelCallBudget;
  },
): Promise<AgentResponse | null> {
  if (!input.ready) return null;
  return await synthesizeFinalAnswerWithoutTools(ctx, {
    reason: "successful generated image artifact",
    text: input.text,
    messages: input.messages,
    files: input.files,
    memoryEvents: input.memoryEvents,
    requestLogger: input.requestLogger,
    startedAt: input.startedAt,
    modelCallBudget: input.modelCallBudget,
    maxTokens: 1024,
    model: ctx.config.openRouter?.utilityModel?.trim() || undefined,
  });
}

export async function completeDirectToolResponse(
  ctx: ToolContext,
  input: {
    routeName: ToolName;
    result: AgentResponse;
    files: AgentFile[];
    memoryEvents?: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
    completionKind: string;
  },
): Promise<AgentResponse> {
  const content = cleanResponse(input.result.content, ctx.config.maxReplyChars);
  const memoryEvents = input.memoryEvents ?? [];
  input.requestLogger.info(
    {
      durationMs: durationMs(input.startedAt),
      finalChars: content.length,
      fileCount: input.files.length,
      memoryEventCount: memoryEvents.length,
    },
    `Agent request complete after ${input.completionKind}`,
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.request.complete",
    summary: `Completed with ${input.completionKind}`,
    metadata: {
      toolName: input.routeName,
      finalChars: content.length,
      fileCount: input.files.length,
      memoryEventCount: memoryEvents.length,
      responseRedacted: Boolean(input.result.storedContent),
    },
    durationMs: durationMs(input.startedAt),
  });
  return {
    content,
    storedContent: input.result.storedContent,
    files: input.files.length > 0 ? input.files : undefined,
    memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined,
  };
}
