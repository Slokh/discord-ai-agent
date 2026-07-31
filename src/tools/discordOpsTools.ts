import { MESSAGE_EMBEDDING_INPUT_VERSION } from "../memory/embedding.js";
import { formatModelDebuggerInspection, formatModelIoCaptures } from "../observability/modelDebuggerInspection.js";
import { formatRunInspection } from "../observability/runInspector.js";
import { getRunSnapshot, resolveRunReference } from "../observability/runs.js";
import type { RunSnapshot } from "../observability/runTypes.js";
import { summarizeForAudit, truncateForDiscord } from "../util/text.js";
import type { ToolContext } from "./types.js";
import { formatSandboxCommandEvents, formatTaskEvents } from "./agentTaskTools.js";
import { boundedLimit, formatToolAuditLogs, formatTraceEvents } from "./discordToolShared.js";
import { effectiveAgentChatModel } from "./agentModelTools.js";

export async function reportStatus(ctx: ToolContext): Promise<string> {
  const [health, crawl, embeddingBacklog, blockedUsers] = await Promise.all([
    ctx.repo.health(),
    ctx.repo.getCrawlStatus(ctx.guildId),
    ctx.repo.embeddingBacklog({
      guildId: ctx.guildId,
      model: ctx.config.openRouter.embeddingModel,
      dimensions: ctx.config.embeddingDimensions,
      inputVersion: MESSAGE_EMBEDDING_INPUT_VERSION,
      botUserId: ctx.config.discord.clientId
    }),
    ctx.repo.interactionBlockCount(ctx.guildId)
  ]);
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "reportStatus",
    argumentsSummary: summarizeForAudit({ guildId: ctx.guildId }),
    resultSummary: summarizeForAudit({
      messages: health.messages,
      embeddings: health.embeddings,
      embeddingBacklog,
      blockedUsers,
      toolCalls: health.toolCalls,
      crawl
    })
  });
  return [
    "Discord AI Agent local status:",
    `- Primary chat model: ${effectiveAgentChatModel(ctx) ?? "provider default"}${ctx.chatModelOverride ? " (server override)" : " (configured default)"}`,
    `- Messages indexed: ${health.messages}`,
    `- Embeddings stored: ${health.embeddings}`,
    `- Embeddings pending/backfill: ${embeddingBacklog}`,
    `- Conversation sessions: ${Number(health.conversationSessions ?? 0)}`,
    `- Interaction-blocked users: ${blockedUsers}`,
    `- Tool calls logged: ${health.toolCalls}`,
    `- Estimated model cost logged: $${Number(health.estimatedCostUsd ?? 0).toFixed(4)}`,
    `- Crawl: ${crawl.map((row) => `${row.status}=${row.channels} channels/${row.messages} messages`).join(", ") || "not started"}`
  ].join("\n");
}

export async function inspectAgentLogs(
  ctx: ToolContext,
  input: { traceId?: string; limit?: number; detail?: "summary" | "model_io" } = {},
): Promise<string> {
  const limit = boundedLimit(input.limit, 20, 1, 50);
  const requestedReference = input.traceId?.trim() || undefined;
  const detail = input.detail === "model_io" ? "model_io" : "summary";
  const resolved = await resolveVisibleRunFromRequest(ctx, requestedReference);
  const runSnapshot = resolved.snapshot;
  const traceId = runSnapshot?.run.traceId ?? requestedReference ?? resolved.reference;
  const [events, taskEvents, commandEvents, toolLogs, modelIo] = await Promise.all([
    ctx.repo.getTraceEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId,
      limit
    }),
    ctx.repo.getAgentRuntimeTaskEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId,
      limit
    }),
    ctx.repo.getSandboxCommandEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId,
      limit
    }),
    ctx.repo.getToolAuditLogs({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId,
      limit
    }),
    detail === "model_io" && runSnapshot ? loadVisibleModelIo(ctx, runSnapshot) : Promise.resolve({ content: "", artifactCount: 0 })
  ]);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "inspectAgentLogs",
    argumentsSummary: summarizeForAudit({ requestedReference, resolvedReference: resolved.reference, referenceSource: resolved.source, traceId, limit, detail }),
    resultSummary: summarizeForAudit({
      normalizedRun: runSnapshot?.run.runId,
      traceEvents: events.length,
      taskEvents: taskEvents.length,
      commandEvents: commandEvents.length,
      toolLogs: toolLogs.length,
      modelIoArtifacts: modelIo.artifactCount,
    })
  });

  if (!runSnapshot && events.length === 0 && taskEvents.length === 0 && commandEvents.length === 0 && toolLogs.length === 0) {
    return traceId ? `No Discord AI Agent trace or tool logs matched traceId=${traceId}.` : "No recent Discord AI Agent trace or tool logs matched visible channels.";
  }

  return [
    traceId ? `Discord AI Agent logs for trace ${traceId}:` : "Recent Discord AI Agent logs:",
    runSnapshot ? `\n${formatModelDebuggerInspection(runSnapshot)}` : "",
    modelIo.content ? `\n${modelIo.content}` : "",
    runSnapshot ? `\n${formatVisibleRunInspection(runSnapshot)}` : "",
    "",
    formatTraceEvents(events),
    "",
    formatTaskEvents(taskEvents),
    "",
    formatSandboxCommandEvents(commandEvents),
    "",
    formatToolAuditLogs(toolLogs)
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function resolveVisibleRunFromRequest(ctx: ToolContext, requestedReference?: string) {
  const candidates = requestedReference
    ? [{ reference: requestedReference, source: "explicit" as const }]
    : uniqueRunReferences([
      { reference: ctx.replyContext?.rootMessageId, source: "reply_root" as const },
      { reference: ctx.replyContext?.messageId, source: "reply_parent" as const },
    ]);
  for (const candidate of candidates) {
    const resolved = await resolveRunReference(ctx.repo, candidate.reference);
    const runId = resolved?.run.runId ?? candidate.reference;
    const snapshot = await getRunSnapshot(ctx.repo, runId);
    if (snapshot && isRunSnapshotVisibleToRequester(ctx, snapshot)) return { snapshot, reference: candidate.reference, source: candidate.source };
  }
  return { snapshot: undefined, reference: candidates[0]?.reference, source: candidates[0]?.source ?? "recent" as const };
}

function isRunSnapshotVisibleToRequester(ctx: ToolContext, snapshot: RunSnapshot) {
  const run = snapshot.run;
  if (run.guildId && run.guildId !== ctx.guildId) return false;
  if (!run.channelId) return true;
  return run.channelId === ctx.channelId || ctx.visibleChannelIds.includes(run.channelId);
}

function formatVisibleRunInspection(snapshot: RunSnapshot) {
  return truncateForDiscord(
    formatRunInspection(snapshot, {
      eventLimit: 20,
      terminalLimit: snapshot.run.kind === "codegen" ? 8 : 4,
      includeTerminal: snapshot.terminal.entries.length > 0
    }),
    6000
  );
}

async function loadVisibleModelIo(ctx: ToolContext, snapshot: RunSnapshot) {
  if (typeof ctx.repo.getAgentRuntimeArtifact !== "function") return { content: "Observed model I/O: artifact loading is unavailable in this runtime.", artifactCount: 0 };
  const artifacts = snapshot.artifacts.filter((artifact) => String(artifact.kind) === "model_prompt" || String(artifact.kind) === "model_response");
  if (artifacts.length === 0) return { content: "Observed model I/O: this run has no prompt/response captures (it may predate capture support).", artifactCount: 0 };
  const selected = latestModelIoArtifacts(artifacts);
  const loaded = await Promise.all(selected.map(async (artifact) => ({
    artifact,
    content: await ctx.repo.getAgentRuntimeArtifact!({ artifactId: artifact.artifactId }),
  })));
  return {
    content: formatModelIoCaptures(loaded.map((item) => ({
      kind: String(item.artifact.kind),
      name: item.artifact.name,
      content: item.content?.content ?? null,
    }))),
    artifactCount: loaded.filter((item) => Boolean(item.content)).length,
  };
}

function latestModelIoArtifacts(artifacts: RunSnapshot["artifacts"]) {
  return [...artifacts]
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, 4)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

function uniqueRunReferences<T extends { reference?: string; source: string }>(candidates: T[]): Array<{ reference: string; source: T["source"] }> {
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const reference = candidate.reference?.trim();
    if (!reference || seen.has(reference)) return [];
    seen.add(reference);
    return [{ reference, source: candidate.source }];
  });
}
