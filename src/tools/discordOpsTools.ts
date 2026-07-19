import type { UserTurnLimitOverride } from "../db/budgetRepository.js";
import { MESSAGE_EMBEDDING_INPUT_VERSION } from "../memory/embedding.js";
import { formatModelDebuggerInspection, formatModelIoCaptures } from "../observability/modelDebuggerInspection.js";
import { formatRunInspection } from "../observability/runInspector.js";
import { getRunSnapshot, resolveRunReference } from "../observability/runs.js";
import type { RunSnapshot } from "../observability/runTypes.js";
import { summarizeForAudit, truncateForDiscord } from "../util/text.js";
import type { ToolContext } from "./types.js";
import { formatSandboxCommandEvents, formatTaskEvents } from "./agentTaskTools.js";
import { boundedLimit, formatToolAuditLogs, formatTraceEvents } from "./discordToolShared.js";

export async function reportStatus(ctx: ToolContext): Promise<string> {
  const [health, crawl, embeddingBacklog, blockedUsers, turnLimitOverrides] = await Promise.all([
    ctx.repo.health(),
    ctx.repo.getCrawlStatus(ctx.guildId),
    ctx.repo.embeddingBacklog({
      guildId: ctx.guildId,
      model: ctx.config.openRouter.embeddingModel,
      dimensions: ctx.config.embeddingDimensions,
      inputVersion: MESSAGE_EMBEDDING_INPUT_VERSION,
      botUserId: ctx.config.discord.clientId
    }),
    ctx.repo.interactionBlockCount(ctx.guildId),
    ctx.budgetRepo?.listUserTurnLimitOverrides({ guildId: ctx.guildId }) ?? Promise.resolve([])
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
    `- User turn-limit overrides: ${formatTurnLimitOverrides(turnLimitOverrides)}`,
    `- Tool calls logged: ${health.toolCalls}`,
    `- Estimated model cost logged: $${Number(health.estimatedCostUsd ?? 0).toFixed(4)}`,
    `- Crawl: ${crawl.map((row) => `${row.status}=${row.channels} channels/${row.messages} messages`).join(", ") || "not started"}`
  ].join("\n");
}

function formatTurnLimitOverrides(overrides: UserTurnLimitOverride[]): string {
  if (overrides.length === 0) return "none";
  const shown = overrides.slice(0, 10).map((row) => `${row.userId}=${row.chatTurnsPerDay < 0 ? "unlimited" : `${row.chatTurnsPerDay}/day`}`);
  const suffix = overrides.length > shown.length ? `, +${overrides.length - shown.length} more` : "";
  return `${overrides.length} (${shown.join(", ")}${suffix})`;
}

const USER_TURN_LIMIT_ACTIONS = new Set(["set", "clear", "list"]);

export async function setUserTurnLimit(
  ctx: ToolContext,
  input: { action?: string; userId?: string; turnsPerDay?: number; reason?: string }
): Promise<string> {
  if (!ctx.budgetRepo) {
    return "User turn limits are unavailable: the budget repository is not configured.";
  }
  const action = (input.action ?? "set").trim().toLowerCase();
  if (!USER_TURN_LIMIT_ACTIONS.has(action)) {
    return `Unknown action "${input.action}". Use set, clear, or list.`;
  }

  const audit = async (argumentsSummary: string, resultSummary: string) => {
    await ctx.repo.auditTool({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "setUserTurnLimit",
      argumentsSummary,
      resultSummary
    });
  };

  if (action === "list") {
    const overrides = await ctx.budgetRepo.listUserTurnLimitOverrides({ guildId: ctx.guildId });
    const defaultLimit = ctx.config.budget?.userTurnsPerDay ?? -1;
    const defaultLine = `Default limit: ${defaultLimit < 0 ? "unlimited" : `${defaultLimit} turns per UTC day`} (BUDGET_USER_TURNS_PER_DAY).`;
    await audit(summarizeForAudit({ action }), summarizeForAudit({ overrides: overrides.length }));
    if (overrides.length === 0) {
      return `No per-user turn-limit overrides are set. ${defaultLine}`;
    }
    const lines = overrides.map((row) => {
      const limit = row.chatTurnsPerDay < 0 ? "unlimited" : `${row.chatTurnsPerDay} turns/day`;
      const reason = row.reason ? ` — ${row.reason}` : "";
      return `- User ${row.userId}: ${limit}${reason}`;
    });
    return [`Per-user turn-limit overrides (${overrides.length}):`, ...lines, defaultLine].join("\n");
  }

  const userId = normalizeDiscordUserId(input.userId);
  if (!userId) {
    return "Provide the target's Discord user ID or mention. Use findDiscordUsers to resolve a name to an ID first.";
  }

  if (action === "clear") {
    const cleared = await ctx.budgetRepo.clearUserTurnLimitOverride({ guildId: ctx.guildId, userId });
    await audit(summarizeForAudit({ action, userId }), summarizeForAudit({ cleared }));
    const defaultLimit = ctx.config.budget?.userTurnsPerDay ?? -1;
    const fallback = defaultLimit < 0 ? "no daily limit" : `the default limit of ${defaultLimit} turns per UTC day`;
    return cleared
      ? `Cleared the turn-limit override for user ${userId}. They are back to ${fallback}.`
      : `User ${userId} has no turn-limit override; they already follow ${fallback}.`;
  }

  const turnsPerDay = input.turnsPerDay;
  if (turnsPerDay === undefined || !Number.isInteger(turnsPerDay) || turnsPerDay < -1) {
    return "Provide turnsPerDay as a whole number: a daily cap like 5, 0 to reject every turn, or -1 for unlimited.";
  }
  await ctx.budgetRepo.setUserTurnLimitOverride({
    guildId: ctx.guildId,
    userId,
    chatTurnsPerDay: turnsPerDay,
    reason: input.reason?.trim() || undefined,
    createdBy: ctx.userId
  });
  await audit(summarizeForAudit({ action, userId, turnsPerDay, reason: input.reason }), summarizeForAudit({ ok: true }));
  const effect =
    turnsPerDay < 0
      ? "no daily limit"
      : turnsPerDay === 0
        ? "no turns at all (every mention is rejected)"
        : `${turnsPerDay} turns per UTC day, counted across all channels`;
  return `Set the turn limit for user ${userId} to ${effect}. The limit resets at midnight UTC; clear it with action=clear.`;
}

function normalizeDiscordUserId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.trim().replace(/^<@!?/, "").replace(/>$/, "");
  return /^\d{5,25}$/.test(stripped) ? stripped : undefined;
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
