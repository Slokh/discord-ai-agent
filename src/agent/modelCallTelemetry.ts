import { createHash, randomUUID } from "node:crypto";
import type { ChatMessage, OpenRouterClient, ToolDefinition } from "../models/openrouter.js";
import type { ToolContext } from "../tools/types.js";
import { durationMs, logger } from "../util/logger.js";
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
  const promptSections = promptSectionTelemetry(input.chat.messages);
  const toolSchemas = toolSchemaTelemetry(input.chat.tools ?? []);
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
    promptSections,
    messageBytesByRole: input.chat.messages.reduce<Record<string, number>>((totals, message) => {
      totals[message.role] = (totals[message.role] ?? 0) + Buffer.byteLength(JSON.stringify(message), "utf8");
      return totals;
    }, {}),
    toolCount: input.chat.tools?.length ?? 0,
    toolSchemaBytes,
    toolSchemaFingerprint,
    toolSchemas,
    offeredTools: (input.chat.tools ?? []).map((tool) => tool.type === "function" ? tool.function.name : tool.type),
    maxTokens: input.chat.maxTokens ?? 4096,
    ...runtimeVersionMetadata(ctx.config),
    ...input.metadata,
  };

  const promptArtifact = storeModelCallArtifact(ctx, {
    callId,
    kind: "model_prompt",
    name: `Model prompt · ${input.purpose}`,
    content: JSON.stringify({
      schemaVersion: 1,
      callId,
      purpose: input.purpose,
      requestedModel: input.chat.model ?? "default",
      maxTokens: input.chat.maxTokens ?? 4096,
      temperature: input.chat.temperature ?? null,
      messages: input.chat.messages.map((message, index) => ({
        index,
        section: promptMessageSection(message, index, input.chat.messages.length),
        ...message,
      })),
      tools: input.chat.tools ?? [],
    }, null, 2),
    metadata: {
      purpose: input.purpose,
      promptFingerprint,
      toolSchemaFingerprint,
      promptSections,
      toolSchemas,
    },
  });

  await recordAgentEvent(ctx, { eventName: "agent.model.call.started", summary: input.purpose, metadata: common });

  try {
    const response = await ctx.openRouter.chat(input.chat);
    // Keep provider latency comparable across revisions. Artifact persistence happens
    // after the provider returns and should remain visible as unattributed runtime work.
    const providerDurationMs = durationMs(startedAt);
    const [promptArtifactId, responseArtifactId] = await Promise.all([
      promptArtifact,
      storeModelCallArtifact(ctx, {
        callId,
        kind: "model_response",
        name: `Model response · ${input.purpose}`,
        content: JSON.stringify({
          schemaVersion: 1,
          callId,
          purpose: input.purpose,
          model: response.model,
          finishReason: response.finishReason ?? null,
          content: response.content,
          toolCalls: response.toolCalls ?? [],
          usage: response.usage ?? null,
          estimatedCostUsd: response.estimatedCostUsd ?? null,
        }, null, 2),
        metadata: {
          purpose: input.purpose,
          model: response.model,
          finishReason: response.finishReason ?? null,
          outputChars: response.content.length,
          requestedToolCalls: (response.toolCalls ?? []).map((call) => call.name),
        },
      }),
    ]);
    const completed = {
      ...common,
      model: response.model,
      finishReason: response.finishReason,
      usage: response.usage,
      estimatedCostUsd: response.estimatedCostUsd,
      outputChars: response.content.length,
      requestedToolCalls: (response.toolCalls ?? []).map((call) => call.name),
      promptArtifactId,
      responseArtifactId,
    };
    await recordAgentEvent(ctx, {
      eventName: "agent.model.call.completed",
      summary: input.purpose,
      durationMs: providerDurationMs,
      metadata: completed,
    });
    return response;
  } catch (error) {
    const providerDurationMs = durationMs(startedAt);
    const promptArtifactId = await promptArtifact;
    const failed = { ...common, promptArtifactId, error: error instanceof Error ? error.message : String(error) };
    await recordAgentEvent(ctx, {
      eventName: "agent.model.call.failed",
      level: "error",
      summary: input.purpose,
      durationMs: providerDurationMs,
      metadata: failed,
    });
    throw error;
  }
}

export type PromptSectionTelemetry = {
  name: string;
  bytes: number;
  characters: number;
  messageCount: number;
  estimatedTokens: number;
  roles: string[];
};

export function promptSectionTelemetry(messages: ChatMessage[]): PromptSectionTelemetry[] {
  const sections = new Map<string, PromptSectionTelemetry>();
  messages.forEach((message, index) => {
    const name = promptMessageSection(message, index, messages.length);
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    const characters = messageCharacters(message);
    const current = sections.get(name) ?? { name, bytes: 0, characters: 0, messageCount: 0, estimatedTokens: 0, roles: [] };
    current.bytes += bytes;
    current.characters += characters;
    current.messageCount += 1;
    current.estimatedTokens = Math.ceil(current.characters / 4);
    if (!current.roles.includes(message.role)) current.roles.push(message.role);
    sections.set(name, current);
  });
  return [...sections.values()];
}

function promptMessageSection(message: ChatMessage, index: number, count: number) {
  const content = textContent(message);
  if (index === 0 && message.role === "system") return "base_system_prompt";
  if (index === count - 1 && message.role === "user") return "current_user_request";
  if (message.role === "tool") return "current_tool_results";
  if (message.tool_calls?.length) return "current_assistant_tool_calls";
  if (content.startsWith("Current Discord requester:")) return "requester_identity";
  if (content.startsWith("Loaded skills:")) return "loaded_skills";
  if (content.startsWith("Private server overlay instructions follow.")) return "server_overlay";
  if (content.startsWith("Deployment prompt overlay instructions follow.")) return "deployment_overlay";
  if (content.startsWith("The current user message is a Discord reply.")) return "reply_chain";
  if (content.startsWith("Discord image attachments are available")) return "attachments";
  if (content.startsWith("Recent completed Discord AI Agent turns")) return "session_memory";
  if (content.startsWith("Answer only the next user message.")) return "context_guard";
  if (/^\[Earlier Discord AI Agent reply|^\[Earlier .* result/.test(content)) return "session_memory";
  if (message.role === "assistant" || message.role === "user") return "session_memory";
  return "other_system_context";
}

function toolSchemaTelemetry(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.type === "function" ? tool.function.name : tool.type,
    type: tool.type === "function" ? "local" : "hosted",
    bytes: Buffer.byteLength(JSON.stringify(tool), "utf8"),
  }));
}

function textContent(message: ChatMessage) {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.type === "text" ? part.text : `[image ${part.image_url.url}]`).join("\n");
}

function messageCharacters(message: ChatMessage) {
  return textContent(message).length + (message.tool_calls?.reduce((total, call) => total + call.function.name.length + call.function.arguments.length, 0) ?? 0);
}

async function storeModelCallArtifact(
  ctx: ToolContext,
  input: { callId: string; kind: "model_prompt" | "model_response"; name: string; content: string; metadata: Record<string, unknown> },
) {
  if (!ctx.agentRuntime || typeof ctx.agentRuntime.storeArtifact !== "function" || !ctx.agentRuntimeSession || !ctx.agentRuntimeExecutionId) return null;
  return ctx.agentRuntime.storeArtifact({
    sessionId: ctx.agentRuntimeSession.sessionId,
    executionId: ctx.agentRuntimeExecutionId,
    kind: input.kind,
    name: input.name,
    content: input.content,
    contentType: "application/json",
    metadata: { schemaVersion: 1, callId: input.callId, traceId: ctx.requestId ?? null, ...input.metadata },
  }).then((artifact) => artifact.artifactId).catch((error) => {
    logger.warn({ err: error, callId: input.callId, artifactKind: input.kind }, "Failed to store model-call debugger artifact");
    return null;
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
