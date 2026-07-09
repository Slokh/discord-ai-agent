import { MESSAGE_EMBEDDING_INPUT_VERSION } from "../memory/embedding.js";
import { formatRunInspection } from "../observability/runInspector.js";
import { getRunSnapshot, resolveRunReference, type RunSnapshot } from "../observability/runs.js";
import { summarizeForAudit, truncateForDiscord } from "../util/text.js";
import type { ToolContext } from "./types.js";
import { formatSandboxCommandEvents, formatTaskEvents } from "./agentTaskTools.js";
import { boundedLimit, formatToolAuditLogs, formatTraceEvents } from "./discordToolShared.js";

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

export async function inspectAgentLogs(ctx: ToolContext, input: { traceId?: string; limit?: number } = {}): Promise<string> {
  const limit = boundedLimit(input.limit, 20, 1, 50);
  const traceId = input.traceId?.trim() || undefined;
  const [runSnapshot, events, taskEvents, commandEvents, toolLogs] = await Promise.all([
    traceId ? resolveVisibleRunSnapshot(ctx, traceId) : Promise.resolve(undefined),
    ctx.repo.getTraceEvents({
      guildId: ctx.guildId,
      visibleChannelIds: ctx.visibleChannelIds,
      traceId,
      limit
    }),
    ctx.repo.getTaskProgressEvents({
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
    })
  ]);

  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "inspectAgentLogs",
    argumentsSummary: summarizeForAudit({ traceId, limit }),
    resultSummary: summarizeForAudit({
      normalizedRun: runSnapshot?.run.runId,
      traceEvents: events.length,
      taskEvents: taskEvents.length,
      commandEvents: commandEvents.length,
      toolLogs: toolLogs.length
    })
  });

  if (!runSnapshot && events.length === 0 && taskEvents.length === 0 && commandEvents.length === 0 && toolLogs.length === 0) {
    return traceId ? `No Discord AI Agent trace or tool logs matched traceId=${traceId}.` : "No recent Discord AI Agent trace or tool logs matched visible channels.";
  }

  return [
    traceId ? `Discord AI Agent logs for trace ${traceId}:` : "Recent Discord AI Agent logs:",
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


async function resolveVisibleRunSnapshot(ctx: ToolContext, reference: string): Promise<RunSnapshot | undefined> {
  const resolved = await resolveRunReference(ctx.repo, reference);
  const runId = resolved?.run.runId ?? reference.trim();
  if (!runId) return undefined;
  const snapshot = await getRunSnapshot(ctx.repo, runId);
  if (!snapshot || !isRunSnapshotVisibleToRequester(ctx, snapshot)) return undefined;
  return snapshot;
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
