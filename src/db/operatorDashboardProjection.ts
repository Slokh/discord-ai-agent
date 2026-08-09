import { operatorTaskFailureSummary } from "../console/taskFailureSummary.js";
import type { OperatorActivitySource } from "./operatorActivityLinks.js";

export function projectActivitySources(
  runtimeRows: Array<Record<string, unknown>>,
  taskRows: Array<Record<string, unknown>>,
  caseRows: Array<Record<string, unknown>>,
): OperatorActivitySource[] {
  const groups = new Map<string, OperatorActivitySource>();
  for (const row of runtimeRows) {
    const key = `runtime-${row.execution_id}`;
    const occurredAt = date(row.story_updated_at);
    const startedAt = date(row.story_started_at);
    const group: OperatorActivitySource = groups.get(key) ?? {
      id: key, kind: row.is_system ? "system" : "runtime", title: String(row.title),
      authorLabel: nullable(row.source_author_label), status: nullable(row.status), detail: null,
      occurredAt, startedAt, durationMs: Math.max(0, occurredAt.getTime() - startedAt.getTime()),
      attempts: number(row.attempt) || 1, failedAttempts: null, eventCount: number(row.group_event_count) || 1,
      rollupKey: nullable(row.rollup_key), responseStatus: nullable(row.response_status),
      deliveryState: nullable(row.delivery_state),
      sourceUrl: discordUrl(row.delivery_guild_id, row.delivery_channel_id, row.source_message_id),
      responseUrl: discordUrl(row.delivery_guild_id, row.status_channel_id, row.status_message_id),
      responseKind: row.status_message_id == null ? null : "reply", hasParent: Boolean(row.has_parent),
      pullRequestUrl: null, branchName: null, pullRequestState: null, mergeRevision: null,
      deployedRevision: null, deploymentId: null, improvementCaseId: null,
      relatedImprovementCaseIds: textArray(row.related_case_ids), failureReason: null, events: [],
    };
    if (row.id != null && group.events.length < 12) group.events.push({
      id: `runtime-event-${row.id}`, name: String(row.event_name), level: String(row.level), createdAt: date(row.created_at),
    });
    groups.set(key, group);
  }
  for (const row of taskRows) {
    const improvement = row.task_type === "improvement_report";
    const key = improvement ? `task-${row.task_id}` : `code-change-${row.story_id ?? `task:${row.task_id}`}`;
    const occurredAt = date(row.story_updated_at);
    const startedAt = date(row.story_started_at);
    const group: OperatorActivitySource = groups.get(key) ?? {
      id: key, kind: improvement ? "system" : "code_change", title: String(row.title), authorLabel: null,
      status: nullable(row.status), detail: nullable(row.status_message) ?? nullable(row.current_step),
      occurredAt, startedAt,
      durationMs: row.duration_ms == null ? Math.max(0, occurredAt.getTime() - startedAt.getTime()) : number(row.duration_ms),
      attempts: number(row.attempts) || 1, failedAttempts: number(row.failed_attempts),
      eventCount: number(row.group_event_count),
      rollupKey: improvement ? "improvement_report" : null, responseStatus: null, deliveryState: null,
      sourceUrl: discordUrl(row.guild_id, row.channel_id, row.trace_id),
      responseUrl: discordUrl(row.guild_id, row.discord_response_channel_id, row.discord_response_message_id),
      responseKind: row.discord_response_message_id == null ? null : "reply", hasParent: false,
      pullRequestUrl: nullable(row.pr_url), branchName: nullable(row.branch_name),
      pullRequestState: nullable(row.pull_request_state), mergeRevision: nullable(row.pull_request_merge_revision),
      deployedRevision: nullable(row.deployed_revision), deploymentId: nullable(row.deployment_id),
      improvementCaseId: nullable(row.improvement_case_id),
      relatedImprovementCaseIds: nullable(row.improvement_case_id) ? [String(row.improvement_case_id)] : [],
      failureReason: row.status === "pull_request_closed"
        ? "The pull request closed without merging."
        : operatorTaskFailureSummary(row.status, row.error), events: [],
    };
    if (row.id != null && group.events.length < 12) group.events.push({
      id: `task-event-${row.id}`, name: String(row.event_name), level: String(row.level), createdAt: date(row.created_at),
    });
    groups.set(key, group);
  }
  for (const row of caseRows) {
    const key = `improvement-${row.case_id}`;
    const occurredAt = date(row.story_updated_at);
    const eventName = String(row.event_name);
    const group: OperatorActivitySource = groups.get(key) ?? {
      id: key, kind: "improvement", title: improvementConsoleTitle(row), authorLabel: null,
      status: String(row.status), detail: eventName, occurredAt, startedAt: date(row.first_seen_at),
      durationMs: null, attempts: null, failedAttempts: null, eventCount: number(row.group_event_count) || 1,
      rollupKey: null, responseStatus: null, deliveryState: null,
      sourceUrl: discordUrl(row.conversation_guild_id, row.source_channel_id, row.source_message_id),
      responseUrl: discordUrl(row.conversation_guild_id, row.delivery_channel_id, row.delivery_message_id),
      responseKind: nullable(row.delivery_kind), hasParent: false, pullRequestUrl: nullable(row.pull_request_url),
      branchName: null, pullRequestState: null, mergeRevision: null,
      deployedRevision: null, deploymentId: null, improvementCaseId: String(row.case_id),
      relatedImprovementCaseIds: textArray(row.related_case_ids), failureReason: null, events: [],
    };
    if (row.event_id != null && group.events.length < 12) group.events.push({
      id: `improvement-event-${row.event_id}`, name: eventName,
      level: eventName.endsWith("failed") || eventName.endsWith("stalled") ? "warn" : "info",
      createdAt: date(row.created_at),
    });
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
}

function improvementConsoleTitle(row: Record<string, unknown>) {
  const preview = nullable(row.report_preview)?.replace(/\s+-#\s+\d+(?:\.\d+)?s\s*$/i, "")
    .replaceAll("**", "").replaceAll("`", "").replace(/\s+/g, " ").trim();
  if (!preview) return String(row.title);
  const bounded = preview.length > 140 ? `${preview.slice(0, 137).trimEnd()}…` : preview;
  const subject = row.report_author_is_bot ? "reply" : row.report_has_execution ? "prompt" : "message";
  return `Reported ${subject}: ${bounded}`;
}

function nullable(value: unknown): string | null { return value == null ? null : String(value); }
function date(value: unknown): Date { return value instanceof Date ? value : new Date(String(value)); }
function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function textArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item) => item != null).map(String) : []; }
function discordUrl(guildId: unknown, channelId: unknown, messageId: unknown): string | null {
  if (guildId == null || channelId == null || messageId == null) return null;
  return `https://discord.com/channels/${encodeURIComponent(String(guildId))}/${encodeURIComponent(String(channelId))}/${encodeURIComponent(String(messageId))}`;
}
