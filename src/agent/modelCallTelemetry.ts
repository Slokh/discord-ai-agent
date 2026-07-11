import { createHash, randomUUID } from "node:crypto";
import type { OpenRouterClient } from "../models/openrouter.js";
import type { ToolContext } from "../tools/types.js";
import { durationMs } from "../util/logger.js";
import { recordAgentEvent } from "./runtimeTranscript.js";
import { runtimeVersionMetadata } from "../observability/runtimeVersions.js";

type ChatInput = Parameters<OpenRouterClient["chat"]>[0];

export async function runObservedModelCall(
  ctx: ToolContext,
  input: { purpose: string; chat: ChatInput; metadata?: Record<string, unknown> },
) {
  const callId = `model-call-${randomUUID()}`;
  const startedAt = Date.now();
  const promptBytes = Buffer.byteLength(JSON.stringify(input.chat.messages), "utf8");
  const toolSchemaBytes = Buffer.byteLength(JSON.stringify(input.chat.tools ?? []), "utf8");
  const promptFingerprint = sha256(JSON.stringify(input.chat.messages));
  const toolSchemaFingerprint = sha256(JSON.stringify(input.chat.tools ?? []));
  const common = {
    schemaVersion: 1,
    callId,
    spanId: callId,
    parentSpanId: typeof input.metadata?.parentSpanId === "string" ? input.metadata.parentSpanId : "agent.request",
    purpose: input.purpose,
    requestedModel: input.chat.model ?? "default",
    messageCount: input.chat.messages.length,
    promptBytes,
    promptFingerprint,
    messageBytesByRole: input.chat.messages.reduce<Record<string, number>>((totals, message) => {
      totals[message.role] = (totals[message.role] ?? 0) + Buffer.byteLength(JSON.stringify(message), "utf8");
      return totals;
    }, {}),
    toolCount: input.chat.tools?.length ?? 0,
    toolSchemaBytes,
    toolSchemaFingerprint,
    offeredTools: (input.chat.tools ?? []).map((tool) => tool.type === "function" ? tool.function.name : tool.type),
    maxTokens: input.chat.maxTokens ?? 4096,
    ...runtimeVersionMetadata(ctx.config),
    ...input.metadata,
  };

  await recordAgentEvent(ctx, { eventName: "agent.model.call.started", summary: input.purpose, metadata: common });

  try {
    const response = await ctx.openRouter.chat(input.chat);
    const completed = {
      ...common,
      model: response.model,
      finishReason: response.finishReason,
      usage: response.usage,
      estimatedCostUsd: response.estimatedCostUsd,
      outputChars: response.content.length,
      requestedToolCalls: (response.toolCalls ?? []).map((call) => call.name),
    };
    await recordAgentEvent(ctx, {
      eventName: "agent.model.call.completed",
      summary: input.purpose,
      durationMs: durationMs(startedAt),
      metadata: completed,
    });
    return response;
  } catch (error) {
    const failed = { ...common, error: error instanceof Error ? error.message : String(error) };
    await recordAgentEvent(ctx, {
      eventName: "agent.model.call.failed",
      level: "error",
      summary: input.purpose,
      durationMs: durationMs(startedAt),
      metadata: failed,
    });
    throw error;
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
