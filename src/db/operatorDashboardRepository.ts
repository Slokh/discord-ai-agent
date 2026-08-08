import type { DbPool } from "./pool.js";
import { deriveOperatorActivity } from "../console/activity.js";
import { operatorTaskFailureSummary } from "../console/taskFailureSummary.js";
import { releaseActivityDetail } from "./operatorActivityDetailRepository.js";
import { messageActivityDetail, recentMessageActivities } from "./operatorMessageActivityRepository.js";
import { improvementActivityTrace } from "./operatorImprovementActivityRepository.js";
import { RELATED_CASES_FOR_EXECUTION_SQL, RELATED_CASES_FOR_IMPROVEMENT_SQL } from "./operatorActivityLinks.js";
import type { OperatorActivitySource } from "./operatorActivityLinks.js";
const COMPONENTS = ["bot", "worker", "api", "console"] as const;
export class OperatorDashboardRepository {
  constructor(private readonly pool: DbPool, private readonly botUserId: string | null = null) {}
  async activityDetail(input: { kind: string; id: string; revision: string }) {
    const snapshot = await this.snapshot({ revision: input.revision, includeActivityDetails: true });
    const activity = deriveOperatorActivity(snapshot);
    const active = activity.active.find((candidate) => candidate.kind === input.kind && candidate.id === input.id);
    const story = active ?? activity.recent.find((candidate) => candidate.kind === input.kind && candidate.id === input.id);
    if (!story) return null;
    const detail = {
      kind: input.kind,
      id: input.id,
      story,
      active: Boolean(active),
      generatedAt: snapshot.generatedAt,
      revision: snapshot.revision,
    };
    if (input.kind === "release") {
      const deployment = snapshot.deployments.find((candidate) => `release-${candidate.deploymentId}` === input.id);
      return deployment ? { ...detail, release: await releaseActivityDetail(this.pool, deployment) } : detail;
    }
    if (input.kind === "message" && input.id.startsWith("message-")) return {
      ...detail, message: await messageActivityDetail(this.pool, input.id.slice("message-".length), this.botUserId),
    };
    if (input.kind === "improvement" && input.id.startsWith("improvement-"))
      return { ...detail, traceEvents: await improvementActivityTrace(this.pool, story.relatedImprovementCaseIds) };
    if (input.kind !== "conversation") return detail;
    const executionId = executionIdFromActivityId(input.id);
    if (!executionId) return { ...detail, messages: [] };
    const execution = await this.pool.query(
      `SELECT execution.execution_id,execution.session_id,
              coalesce(delivery.source_message_id,nullif(execution.metadata->>'discordMessageId',''),session.trace_id) AS source_message_id,
              coalesce(delivery.guild_id,session.guild_id) AS guild_id
       FROM agent_runtime_executions execution
       JOIN agent_runtime_sessions session USING (session_id)
       LEFT JOIN discord_delivery_obligations delivery USING (execution_id)
       WHERE execution.execution_id = $1
       LIMIT 1`,
      [executionId],
    );
    const context = execution.rows[0];
    if (!context) return { ...detail, executionId, messages: [] };
    const sourceMessageId = nullable(context.source_message_id);
    const guildId = nullable(context.guild_id);
    const [archive, runtime, trace] = await Promise.all([
      sourceMessageId
        ? this.pool.query(
          `WITH RECURSIVE chain AS (
             SELECT message.id,message.guild_id,message.channel_id,message.author_id,
                    left(message.content,8000) AS content,message.created_at,message.deleted_at,
                    message.referenced_message_id,0 AS depth,ARRAY[message.id]::text[] AS path
             FROM messages message
             WHERE message.id = $1 AND ($2::text IS NULL OR message.guild_id = $2)
             UNION ALL
             SELECT parent.id,parent.guild_id,parent.channel_id,parent.author_id,
                    left(parent.content,8000),parent.created_at,parent.deleted_at,
                    parent.referenced_message_id,chain.depth + 1,chain.path || parent.id
             FROM chain
             JOIN messages parent ON parent.id = chain.referenced_message_id
                                  AND parent.guild_id = chain.guild_id
             WHERE chain.depth < 23 AND NOT parent.id = ANY(chain.path)
           )
           SELECT chain.id,chain.guild_id,chain.channel_id,chain.content,chain.created_at,
                  chain.deleted_at,chain.depth,user_row.is_bot,
                  coalesce(member.display_name,member.nickname,user_row.global_name,user_row.username) AS author_label,
                  coalesce(attachment_rows.items,'[]'::jsonb) AS attachments
           FROM chain
           JOIN discord_users user_row ON user_row.id = chain.author_id
           LEFT JOIN guild_members member ON member.guild_id = chain.guild_id AND member.user_id = chain.author_id
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
               'filename',attachment.filename,'contentType',attachment.content_type,'sizeBytes',attachment.size_bytes
             ) ORDER BY attachment.id) AS items
             FROM attachments attachment WHERE attachment.message_id = chain.id
           ) attachment_rows ON true
           ORDER BY chain.depth DESC`,
          [sourceMessageId, guildId],
        )
        : Promise.resolve({ rows: [] }),
      this.pool.query(
        `SELECT message_id,client_message_id,role,parts,metadata,created_at
         FROM agent_runtime_messages
         WHERE session_id = $1
           AND metadata->>'executionId' = $2
           AND role IN ('user','assistant')
         ORDER BY created_at ASC,message_id ASC
         LIMIT 20`,
        [String(context.session_id), executionId],
      ),
      this.pool.query(
        `SELECT id,sequence,kind,level,event_name,summary,metadata,duration_ms,
                span_id,parent_span_id,created_at
         FROM agent_runtime_events
         WHERE execution_id = $1
         ORDER BY sequence ASC,id ASC
         LIMIT 200`,
        [executionId],
      ),
    ]);
    const fallbackIds = archive.rows
      .filter((row) => row.is_bot && !String(row.content || "").trim())
      .map((row) => String(row.id));
    const fallbackRows = fallbackIds.length
      ? await this.pool.query(
        `SELECT client_message_id,parts FROM agent_runtime_messages
         WHERE role = 'assistant' AND client_message_id = ANY($1::text[])
         ORDER BY created_at DESC,message_id DESC`,
        [fallbackIds],
      )
      : { rows: [] };
    const fallbackContent = new Map<string, string>();
    for (const row of fallbackRows.rows) {
      const id = nullable(row.client_message_id);
      const content = runtimeMessageText(row.parts);
      if (id && content && !fallbackContent.has(id)) fallbackContent.set(id, content);
    }
    const messages = archive.rows.map((row) => {
      const id = String(row.id);
      const archivedContent = String(row.content || "").trim();
      const content = archivedContent || fallbackContent.get(id) || "";
      const attachments = dashboardAttachments(row.attachments);
      return {
        id,
        role: row.is_bot ? "assistant" : "member",
        author: nullable(row.author_label) ?? (row.is_bot ? "Assistant" : "Member"),
        content,
        attachments,
        unavailable: !content && attachments.length === 0,
        deleted: row.deleted_at != null,
        retained: !archivedContent && Boolean(fallbackContent.get(id)),
        directParent: Number(row.depth) === 1,
        current: id === sourceMessageId,
        reply: false,
        createdAt: date(row.created_at),
        url: discordUrl(row.guild_id, row.channel_id, row.id),
      };
    });
    const seen = new Set(messages.map((message) => message.id));
    for (const row of runtime.rows) {
      const content = runtimeMessageText(row.parts);
      if (!content) continue;
      const id = nullable(row.client_message_id) ?? String(row.message_id);
      if (seen.has(id)) continue;
      const metadata = record(row.metadata);
      const assistant = row.role === "assistant";
      messages.push({
        id,
        role: assistant ? "assistant" : "member",
        author: assistant ? "Assistant" : nullable(metadata.userDisplayName) ?? "Member",
        content,
        attachments: [],
        unavailable: false,
        deleted: false,
        retained: false,
        directParent: false,
        current: !assistant,
        reply: assistant,
        createdAt: date(row.created_at),
        url: safeDiscordUrl(metadata.discordUrl),
      });
      seen.add(id);
    }
    messages.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    return { ...detail, executionId, messages, traceEvents: trace.rows.map(dashboardTraceEvent) };
  }

  async snapshot(input: { revision: string; now?: Date; includeActivityDetails?: boolean }) {
    const now = input.now ?? new Date();
    const activityEventLimit = input.includeActivityDetails ? 12 : 1;
    const heartbeatTable = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'service_runtime_heartbeats'
       ) AS available`,
    );
    const heartbeatAvailable = Boolean(heartbeatTable.rows[0]?.available);
    const heartbeatQuery = heartbeatAvailable
      ? this.pool.query(
        `SELECT component,instance_id,revision,started_at,last_seen_at
         FROM service_runtime_heartbeats
         WHERE last_seen_at >= $1::timestamptz - interval '7 days'
         ORDER BY component,last_seen_at DESC`,
        [now],
      )
      : Promise.resolve({ rows: [] });
    const [heartbeats, executions, tasks, cases, caseCounts, runtimeEvents, taskEvents, caseEvents, deployments, producers, messages] = await Promise.all([
      heartbeatQuery,
      this.pool.query(
        `SELECT execution.execution_id,execution.session_id,execution.task_id,execution.status,
                execution.model,execution.provider,execution.pr_url,execution.started_at,
                execution.created_at,execution.updated_at,
                coalesce(nullif(execution.metadata->>'title',''),session.title) AS title,
                left(session.request,240) AS request_preview,
                coalesce(nullif(execution.metadata->>'jobKind',''),nullif(session.metadata->>'jobKind','')) AS rollup_key,
                nullif(execution.metadata->>'responseStatus','') AS response_status,
                delivery.state AS delivery_state,
                delivery.guild_id AS delivery_guild_id,delivery.channel_id AS delivery_channel_id,
                delivery.source_message_id,delivery.status_channel_id,delivery.status_message_id,
                (source_message.referenced_message_id IS NOT NULL) AS has_parent,
                latest.event_name AS latest_event,count(*) OVER ()::int AS total_count
         FROM agent_runtime_executions execution
         JOIN agent_runtime_sessions session USING (session_id)
         LEFT JOIN discord_delivery_obligations delivery USING (execution_id)
         LEFT JOIN messages source_message
           ON source_message.id = delivery.source_message_id
          AND source_message.guild_id = delivery.guild_id
         LEFT JOIN LATERAL (
           SELECT event_name FROM agent_runtime_events event
           WHERE event.execution_id = execution.execution_id
           ORDER BY sequence DESC LIMIT 1
         ) latest ON true
         WHERE execution.status IN ('queued','running')
           AND coalesce(nullif(execution.metadata->>'qualityCohort',''),nullif(session.metadata->>'qualityCohort','')) IS DISTINCT FROM 'synthetic'
         ORDER BY execution.updated_at DESC LIMIT 30`,
      ),
      this.pool.query(
        `SELECT task_id,improvement_case_id,task_type,title,status,current_step,status_message,
                branch_name,pr_url,verify_passed,guild_id,channel_id,trace_id,
                discord_response_channel_id,discord_response_message_id,created_at,started_at,updated_at
                ,count(*) OVER ()::int AS total_count
         FROM agent_tasks WHERE status IN ('queued','running')
           AND task_type <> 'post-deploy-canary'
         ORDER BY updated_at DESC LIMIT 30`,
      ),
      this.pool.query(
        `SELECT case_row.case_id,case_row.title,case_row.status,case_row.classification,
                case_row.severity,case_row.owning_domain,case_row.automation_state,
                case_row.automation_blocker,case_row.automation_next_action,
                case_row.automation_retry_trigger,case_row.automation_retry_at,
                case_row.automation_last_progress_at,case_row.first_seen_at,case_row.last_seen_at,
                work.pull_request_url,work.status AS work_status,related.related_case_ids
         FROM improvement_cases case_row
         LEFT JOIN LATERAL (
           SELECT pull_request_url,status FROM improvement_work_attempts attempt
           WHERE attempt.case_id = case_row.case_id
           ORDER BY attempt.created_at DESC LIMIT 1
         ) work ON true
         ${RELATED_CASES_FOR_IMPROVEMENT_SQL}
         WHERE case_row.merged_into_case_id IS NULL
           AND case_row.status NOT IN ('resolved','dismissed')
         ORDER BY
           CASE case_row.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           case_row.updated_at DESC LIMIT 40`,
      ),
      this.pool.query(
        `SELECT status,count(*)::int AS count,
                count(*) FILTER (WHERE automation_state = 'blocked' OR severity = 'critical')::int AS attention_count
         FROM improvement_cases
         WHERE merged_into_case_id IS NULL GROUP BY status ORDER BY status`,
      ),
      this.pool.query(
        `WITH execution_rollup AS (
           SELECT execution.execution_id,execution.session_id,execution.attempt,
                  coalesce(execution.started_at,execution.created_at) AS story_started_at,
                  execution.updated_at AS story_updated_at,
                  (session.harness = 'background_job' OR session.metadata->>'kind' = 'background_job') AS is_system
           FROM agent_runtime_executions execution
           JOIN agent_runtime_sessions session USING (session_id)
           WHERE execution.task_id IS NULL
             AND execution.status NOT IN ('queued','running')
             AND coalesce(nullif(execution.metadata->>'qualityCohort',''),nullif(session.metadata->>'qualityCohort','')) IS DISTINCT FROM 'synthetic'
             AND execution.updated_at >= $1::timestamptz - interval '24 hours'
         )
         SELECT recent.execution_id,recent.session_id,recent.attempt,recent.story_started_at,recent.story_updated_at,recent.is_system,
                coalesce(nullif(execution.metadata->>'title',''),session.title) AS title,
                execution.status,
                coalesce(nullif(execution.metadata->>'jobKind',''),nullif(session.metadata->>'jobKind','')) AS rollup_key,
                nullif(execution.metadata->>'responseStatus','') AS response_status,
                delivery.state AS delivery_state,
                delivery.guild_id AS delivery_guild_id,delivery.channel_id AS delivery_channel_id,
                delivery.source_message_id,delivery.status_channel_id,delivery.status_message_id,
                (source_message.referenced_message_id IS NOT NULL) AS has_parent,
                event.id,event.event_name,event.level,event.created_at,
                event.group_event_count,linked.related_case_ids
         FROM execution_rollup recent
         JOIN agent_runtime_executions execution ON execution.execution_id = recent.execution_id
         JOIN agent_runtime_sessions session ON session.session_id = recent.session_id
         LEFT JOIN discord_delivery_obligations delivery ON delivery.execution_id = recent.execution_id
         LEFT JOIN messages source_message
           ON source_message.id = delivery.source_message_id
          AND source_message.guild_id = delivery.guild_id
         ${RELATED_CASES_FOR_EXECUTION_SQL}
         LEFT JOIN LATERAL (
           SELECT candidate.id,candidate.event_name,candidate.level,candidate.created_at,
                  count(*) OVER ()::int AS group_event_count
           FROM agent_runtime_events candidate
           WHERE candidate.execution_id = recent.execution_id
           ORDER BY candidate.created_at DESC,candidate.id DESC
           LIMIT ${activityEventLimit}
         ) event ON true
         ORDER BY recent.story_updated_at DESC,event.created_at DESC,event.id DESC`,
        [now],
      ),
      this.pool.query(
        `WITH recent_tasks AS (
           SELECT * FROM agent_tasks
           WHERE status NOT IN ('queued','running')
             AND task_type <> 'post-deploy-canary'
             AND updated_at >= $1::timestamptz - interval '7 days'
             AND (
               improvement_case_id IS NOT NULL
               OR created_at >= coalesce(
                 (SELECT applied_at FROM schema_migrations WHERE version = '039_improvement_cases'),
                 '-infinity'::timestamptz
               )
             )
           ORDER BY updated_at DESC,created_at DESC
         )
         SELECT task.task_id,task.task_type,task.title,task.status,task.status_message,task.current_step,task.error,
                task.branch_name,task.pr_url,task.verify_passed,task.improvement_case_id,
                task.guild_id,task.channel_id,task.trace_id,
                task.discord_response_channel_id,task.discord_response_message_id,
                coalesce(task.started_at,task.created_at) AS story_started_at,
                task.updated_at AS story_updated_at,
                event.id,event.event_name,event.level,event.created_at,event.group_event_count
         FROM recent_tasks task
         LEFT JOIN agent_runtime_executions execution USING (task_id)
         LEFT JOIN LATERAL (
           SELECT candidate.id,candidate.event_name,candidate.level,candidate.created_at,
                  count(*) OVER ()::int AS group_event_count
           FROM agent_runtime_events candidate
           WHERE candidate.execution_id = execution.execution_id
           ORDER BY candidate.created_at DESC,candidate.id DESC
           LIMIT ${activityEventLimit}
         ) event ON true
         ORDER BY task.updated_at DESC,event.created_at DESC,event.id DESC`,
        [now],
      ),
      this.pool.query(
        `WITH recent_cases AS (
           SELECT event.case_id,max(event.created_at) AS story_updated_at
           FROM improvement_case_events event
           JOIN improvement_cases case_row USING (case_id)
           WHERE event.created_at >= $1::timestamptz - interval '7 days'
             AND case_row.merged_into_case_id IS NULL
             AND event.event_name NOT IN ('signal.received','signal.withdrawn','signal.reactivated','case.coalesced','evidence.attached','reconciliation.health_changed')
           GROUP BY event.case_id
           ORDER BY story_updated_at DESC
         )
         SELECT recent.case_id,recent.story_updated_at,
                case_row.title,case_row.status,case_row.first_seen_at,
                event.event_id,event.event_name,event.actor_kind,event.created_at,event.group_event_count,
                work.pull_request_url,
                conversation.guild_id AS conversation_guild_id,
                conversation.source_channel_id,conversation.source_message_id,
                conversation.delivery_kind,conversation.delivery_channel_id,conversation.delivery_message_id,
                related.related_case_ids
         FROM recent_cases recent
         JOIN improvement_cases case_row USING (case_id)
         LEFT JOIN LATERAL (
           SELECT candidate.event_id,candidate.event_name,candidate.actor_kind,candidate.created_at,
                  count(*) OVER ()::int AS group_event_count
           FROM improvement_case_events candidate
           WHERE candidate.case_id = recent.case_id
             AND candidate.event_name NOT IN ('signal.received','signal.withdrawn','signal.reactivated','case.coalesced','evidence.attached','reconciliation.health_changed')
           ORDER BY candidate.created_at DESC,candidate.event_id DESC
           LIMIT ${activityEventLimit}
         ) event ON true
         LEFT JOIN LATERAL (
           SELECT pull_request_url FROM improvement_work_attempts attempt
           WHERE attempt.case_id = case_row.case_id AND attempt.pull_request_url IS NOT NULL
           ORDER BY attempt.created_at DESC LIMIT 1
         ) work ON true
         LEFT JOIN LATERAL (
           SELECT guild_id,source_channel_id,source_message_id,delivery_kind,delivery_channel_id,delivery_message_id
           FROM improvement_reporter_conversations candidate
           WHERE candidate.case_id = case_row.case_id
           ORDER BY candidate.updated_at DESC LIMIT 1
         ) conversation ON true
         ${RELATED_CASES_FOR_IMPROVEMENT_SQL}
         ORDER BY recent.story_updated_at DESC,event.created_at DESC,event.event_id DESC`,
        [now],
      ),
      this.pool.query(
        `SELECT revision,deployment_id,verified_at FROM deployment_verifications
         ORDER BY verified_at DESC LIMIT 8`,
      ),
      this.pool.query(
        `SELECT producer.trigger,producer.activated_at,run.status,run.revision,
                run.outcome_code,run.started_at,run.completed_at
         FROM improvement_proof_producers producer
         LEFT JOIN LATERAL (
           SELECT * FROM improvement_proof_producer_runs candidate
           WHERE candidate.trigger = producer.trigger
           ORDER BY candidate.started_at DESC,candidate.run_id DESC LIMIT 1
         ) run ON true ORDER BY producer.trigger`,
      ),
      recentMessageActivities(this.pool, now, this.botUserId),
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
    const improvementCounts = Object.fromEntries(caseCounts.rows.map((row) => [String(row.status), number(row.count)]));
    const openImprovementCount = caseCounts.rows
      .filter((row) => !["resolved", "dismissed"].includes(String(row.status)))
      .reduce((total, row) => total + number(row.count), 0);
    const attentionCount = caseCounts.rows.reduce((total, row) => total + number(row.attention_count), 0);
    const improvementRows = cases.rows.map((row) => ({
      caseId: String(row.case_id), title: String(row.title), status: String(row.status),
      classification: String(row.classification), severity: String(row.severity),
      owningDomain: nullable(row.owning_domain), automationState: String(row.automation_state),
      blocker: nullable(row.automation_blocker), nextAction: String(row.automation_next_action),
      retryTrigger: nullable(row.automation_retry_trigger), retryAt: nullableDate(row.automation_retry_at),
      lastProgressAt: date(row.automation_last_progress_at), firstSeenAt: date(row.first_seen_at), lastSeenAt: date(row.last_seen_at),
      pullRequestUrl: nullable(row.pull_request_url), workStatus: nullable(row.work_status),
      relatedImprovementCaseIds: textArray(row.related_case_ids),
    }));
    const activities = projectActivitySources(runtimeEvents.rows, taskEvents.rows, caseEvents.rows);
    return {
      generatedAt: now,
      revision: input.revision,
      services,
      summary: {
        healthyServices: services.filter((service) => service.status === "healthy").length,
        serviceCount: services.length,
        serviceTelemetryAvailable: heartbeatAvailable,
        activeRuns: number(executions.rows[0]?.total_count),
        activeTasks: number(tasks.rows[0]?.total_count),
        openImprovements: openImprovementCount,
        needsAttention: attentionCount,
      },
      executions: executions.rows.map((row) => ({
        executionId: String(row.execution_id), sessionId: String(row.session_id), taskId: nullable(row.task_id),
        status: String(row.status), model: nullable(row.model), provider: nullable(row.provider),
        pullRequestUrl: nullable(row.pr_url), title: String(row.title), requestPreview: String(row.request_preview),
        latestEvent: nullable(row.latest_event), rollupKey: nullable(row.rollup_key),
        responseStatus: nullable(row.response_status), deliveryState: nullable(row.delivery_state),
        sourceUrl: discordUrl(row.delivery_guild_id, row.delivery_channel_id, row.source_message_id),
        responseUrl: discordUrl(row.delivery_guild_id, row.status_channel_id, row.status_message_id),
        responseKind: row.status_message_id == null ? null : "reply",
        hasParent: Boolean(row.has_parent),
        startedAt: nullableDate(row.started_at),
        createdAt: date(row.created_at), updatedAt: date(row.updated_at),
      })),
      tasks: tasks.rows.map((row) => ({
        taskId: String(row.task_id), improvementCaseId: nullable(row.improvement_case_id),
        taskType: String(row.task_type), title: String(row.title), status: String(row.status),
        currentStep: nullable(row.current_step), statusMessage: nullable(row.status_message),
        branchName: nullable(row.branch_name), pullRequestUrl: nullable(row.pr_url),
        sourceUrl: discordUrl(row.guild_id, row.channel_id, row.trace_id),
        responseUrl: discordUrl(row.guild_id, row.discord_response_channel_id, row.discord_response_message_id),
        responseKind: row.discord_response_message_id == null ? null : "reply",
        verifyPassed: row.verify_passed == null ? null : Boolean(row.verify_passed),
        createdAt: date(row.created_at), startedAt: nullableDate(row.started_at), updatedAt: date(row.updated_at),
      })),
      improvements: { counts: improvementCounts, cases: improvementRows },
      messages,
      deployments: deployments.rows.map((row) => ({
        revision: String(row.revision), deploymentId: String(row.deployment_id), verifiedAt: date(row.verified_at),
      })),
      producers: producers.rows.map((row) => ({
        trigger: String(row.trigger), status: row.status == null ? "unobserved" : String(row.status),
        revision: nullable(row.revision), outcomeCode: nullable(row.outcome_code),
        activatedAt: date(row.activated_at), startedAt: nullableDate(row.started_at), completedAt: nullableDate(row.completed_at),
      })),
      activity: activities,
    };
  }
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
function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => item != null).map(String) : [];
}
function executionIdFromActivityId(id: string): string | null {
  if (id.startsWith("runtime-")) return id.slice("runtime-".length) || null;
  if (id.startsWith("execution-")) return id.slice("execution-".length) || null;
  return null;
}
function runtimeMessageText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const content = value.flatMap((part) => {
    const item = record(part);
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n").trim();
  return content ? content.slice(0, 8000) : null;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
const TRACE_METADATA_KEYS = new Set([
  "purpose", "requestedModel", "model", "reasoningEffort", "messageCount", "toolCount", "offeredTools",
  "maxTokens", "timeoutMs", "toolChoice", "finishReason", "usage", "estimatedCostUsd", "outputChars",
  "requestedToolCalls", "serverToolUse", "urlCitationCount", "toolName", "status", "fileCount", "tableCount",
  "errorCode", "errorName", "retryable", "latencyBudgetMs", "latencyBudgetExceeded", "successfulMutationCount",
  "resumed", "instructionBytes", "turnContextBytes", "toolSchemaBytes", "sizeBytes", "binary",
]);

function dashboardTraceEvent(row: Record<string, unknown>) {
  const eventName = String(row.event_name);
  const level = String(row.level || "info");
  const metadata = record(row.metadata);
  return {
    id: `trace-event-${row.id}`,
    sequence: number(row.sequence),
    type: traceEventType(eventName),
    title: traceEventTitle(eventName, metadata),
    summary: nullable(row.summary),
    status: level === "error" || /failed|failure|stalled/.test(eventName)
      ? "failed"
      : level === "warn" ? "blocked" : /started|queued/.test(eventName) ? "running" : "done",
    level,
    code: eventName,
    durationMs: row.duration_ms == null ? null : number(row.duration_ms),
    spanId: nullable(row.span_id),
    parentSpanId: nullable(row.parent_span_id),
    metadata: dashboardTraceMetadata(metadata),
    occurredAt: date(row.created_at),
  };
}

function traceEventType(eventName: string) {
  if (eventName.includes(".model.")) return "model";
  if (eventName.includes(".tool.")) return "tool";
  if (eventName.includes("context") || eventName.includes("contract_prepared")) return "context";
  if (eventName.startsWith("discord.delivery")) return "delivery";
  if (eventName.includes("artifact")) return "artifact";
  if (eventName.includes("command") || eventName.includes("git") || eventName.includes("task")) return "task";
  if (eventName.includes("response") || eventName.includes("assistant.message")) return "response";
  return "event";
}

function traceEventTitle(eventName: string, metadata: Record<string, unknown>) {
  const toolName = nullable(metadata.toolName);
  if (eventName === "agent.tool.started") return toolName ? `${toolName} started` : "Tool started";
  if (eventName === "agent.tool.complete") return toolName ? `${toolName} completed` : "Tool completed";
  if (eventName === "agent.model.call.started") return "Model call started";
  if (eventName === "agent.model.call.completed") return "Model call completed";
  if (eventName === "agent.model.call.failed") return "Model call failed";
  if (eventName === "agent.execution.context_ready" || eventName === "agent.nanocodex.contract_prepared") return "Context assembled";
  if (eventName === "agent.execution.response_stored") return "Response stored";
  if (eventName === "discord.delivery.intent_stored") return "Discord delivery queued";
  return eventName.split(".").slice(-2).map((part) => part.replaceAll("_", " ")).join(" ").replace(/^./, (value) => value.toUpperCase());
}

function dashboardTraceMetadata(metadata: Record<string, unknown>) {
  return Object.fromEntries([...TRACE_METADATA_KEYS]
    .filter((key) => metadata[key] != null)
    .map((key) => [key, safeTraceValue(metadata[key])]));
}

function safeTraceValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 2) return undefined;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => safeTraceValue(item, depth + 1)).filter((item) => item !== undefined);
  const item = record(value);
  return Object.fromEntries(Object.entries(item).slice(0, 16)
    .map(([key, nested]) => [key, safeTraceValue(nested, depth + 1)])
    .filter(([, nested]) => nested !== undefined));
}
function safeDiscordUrl(value: unknown): string | null {
  const url = nullable(value);
  return url && /^https:\/\/discord\.com\/channels\//.test(url) ? url : null;
}

function dashboardAttachments(value: unknown): Array<{ filename: string | null; contentType: string | null; sizeBytes: number | null }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((attachment) => {
    const item = record(attachment);
    const parsedSize = Number(item.sizeBytes);
    return {
      filename: nullable(item.filename),
      contentType: nullable(item.contentType),
      sizeBytes: Number.isFinite(parsedSize) ? parsedSize : null,
    };
  });
}

function projectActivitySources(
  runtimeRows: Array<Record<string, unknown>>,
  taskRows: Array<Record<string, unknown>>,
  caseRows: Array<Record<string, unknown>>,
): OperatorActivitySource[] {
  const groups = new Map<string, OperatorActivitySource>();
  for (const row of runtimeRows) {
    const key = `runtime-${row.execution_id}`;
    const occurredAt = date(row.story_updated_at);
    const startedAt = date(row.story_started_at);
    const group = groups.get(key) ?? {
      id: key,
      kind: row.is_system ? "system" as const : "runtime" as const,
      title: String(row.title),
      status: nullable(row.status),
      detail: null,
      occurredAt,
      startedAt,
      durationMs: Math.max(0, occurredAt.getTime() - startedAt.getTime()),
      attempts: number(row.attempt) || 1,
      eventCount: number(row.group_event_count) || 1,
      rollupKey: nullable(row.rollup_key),
      responseStatus: nullable(row.response_status),
      deliveryState: nullable(row.delivery_state),
      sourceUrl: discordUrl(row.delivery_guild_id, row.delivery_channel_id, row.source_message_id),
      responseUrl: discordUrl(row.delivery_guild_id, row.status_channel_id, row.status_message_id),
      responseKind: row.status_message_id == null ? null : "reply",
      hasParent: Boolean(row.has_parent),
      pullRequestUrl: null,
      branchName: null,
      improvementCaseId: null,
      relatedImprovementCaseIds: textArray(row.related_case_ids),
      failureReason: null,
      events: [],
    };
    if (row.id != null && group.events.length < 12) group.events.push({
      id: `runtime-event-${row.id}`,
      name: String(row.event_name),
      level: String(row.level),
      createdAt: date(row.created_at),
    });
    groups.set(key, group);
  }
  for (const row of taskRows) {
    const key = `task-${row.task_id}`;
    const occurredAt = date(row.story_updated_at);
    const startedAt = date(row.story_started_at);
    const group = groups.get(key) ?? {
      id: key,
      kind: row.task_type === "improvement_report" ? "system" as const : "code_change" as const,
      title: String(row.title),
      status: nullable(row.status),
      detail: nullable(row.status_message) ?? nullable(row.current_step),
      occurredAt,
      startedAt,
      durationMs: Math.max(0, occurredAt.getTime() - startedAt.getTime()),
      attempts: 1,
      eventCount: number(row.group_event_count),
      rollupKey: row.task_type === "improvement_report" ? "improvement_report" : null,
      responseStatus: null,
      deliveryState: null,
      sourceUrl: discordUrl(row.guild_id, row.channel_id, row.trace_id),
      responseUrl: discordUrl(row.guild_id, row.discord_response_channel_id, row.discord_response_message_id),
      responseKind: row.discord_response_message_id == null ? null : "reply",
      hasParent: false,
      pullRequestUrl: nullable(row.pr_url),
      branchName: nullable(row.branch_name),
      improvementCaseId: nullable(row.improvement_case_id),
      relatedImprovementCaseIds: nullable(row.improvement_case_id) ? [String(row.improvement_case_id)] : [],
      failureReason: operatorTaskFailureSummary(row.status, row.error),
      events: [],
    };
    if (row.id != null && group.events.length < 12) group.events.push({
      id: `task-event-${row.id}`,
      name: String(row.event_name),
      level: String(row.level),
      createdAt: date(row.created_at),
    });
    groups.set(key, group);
  }
  for (const row of caseRows) {
    const key = `improvement-${row.case_id}`;
    const occurredAt = date(row.story_updated_at);
    const eventName = String(row.event_name);
    const group = groups.get(key) ?? {
      id: key,
      kind: "improvement" as const,
      title: String(row.title),
      status: String(row.status),
      detail: eventName,
      occurredAt,
      startedAt: date(row.first_seen_at),
      durationMs: null,
      attempts: null,
      eventCount: number(row.group_event_count) || 1,
      rollupKey: null,
      responseStatus: null,
      deliveryState: null,
      sourceUrl: discordUrl(row.conversation_guild_id, row.source_channel_id, row.source_message_id),
      responseUrl: discordConversationUrl(
        row.conversation_guild_id,
        row.delivery_kind,
        row.delivery_channel_id,
        row.delivery_message_id,
      ),
      responseKind: nullable(row.delivery_kind),
      hasParent: false,
      pullRequestUrl: nullable(row.pull_request_url),
      branchName: null,
      improvementCaseId: String(row.case_id),
      relatedImprovementCaseIds: textArray(row.related_case_ids),
      failureReason: null,
      events: [],
    };
    if (row.event_id != null && group.events.length < 12) group.events.push({
      id: `improvement-event-${row.event_id}`,
      name: eventName,
      level: eventName.endsWith("failed") || eventName.endsWith("stalled") ? "warn" : "info",
      createdAt: date(row.created_at),
    });
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
}

function discordUrl(guildId: unknown, channelId: unknown, messageId: unknown): string | null {
  if (guildId == null || channelId == null || messageId == null) return null;
  return `https://discord.com/channels/${encodeURIComponent(String(guildId))}/${encodeURIComponent(String(channelId))}/${encodeURIComponent(String(messageId))}`;
}
function discordConversationUrl(guildId: unknown, deliveryKind: unknown, channelId: unknown, messageId: unknown): string | null {
  if (channelId == null || messageId == null) return null;
  const scope = deliveryKind === "dm" ? "@me" : guildId == null ? null : String(guildId);
  if (scope == null) return null;
  const encodedScope = scope === "@me" ? scope : encodeURIComponent(scope);
  return `https://discord.com/channels/${encodedScope}/${encodeURIComponent(String(channelId))}/${encodeURIComponent(String(messageId))}`;
}
