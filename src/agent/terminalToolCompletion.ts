import type { Logger } from "pino";
import type { ToolName } from "../tools/registry.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type {
  AgentFile,
  AgentResponse,
  ToolContext,
} from "../tools/types.js";
import { durationMs } from "../util/logger.js";
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
    files: AgentFile[];
    memoryEvents: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
  },
): Promise<AgentResponse | null> {
  if (!input.ready) return null;
  const generatedEvidence = [...input.memoryEvents]
    .reverse()
    .find((event) => event.metadata?.toolName === "generateImage");
  return await completeDirectToolResponse(ctx, {
    routeName: "generateImage",
    result: {
      content: generatedEvidence?.content || "Generated and attached the image.",
    },
    files: input.files,
    memoryEvents: input.memoryEvents,
    requestLogger: input.requestLogger,
    startedAt: input.startedAt,
    completionKind: "grounded generated image result",
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
