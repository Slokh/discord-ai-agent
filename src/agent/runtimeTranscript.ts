import type { AgentResponse } from "../tools/types.js";
import type { ToolContext } from "../tools/types.js";
import type { ToolName } from "../tools/toolDefinition.js";
import { logger } from "../util/logger.js";

type RuntimeEventInput = {
  eventName: string;
  level?: "debug" | "info" | "warn" | "error";
  summary?: string | null;
  metadata?: Record<string, unknown>;
  durationMs?: number | null;
  traceId?: string | null;
  requestId?: string | null;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  messageId?: string | null;
};
type SpanInput = {
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  status?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
};
type AuditInput = Parameters<ToolContext["repo"]["auditTool"]>[0];

export type AgentEventInput = Partial<RuntimeEventInput> &
  Partial<SpanInput> & {
    name?: string;
    phase?: string;
    span?: SpanInput;
    audit?: AuditInput;
  };

export async function recordAgentEvent(
  ctx: ToolContext,
  input: AgentEventInput,
): Promise<void> {
  const eventName = input.eventName ?? input.name;
  const trace = eventName
    ? {
        eventName,
        level: input.level,
        summary: input.summary,
        metadata: input.metadata,
        durationMs: input.durationMs,
        traceId: input.traceId,
        requestId: input.requestId,
        guildId: input.guildId,
        channelId: input.channelId,
        userId: input.userId,
        messageId: input.messageId,
      }
    : undefined;
  const span =
    input.span ?? (input.spanId ? spanFromTopLevel(input) : undefined);

  // Runtime events share a monotonically increasing per-execution sequence.
  await recordRuntimeEvent(ctx, trace);
  await recordRuntimeSpan(ctx, span);
  await recordToolAudit(ctx, input.audit);
}

async function recordRuntimeEvent(
  ctx: ToolContext,
  input: RuntimeEventInput | undefined,
) {
  if (!input) return;
  if (ctx.agentRuntime && ctx.agentRuntimeSession && ctx.agentRuntimeExecutionId && typeof ctx.agentRuntime.recordEvent === "function") {
    await ctx.agentRuntime.recordEvent({
      sessionId: ctx.agentRuntimeSession.sessionId,
      executionId: ctx.agentRuntimeExecutionId,
      traceId: input.traceId ?? ctx.requestId ?? ctx.agentRuntimeSession.traceId,
      kind: input.level === "error" ? "error" : "status",
      level: input.level ?? "info",
      eventName: input.eventName,
      summary: input.summary,
      metadata: input.metadata,
      durationMs: input.durationMs,
      spanId: stringMetadata(input.metadata?.spanId),
      parentSpanId: stringMetadata(input.metadata?.parentSpanId),
    }).catch((error) => {
      logger.warn(
        { err: error, executionId: ctx.agentRuntimeExecutionId, eventName: input.eventName },
        "Failed to record canonical agent runtime event",
      );
    });
    return;
  }
}

function stringMetadata(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

async function recordRuntimeSpan(
  ctx: ToolContext,
  input: SpanInput | undefined,
) {
  if (!input) return;
  if (ctx.agentRuntime && ctx.agentRuntimeSession && ctx.agentRuntimeExecutionId && typeof ctx.agentRuntime.recordEvent === "function") {
    await ctx.agentRuntime
      .recordEvent({
        sessionId: ctx.agentRuntimeSession.sessionId,
        executionId: ctx.agentRuntimeExecutionId,
        traceId: ctx.requestId ?? ctx.agentRuntimeSession.traceId,
        kind: "status",
        level: input.status === "failed" ? "error" : "info",
        eventName: "agent.span",
        summary: input.name,
        durationMs: input.durationMs,
        spanId: input.spanId,
        parentSpanId: input.parentSpanId,
        metadata: {
          span: {
            spanId: input.spanId,
            parentSpanId: input.parentSpanId,
            name: input.name,
            startedAt: input.startedAt?.toISOString?.() ?? input.startedAt ?? null,
            completedAt: input.completedAt?.toISOString?.() ?? input.completedAt ?? null,
            durationMs: input.durationMs,
            status: input.status,
            metadata: input.metadata ?? {},
          },
        },
      })
      .catch((error) => {
        logger.warn(
          { err: error, executionId: ctx.agentRuntimeExecutionId, spanId: input.spanId },
          "Failed to record agent runtime span",
        );
      });
    return;
  }
}

async function recordToolAudit(
  ctx: ToolContext,
  input: AuditInput | undefined,
) {
  if (!input) return;
  const recorder = (
    ctx.repo as unknown as { auditTool?: (audit: AuditInput) => Promise<void> }
  ).auditTool;
  if (!recorder) return;
  await recorder.call(ctx.repo, input).catch((error: unknown) => {
    logger.warn(
      { err: error, toolName: input.toolName },
      "Failed to record tool audit event",
    );
  });
}

function spanFromTopLevel(input: AgentEventInput): SpanInput {
  return {
    spanId: input.spanId ?? "",
    parentSpanId: input.parentSpanId,
    name: input.name ?? "",
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    metadata: input.metadata,
  };
}

export async function appendAgentRuntimeAssistantToolCalls(
  ctx: ToolContext,
  input: {
    round: number;
    responseContent: string;
    model?: string | null;
    finishReason?: string | null;
    estimatedCostUsd?: number | null;
    routes: Array<{
      id: string;
      name: ToolName;
      arguments?: Record<string, unknown>;
      argumentsText: string;
    }>;
  },
) {
  if (
    !ctx.agentRuntime ||
    !ctx.agentRuntimeSession ||
    !ctx.agentRuntimeExecutionId ||
    !ctx.requestId
  )
    return;
  await ctx.agentRuntime
    .appendMessage({
      sessionId: ctx.agentRuntimeSession.sessionId,
      messageId: agentRuntimeTranscriptMessageId(
        ctx,
        `assistant-round-${input.round}`,
      ),
      clientMessageId: agentRuntimeTranscriptClientMessageId(
        ctx,
        `assistant-round-${input.round}`,
      ),
      role: "assistant",
      parts: [
        {
          type: "assistant_tool_calls",
          text: input.responseContent,
          toolCalls: input.routes.map((route) => ({
            id: route.id,
            name: route.name,
            arguments: route.arguments ?? {},
            argumentsText: route.argumentsText,
          })),
        },
      ],
      metadata: {
        source: "agent.router",
        traceId: ctx.requestId,
        promptMessageId: ctx.requestId,
        executionId: ctx.agentRuntimeExecutionId,
        round: input.round,
        model: input.model ?? null,
        finishReason: input.finishReason ?? null,
        estimatedCostUsd: input.estimatedCostUsd ?? null,
      },
    })
    .catch((error) => {
      logger.warn(
        { err: error, requestId: ctx.requestId, round: input.round },
        "Failed to append agent runtime assistant tool calls",
      );
    });
}

export async function appendAgentRuntimeToolResult(
  ctx: ToolContext,
  input: {
    round: number;
    route: { id: string; name: ToolName; arguments?: Record<string, unknown> };
    result: AgentResponse;
    durationMs: number;
    skippedRedundantToolCall: boolean;
  },
) {
  if (
    !ctx.agentRuntime ||
    !ctx.agentRuntimeSession ||
    !ctx.agentRuntimeExecutionId ||
    !ctx.requestId
  )
    return;
  const content = input.result.storedContent ?? input.result.content;
  await ctx.agentRuntime
    .appendMessage({
      sessionId: ctx.agentRuntimeSession.sessionId,
      messageId: agentRuntimeTranscriptMessageId(ctx, `tool-${input.route.id}`),
      clientMessageId: agentRuntimeTranscriptClientMessageId(
        ctx,
        `tool-${input.route.id}`,
      ),
      role: "tool",
      parts: [
        {
          type: "tool_result",
          toolCallId: input.route.id,
          toolName: input.route.name,
          content,
          files:
            input.result.files?.map((file) => ({
              name: file.name,
              contentType: file.contentType,
              bytes: file.data.length,
            })) ?? [],
          tables:
            input.result.tables?.map((table) => ({
              name: table.name,
              rows: table.rows.length,
              columns: table.columns,
            })) ?? [],
        },
      ],
      metadata: {
        source: "agent.router",
        traceId: ctx.requestId,
        promptMessageId: ctx.requestId,
        executionId: ctx.agentRuntimeExecutionId,
        round: input.round,
        toolCallId: input.route.id,
        toolName: input.route.name,
        arguments: input.route.arguments ?? {},
        outputChars: input.result.content.length,
        responseRedacted: Boolean(input.result.storedContent),
        fileCount: input.result.files?.length ?? 0,
        tableCount: input.result.tables?.length ?? 0,
        skippedRedundantToolCall: input.skippedRedundantToolCall || undefined,
        durationMs: input.durationMs,
      },
    })
    .catch((error) => {
      logger.warn(
        {
          err: error,
          requestId: ctx.requestId,
          round: input.round,
          toolName: input.route.name,
        },
        "Failed to append agent runtime tool result",
      );
    });
}

function agentRuntimeTranscriptMessageId(ctx: ToolContext, suffix: string) {
  return `agent-transcript-${ctx.requestId}-${suffix}`;
}

function agentRuntimeTranscriptClientMessageId(
  ctx: ToolContext,
  suffix: string,
) {
  return `${ctx.requestId}:transcript:${suffix}`;
}
