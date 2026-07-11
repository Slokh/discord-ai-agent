import type { AgentResponse } from "../tools/types.js";
import type { ToolContext } from "../tools/types.js";
import type { ToolName } from "../tools/registry.js";
import { logger } from "../util/logger.js";

type TraceInput = Parameters<ToolContext["repo"]["recordTraceEvent"]>[0];
type SpanInput = Omit<
  Parameters<ToolContext["repo"]["recordProcessRunSpan"]>[0],
  "runId"
>;
type AuditInput = Parameters<ToolContext["repo"]["auditTool"]>[0];

export type AgentEventInput = Partial<TraceInput> &
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
  // Keep writes ordered so a trace event and its span cannot race for the same
  // sequence value under the canonical runtime ledger.
  await recordTraceEvent(ctx, trace);
  await recordProcessRunSpan(ctx, span);
  await recordToolAudit(ctx, input.audit);
}

async function recordTraceEvent(
  ctx: ToolContext,
  input: TraceInput | undefined,
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
    }).catch((error) => {
      logger.warn(
        { err: error, executionId: ctx.agentRuntimeExecutionId, eventName: input.eventName },
        "Failed to record canonical agent runtime event",
      );
    });
    return;
  }
  const recorder = (
    ctx.repo as unknown as {
      recordTraceEvent?: (event: TraceInput) => Promise<void>;
    }
  ).recordTraceEvent;
  if (!recorder) return;
  await recorder.call(ctx.repo, input).catch((error) => {
    logger.warn(
      { err: error, eventName: input.eventName },
      "Failed to record agent trace event",
    );
  });
}

async function recordProcessRunSpan(
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
  const runId = ctx.requestId;
  if (!runId) return;
  const recorder = (
    ctx.repo as unknown as {
      recordProcessRunSpan?: (
        span: Parameters<ToolContext["repo"]["recordProcessRunSpan"]>[0],
      ) => Promise<unknown>;
    }
  ).recordProcessRunSpan;
  if (!recorder) return;
  await recorder.call(ctx.repo, { runId, ...input }).catch((error: unknown) => {
    logger.warn(
      { err: error, runId, spanId: input.spanId },
      "Failed to record process run span",
    );
  });
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
