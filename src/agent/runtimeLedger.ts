import type { AgentRuntimeRepository, AgentRuntimeSessionRecord, AgentRuntimeStatus } from "../db/agentRuntimeRepository.js";

export type AgentPromptExecutionRef = {
  session: AgentRuntimeSessionRecord;
  executionId: string;
};

export async function ensureAgentRuntimePromptExecution(input: {
  agentRuntime?: AgentRuntimeRepository;
  agentSessionId?: string | null;
  agentExecutionId?: string | null;
  guildId: string;
  channelId: string;
  userId: string;
  userDisplayName: string;
  threadKey: string;
  requestId: string;
  text: string;
  rawContent: string;
  discordUrl: string;
  status: Extract<AgentRuntimeStatus, "queued" | "running">;
  source: string;
  executorName?: string | null;
}): Promise<AgentPromptExecutionRef | null> {
  if (!input.agentRuntime) return null;
  const executorName = input.executorName?.trim() || "in-process";
  const executionId = input.agentExecutionId ?? `agent-execution-${input.requestId}`;
  const session = await input.agentRuntime.upsertSession({
    sessionId: input.agentSessionId,
    threadKey: input.threadKey,
    traceId: input.requestId,
    guildId: input.guildId,
    channelId: input.channelId,
    userId: input.userId,
    title: titleFromPrompt(input.text),
    request: input.text,
    requestedBy: `${input.userDisplayName} (${input.userId})`,
    status: input.status,
    harness: executorName,
    metadata: {
      kind: "discord_channel",
      source: input.source,
      executor: executorName,
      currentMessageId: input.requestId,
      discordUrl: input.discordUrl
    }
  });
  await input.agentRuntime.appendMessage({
    sessionId: session.sessionId,
    messageId: `agent-user-message-${input.requestId}`,
    clientMessageId: input.requestId,
    role: "user",
    parts: [{ type: "text", text: input.text }],
    metadata: {
      traceId: input.requestId,
      promptMessageId: input.requestId,
      executionId,
      source: input.source,
      discordUrl: input.discordUrl,
      rawContent: input.rawContent
    }
  });
  await input.agentRuntime.createExecution({
    executionId,
    sessionId: session.sessionId,
    traceId: input.requestId,
    status: input.status,
    harness: executorName,
    metadata: {
      source: input.source,
      executor: executorName,
      discordMessageId: input.requestId,
      discordUrl: input.discordUrl
    }
  });
  await input.agentRuntime.recordEvent({
    sessionId: session.sessionId,
    executionId,
    traceId: input.requestId,
    kind: "status",
    eventName: input.status === "queued" ? "agent.execution.queued" : "agent.execution.started",
    summary: input.status === "queued" ? "Queued Discord prompt execution." : "Started Discord prompt execution.",
    metadata: {
      source: input.source,
      discordMessageId: input.requestId,
      executor: executorName
    }
  });
  return { session, executionId };
}

export async function finishAgentRuntimePromptExecution(input: {
  agentRuntime?: AgentRuntimeRepository;
  session?: AgentRuntimeSessionRecord | null;
  executionId?: string | null;
  traceId?: string | null;
  status: Extract<AgentRuntimeStatus, "succeeded" | "failed">;
  replyMessageId: string;
  replyUrl: string;
  responseContent: string;
  error?: string | null;
  durationMs: number;
  executorName?: string | null;
}) {
  if (!input.agentRuntime || !input.session || !input.executionId) return;
  const executorName = input.executorName?.trim() || "in-process";
  await input.agentRuntime.appendMessage({
    sessionId: input.session.sessionId,
    messageId: `agent-assistant-message-${input.replyMessageId}`,
    clientMessageId: input.replyMessageId,
    role: "assistant",
    parts: [{ type: "text", text: input.responseContent }],
    metadata: {
      traceId: input.traceId ?? null,
      promptMessageId: input.traceId ?? null,
      executionId: input.executionId ?? null,
      discordUrl: input.replyUrl,
      error: input.status === "failed"
    }
  });
  await input.agentRuntime.updateExecution({
    executionId: input.executionId,
    status: input.status,
    error: input.error,
    metadata: {
      replyMessageId: input.replyMessageId,
      replyUrl: input.replyUrl,
      responseChars: input.responseContent.length,
      durationMs: input.durationMs,
      executor: executorName
    }
  });
  await input.agentRuntime.recordEvent({
    sessionId: input.session.sessionId,
    executionId: input.executionId,
    traceId: input.traceId ?? input.session.traceId,
    kind: input.status === "failed" ? "error" : "status",
    level: input.status === "failed" ? "error" : "info",
    eventName: input.status === "failed" ? "agent.execution.failed" : "agent.execution.succeeded",
    summary: input.status === "failed" ? input.error ?? "Discord prompt execution failed." : "Discord prompt execution succeeded.",
    metadata: {
      replyMessageId: input.replyMessageId,
      replyUrl: input.replyUrl,
      executor: executorName
    },
    durationMs: input.durationMs
  });
}

function titleFromPrompt(prompt: string) {
  const clean = prompt.trim().replace(/\s+/g, " ");
  if (!clean) return "Discord prompt";
  return clean.length <= 80 ? clean : `${clean.slice(0, 77)}...`;
}
