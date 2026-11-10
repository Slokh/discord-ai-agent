import type { DbPool } from "./pool.js";
import { releaseActivityDetail } from "./operatorActivityDetailRepository.js";
import { conversationActivityDetail, conversationToolResult } from "./operatorConversationActivityRepository.js";
import { messageActivityDetail, recentMessageActivities } from "./operatorMessageActivityRepository.js";
import { projectActivitySources } from "./operatorDashboardProjection.js";
import { OPERATOR_ACTIVITY_WINDOW_DAYS } from "./operatorDashboardActivityQueries.js";
import { executionActivityTrace } from "./operatorRuntimeActivityRepository.js";
import { discordMentionLabels, resolvedDiscordSourceTitle } from "./operatorDiscordIdentity.js";
import { deriveOperatorActivity, summarizeOperatorActivity } from "../console/activity.js";
import { paginateActivity, type ActivityPageRequest } from "../console/server.js";
const COMPONENTS = ["bot", "worker", "console"] as const;
export class OperatorDashboardRepository {
  constructor(private readonly pool: DbPool) {}
  async overview(input: { revision: string }) {
    const snapshot = await this.snapshot({ revision: input.revision, includeRecentActivity: false });
    return {
      generatedAt: snapshot.generatedAt,
      revision: snapshot.revision,
      services: snapshot.services,
      deployments: snapshot.deployments,
      summary: snapshot.summary,
    };
  }
  async activityPage(input: ActivityPageRequest & { revision: string }) {
    const activityTypes = input.types?.length ? input.types : ["conversation"];
    const snapshot = await this.snapshot({
      revision: input.revision,
      activityOnly: true,
      activityTypes,
    });
    const activity = summarizeOperatorActivity(deriveOperatorActivity(snapshot));
    return paginateActivity(activity, input);
  }
  async activityDetail(input: { kind: string; id: string; revision: string }) {
    const detail = {
      kind: input.kind,
      id: input.id,
      generatedAt: new Date(),
      revision: input.revision,
    };
    if (input.kind === "release") {
      const deploymentId = input.id.startsWith("release-") ? input.id.slice("release-".length) : "";
      const deployment = deploymentId ? await this.pool.query(
        `SELECT revision,deployment_id,verified_at FROM deployment_verifications WHERE deployment_id = $1 LIMIT 1`,
        [deploymentId],
      ) : { rows: [] };
      return deployment.rows[0] ? { ...detail, release: await releaseActivityDetail(this.pool, {
        revision: deployment.rows[0].revision,
        deploymentId: deployment.rows[0].deployment_id,
        verifiedAt: deployment.rows[0].verified_at,
      }) } : null;
    }
    if (input.kind === "message" && input.id.startsWith("message-")) {
      const message = await messageActivityDetail(this.pool, input.id.slice("message-".length));
      return message ? { ...detail, message } : null;
    }
    if (input.kind === "system") {
      if (input.id.startsWith("system-rollup-")) {
        const rollupKey = input.id.slice("system-rollup-".length);
        const runs = await this.pool.query(
          `SELECT execution.execution_id,execution.status,
                  coalesce(nullif(execution.metadata->>'title',''),session.title,$1) AS title,
                  coalesce(execution.started_at,execution.created_at) AS started_at,
                  execution.updated_at
           FROM agent_runtime_executions execution
           JOIN agent_runtime_sessions session USING (session_id)
           WHERE coalesce(nullif(execution.metadata->>'jobKind',''),nullif(session.metadata->>'jobKind','')) = $1
             AND execution.updated_at >= now() - make_interval(days => ${OPERATOR_ACTIVITY_WINDOW_DAYS})
             AND execution.status NOT IN ('queued','running')
           ORDER BY execution.updated_at DESC
           LIMIT 100`,
          [rollupKey],
        );
        if (!runs.rows.length) return null;
        return { ...detail, runs: runs.rows.map((row) => ({
          id: `execution-${String(row.execution_id)}`, title: String(row.title), status: String(row.status),
          tone: ["failed", "blocked", "timed_out", "timeout", "error"].includes(String(row.status)) ? "danger" : "success",
          durationMs: Math.max(0, date(row.updated_at).getTime() - date(row.started_at).getTime()),
          occurredAt: date(row.updated_at),
        })) };
      }
      const systemExecutionId = executionIdFromActivityId(input.id);
      if (systemExecutionId) return {
        ...detail,
        traceEvents: await executionActivityTrace(this.pool, systemExecutionId),
      };
      return null;
    }
    if (input.kind !== "conversation") return null;
    const conversation = await conversationActivityDetail(this.pool, input.id);
    return conversation ? { ...detail, ...conversation } : null;
  }

  async activityToolResult(input: { kind: string; id: string; callId: string; revision: string }) {
    if (input.kind !== "conversation") return null;
    return conversationToolResult(this.pool, input.id, input.callId);
  }

  async snapshot(input: {
    revision: string;
    now?: Date;
    activityOnly?: boolean;
    activityTypes?: string[];
    includeRecentActivity?: boolean;
  }) {
    const now = input.now ?? new Date();
    const activityEventLimit = 1;
    const activityOnly = input.activityOnly === true;
    const includeRecentActivity = input.includeRecentActivity !== false;
    const activityTypes = new Set(input.activityTypes ?? ["conversation", "message", "release", "system"]);
    const includeConversation = activityTypes.has("conversation");
    const includeMessages = activityTypes.has("message");
    const includeReleases = activityTypes.has("release");
    const includeSystem = activityTypes.has("system");
    const heartbeatTable = activityOnly ? { rows: [] } : await this.pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'service_runtime_heartbeats'
       ) AS available`,
    );
    const heartbeatAvailable = !activityOnly && Boolean(heartbeatTable.rows[0]?.available);
    const heartbeatQuery = heartbeatAvailable
      ? this.pool.query(
        `SELECT component,instance_id,revision,started_at,last_seen_at
         FROM service_runtime_heartbeats
         WHERE last_seen_at >= $1::timestamptz - interval '7 days'
         ORDER BY component,last_seen_at DESC`,
        [now],
      )
      : Promise.resolve({ rows: [] });
    const [heartbeats, executions, runtimeEvents, deployments, messages] = await Promise.all([
      heartbeatQuery,
      !activityOnly || includeConversation || includeSystem ? this.pool.query(
        `SELECT execution.execution_id,execution.session_id,execution.status,
                execution.model,execution.provider,execution.started_at,
                execution.created_at,execution.updated_at,
                coalesce(nullif(execution.metadata->>'title',''),session.title) AS title,
                left(session.request,240) AS request_preview,
                coalesce(nullif(execution.metadata->>'jobKind',''),nullif(session.metadata->>'jobKind','')) AS rollup_key,
                nullif(execution.metadata->>'responseStatus','') AS response_status,
                delivery.state AS delivery_state,
                coalesce(delivery.guild_id,session.guild_id) AS delivery_guild_id,
                coalesce(delivery.channel_id,session.channel_id) AS delivery_channel_id,
                coalesce(delivery.source_message_id,nullif(execution.metadata->>'discordMessageId',''),session.trace_id) AS source_message_id,
                left(source_message.content,240) AS source_message_content,
                source_message.raw AS source_message_raw,
                coalesce(source_member.display_name,source_member.nickname,source_author.global_name,source_author.username) AS source_author_label,
                delivery.status_channel_id,delivery.status_message_id,
                (source_message.referenced_message_id IS NOT NULL) AS has_parent,
                latest.event_name AS latest_event,count(*) OVER ()::int AS total_count
         FROM agent_runtime_executions execution
         JOIN agent_runtime_sessions session USING (session_id)
         LEFT JOIN discord_delivery_obligations delivery USING (execution_id)
         LEFT JOIN messages source_message
           ON source_message.id = coalesce(delivery.source_message_id,nullif(execution.metadata->>'discordMessageId',''),session.trace_id)
          AND source_message.guild_id = coalesce(delivery.guild_id,session.guild_id)
         LEFT JOIN discord_users source_author ON source_author.id = source_message.author_id AND source_author.deleted_at IS NULL
         LEFT JOIN guild_members source_member
           ON source_member.guild_id = source_message.guild_id AND source_member.user_id = source_message.author_id
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions deletion WHERE deletion.user_id = source_message.author_id)
         LEFT JOIN LATERAL (
           SELECT event_name FROM agent_runtime_events event
           WHERE event.execution_id = execution.execution_id
           ORDER BY sequence DESC LIMIT 1
         ) latest ON true
         WHERE execution.status IN ('queued','running')
           AND execution.task_id IS NULL
           AND coalesce(nullif(execution.metadata->>'qualityCohort',''),nullif(session.metadata->>'qualityCohort','')) IS DISTINCT FROM 'synthetic'
           AND coalesce(nullif(execution.metadata->>'source',''),nullif(session.metadata->>'source','')) IS DISTINCT FROM 'cli.prompt'
         ORDER BY execution.updated_at DESC LIMIT 30`,
      ) : emptyRows(),
      includeRecentActivity && (includeConversation || includeSystem) ? this.pool.query(
        `WITH execution_rollup AS (
           SELECT execution.execution_id,execution.session_id,execution.attempt,
                  coalesce(execution.started_at,execution.created_at) AS story_started_at,
                  execution.updated_at AS story_updated_at,
                  coalesce(session.harness = 'background_job' OR session.metadata->>'kind' = 'background_job',false) AS is_system
           FROM agent_runtime_executions execution
           JOIN agent_runtime_sessions session USING (session_id)
           WHERE execution.task_id IS NULL
             AND execution.status NOT IN ('queued','running')
             AND coalesce(nullif(execution.metadata->>'qualityCohort',''),nullif(session.metadata->>'qualityCohort','')) IS DISTINCT FROM 'synthetic'
             AND coalesce(nullif(execution.metadata->>'source',''),nullif(session.metadata->>'source','')) IS DISTINCT FROM 'cli.prompt'
              AND execution.updated_at >= $1::timestamptz - make_interval(days => ${OPERATOR_ACTIVITY_WINDOW_DAYS})
              AND (
                ($2::boolean AND NOT coalesce(session.harness = 'background_job' OR session.metadata->>'kind' = 'background_job',false))
                OR ($3::boolean AND coalesce(session.harness = 'background_job' OR session.metadata->>'kind' = 'background_job',false))
              )
         )
         SELECT recent.execution_id,recent.session_id,recent.attempt,
                CASE WHEN recent.is_system THEN recent.story_started_at
                     ELSE coalesce(source_message.created_at,recent.story_started_at)
                END AS story_started_at,
                recent.story_updated_at,recent.is_system,
                coalesce(nullif(execution.metadata->>'title',''),session.title) AS title,
                execution.status,
                coalesce(nullif(execution.metadata->>'jobKind',''),nullif(session.metadata->>'jobKind','')) AS rollup_key,
                nullif(execution.metadata->>'responseStatus','') AS response_status,
                delivery.state AS delivery_state,
                coalesce(delivery.guild_id,session.guild_id) AS delivery_guild_id,
                coalesce(delivery.channel_id,session.channel_id) AS delivery_channel_id,
                coalesce(delivery.source_message_id,nullif(execution.metadata->>'discordMessageId',''),session.trace_id) AS source_message_id,
                left(source_message.content,240) AS source_message_content,
                source_message.raw AS source_message_raw,
                coalesce(source_member.display_name,source_member.nickname,source_author.global_name,source_author.username) AS source_author_label,
                delivery.status_channel_id,delivery.status_message_id,
                (source_message.referenced_message_id IS NOT NULL) AS has_parent,
                event.id,event.event_name,event.level,event.created_at,
                event.group_event_count
         FROM execution_rollup recent
         JOIN agent_runtime_executions execution ON execution.execution_id = recent.execution_id
         JOIN agent_runtime_sessions session ON session.session_id = recent.session_id
         LEFT JOIN discord_delivery_obligations delivery ON delivery.execution_id = recent.execution_id
         LEFT JOIN messages source_message
           ON source_message.id = coalesce(delivery.source_message_id,nullif(execution.metadata->>'discordMessageId',''),session.trace_id)
          AND source_message.guild_id = coalesce(delivery.guild_id,session.guild_id)
         LEFT JOIN discord_users source_author ON source_author.id = source_message.author_id AND source_author.deleted_at IS NULL
         LEFT JOIN guild_members source_member
           ON source_member.guild_id = source_message.guild_id AND source_member.user_id = source_message.author_id
          AND NOT EXISTS (SELECT 1 FROM privacy_deletions deletion WHERE deletion.user_id = source_message.author_id)
         LEFT JOIN LATERAL (
           SELECT candidate.id,candidate.event_name,candidate.level,candidate.created_at,
                  count(*) OVER ()::int AS group_event_count
           FROM agent_runtime_events candidate
           WHERE candidate.execution_id = recent.execution_id
           ORDER BY candidate.created_at DESC,candidate.id DESC
           LIMIT ${activityEventLimit}
         ) event ON true
         ORDER BY recent.story_updated_at DESC,event.created_at DESC,event.id DESC`,
        [now, includeConversation, includeSystem],
      ) : emptyRows(),
      !activityOnly || includeRecentActivity && includeReleases ? this.pool.query(
        `SELECT revision,deployment_id,verified_at FROM deployment_verifications
         WHERE verified_at >= $1::timestamptz - make_interval(days => ${OPERATOR_ACTIVITY_WINDOW_DAYS})
         ORDER BY verified_at DESC`,
        [now],
      ) : emptyRows(),
      includeRecentActivity && includeMessages ? recentMessageActivities(this.pool, now) : Promise.resolve([]),
    ]);

    const heartbeatRows = heartbeats.rows.map((row) => ({
      component: String(row.component),
      instanceId: String(row.instance_id),
      revision: String(row.revision),
      startedAt: date(row.started_at),
      lastSeenAt: date(row.last_seen_at),
    }));
    const services = COMPONENTS.map((component) => {
      const rows = heartbeatRows.filter((row) => row.component === component);
      const live = rows.filter((row) => now.getTime() - row.lastSeenAt.getTime() <= 45_000);
      const latest = rows[0] ?? null;
      return {
        component,
        status: !heartbeatAvailable ? "unavailable" : live.length > 0 ? "healthy" : latest ? "stale" : "offline",
        instances: live.length,
        revision: (live[0] ?? latest)?.revision ?? null,
        startedAt: (live[0] ?? latest)?.startedAt ?? null,
        lastSeenAt: latest?.lastSeenAt ?? null,
      };
    });
    const promptMentionLabels = await discordMentionLabels(this.pool, [...executions.rows, ...runtimeEvents.rows].map((row) => ({
      guild_id: row.delivery_guild_id, content: row.source_message_content, raw: row.source_message_raw,
    })));
    const runtimeActivityRows = runtimeEvents.rows.map((row) => ({
      ...row,
      title: resolvedDiscordSourceTitle(row.source_message_content, row.delivery_guild_id, row.title, promptMentionLabels),
    }));
    const activities = projectActivitySources(runtimeActivityRows);
    return {
      generatedAt: now,
      revision: input.revision,
      services,
      summary: {
        healthyServices: services.filter((service) => service.status === "healthy").length,
        serviceCount: services.length,
        serviceTelemetryAvailable: heartbeatAvailable,
        activeRuns: number(executions.rows[0]?.total_count),
      },
      executions: executions.rows.map((row) => ({
        executionId: String(row.execution_id), sessionId: String(row.session_id),
        status: String(row.status), model: nullable(row.model), provider: nullable(row.provider),
        title: resolvedDiscordSourceTitle(row.source_message_content, row.delivery_guild_id, row.title, promptMentionLabels),
        authorLabel: nullable(row.source_author_label),
        requestPreview: String(row.request_preview),
        latestEvent: nullable(row.latest_event), rollupKey: nullable(row.rollup_key),
        responseStatus: nullable(row.response_status), deliveryState: nullable(row.delivery_state),
        sourceUrl: discordUrl(row.delivery_guild_id, row.delivery_channel_id, row.source_message_id),
        responseUrl: discordUrl(row.delivery_guild_id, row.status_channel_id, row.status_message_id),
        responseKind: row.status_message_id == null ? null : "reply",
        hasParent: Boolean(row.has_parent),
        startedAt: nullableDate(row.started_at),
        createdAt: date(row.created_at), updatedAt: date(row.updated_at),
      })),
      messages,
      deployments: deployments.rows.map((row) => ({
        revision: String(row.revision), deploymentId: String(row.deployment_id), verifiedAt: date(row.verified_at),
      })),
      activity: activities,
    };
  }
}
function emptyRows(): Promise<{ rows: Array<Record<string, unknown>> }> {
  return Promise.resolve({ rows: [] });
}
function nullable(value: unknown): string | null {
  return value == null ? null : String(value);
}
function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
function nullableDate(value: unknown): Date | null {
  return value == null ? null : date(value);
}
function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function executionIdFromActivityId(id: string): string | null {
  if (id.startsWith("runtime-")) return id.slice("runtime-".length) || null;
  if (id.startsWith("execution-")) return id.slice("execution-".length) || null;
  return null;
}
function discordUrl(guildId: unknown, channelId: unknown, messageId: unknown): string | null {
  if (guildId == null || channelId == null || messageId == null) return null;
  return `https://discord.com/channels/${encodeURIComponent(String(guildId))}/${encodeURIComponent(String(channelId))}/${encodeURIComponent(String(messageId))}`;
}
