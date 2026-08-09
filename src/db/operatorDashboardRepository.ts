import type { DbPool } from "./pool.js";
import { releaseActivityDetail } from "./operatorActivityDetailRepository.js";
import { messageActivityDetail, recentMessageActivities } from "./operatorMessageActivityRepository.js";
import { improvementActivityContext, improvementActivityTrace } from "./operatorImprovementActivityRepository.js";
import { codeChangeActivityDetail } from "./operatorCodeChangeActivityRepository.js";
import { RELATED_CASES_FOR_EXECUTION_SQL, RELATED_CASES_FOR_IMPROVEMENT_SQL } from "./operatorActivityLinks.js";
import { projectActivitySources } from "./operatorDashboardProjection.js";
import { OPERATOR_ACTIVITY_WINDOW_DAYS, recentTaskActivityQuery } from "./operatorDashboardActivityQueries.js";
import { dashboardTraceEvent, executionActivityTrace } from "./operatorRuntimeActivityRepository.js";
import { discordMentionLabels, discordMentions, discordRoleMentions, resolvedDiscordSourceTitle } from "./operatorDiscordIdentity.js";
import { deriveOperatorActivity, retainOpenImprovementActivity, summarizeOperatorActivity } from "../console/activity.js";
import { paginateActivity, type ActivityPageRequest } from "../console/server.js";
const COMPONENTS = ["bot", "worker", "api", "console"] as const;
export class OperatorDashboardRepository {
  constructor(private readonly pool: DbPool) {}
  async overview(input: { revision: string }) {
    const snapshot = await this.snapshot({ revision: input.revision, includeRecentActivity: false });
    return {
      generatedAt: snapshot.generatedAt,
      revision: snapshot.revision,
      services: snapshot.services,
      producers: snapshot.producers,
      deployments: snapshot.deployments,
      summary: snapshot.summary,
    };
  }
  async activityPage(input: ActivityPageRequest & { revision: string }) {
    const activityTypes = input.types?.length ? input.types : ["conversation", "improvement", "code_change"];
    const snapshot = await this.snapshot({
      revision: input.revision,
      activityOnly: true,
      activityTypes,
    });
    const activity = summarizeOperatorActivity(retainOpenImprovementActivity(
      deriveOperatorActivity(snapshot),
      snapshot.improvements,
    ));
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
    if (input.kind === "improvement" && input.id.startsWith("improvement-")) {
      const caseId = input.id.slice("improvement-".length);
      const related = await this.pool.query(
        `SELECT case_id,merged_into_case_id FROM improvement_cases
         WHERE case_id = $1 OR merged_into_case_id = $1
         ORDER BY CASE WHEN case_id = $1 THEN 0 ELSE 1 END,case_id`,
        [caseId],
      );
      const caseIds = [...new Set(related.rows.flatMap((row) => [nullable(row.case_id), nullable(row.merged_into_case_id)]).filter((value): value is string => Boolean(value)))];
      if (!caseIds.length) return null;
      const [traceEvents, improvement] = await Promise.all([
        improvementActivityTrace(this.pool, caseIds),
        improvementActivityContext(this.pool, caseIds, caseId),
      ]);
      return { ...detail, traceEvents, improvement };
    }
    if (input.kind === "code_change" && input.id.startsWith("code-change-")) {
      const codeChange = await codeChangeActivityDetail(this.pool, input.id);
      return codeChange ? { ...detail, ...codeChange } : null;
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
    const executionId = executionIdFromActivityId(input.id);
    if (!executionId) return null;
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
    if (!context) return null;
    const sourceMessageId = nullable(context.source_message_id);
    const guildId = nullable(context.guild_id);
    const [archive, runtime, trace] = await Promise.all([
      sourceMessageId
        ? this.pool.query(
          `WITH RECURSIVE chain AS (
             SELECT message.id,message.guild_id,message.channel_id,message.author_id,message.raw,
                    left(message.content,8000) AS content,message.created_at,message.deleted_at,
                    message.referenced_message_id,0 AS depth,ARRAY[message.id]::text[] AS path
             FROM messages message
             WHERE message.id = $1 AND ($2::text IS NULL OR message.guild_id = $2)
             UNION ALL
             SELECT parent.id,parent.guild_id,parent.channel_id,parent.author_id,parent.raw,
                    left(parent.content,8000),parent.created_at,parent.deleted_at,
                    parent.referenced_message_id,chain.depth + 1,chain.path || parent.id
             FROM chain
             JOIN messages parent ON parent.id = chain.referenced_message_id
                                  AND parent.guild_id = chain.guild_id
             WHERE chain.depth < 23 AND NOT parent.id = ANY(chain.path)
           )
           SELECT chain.id,chain.guild_id,chain.channel_id,chain.content,chain.raw,chain.created_at,
                  chain.deleted_at,chain.depth,user_row.is_bot,
                  coalesce(member.display_name,member.nickname,user_row.global_name,user_row.username) AS author_label,
                  coalesce(attachment_rows.items,'[]'::jsonb) AS attachments
           FROM chain
           JOIN discord_users user_row ON user_row.id = chain.author_id AND user_row.deleted_at IS NULL
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
    const mentionLabels = await discordMentionLabels(
      this.pool,
      [
        ...archive.rows.map((row) => ({ guild_id: row.guild_id, content: row.content, raw: row.raw })),
        ...messages.map((message) => ({ guildId, content: message.content })),
      ],
    );
    const resolvedMessages = messages.map((message) => ({
      ...message,
      mentions: discordMentions(message.content, guildId, mentionLabels),
      roles: discordRoleMentions(message.content, guildId, mentionLabels),
    }));
    return { ...detail, executionId, messages: resolvedMessages, traceEvents: trace.rows.map(dashboardTraceEvent) };
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
    const activityTypes = new Set(input.activityTypes ?? ["conversation", "improvement", "code_change", "message", "release", "system"]);
    const includeConversation = activityTypes.has("conversation");
    const includeCodeChanges = activityTypes.has("code_change");
    const includeImprovements = activityTypes.has("improvement");
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
    const [heartbeats, executions, tasks, cases, caseCounts, runtimeEvents, taskEvents, caseEvents, deployments, producers, messages] = await Promise.all([
      heartbeatQuery,
      !activityOnly || includeConversation || includeSystem ? this.pool.query(
        `SELECT execution.execution_id,execution.session_id,execution.task_id,execution.status,
                execution.model,execution.provider,execution.pr_url,execution.started_at,
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
           AND coalesce(nullif(execution.metadata->>'qualityCohort',''),nullif(session.metadata->>'qualityCohort','')) IS DISTINCT FROM 'synthetic'
           AND coalesce(nullif(execution.metadata->>'source',''),nullif(session.metadata->>'source','')) IS DISTINCT FROM 'cli.prompt'
         ORDER BY execution.updated_at DESC LIMIT 30`,
      ) : emptyRows(),
      !activityOnly || includeCodeChanges || includeSystem ? this.pool.query(
        `WITH RECURSIVE task_roots AS (
           SELECT task_id,task_id AS root_task_id
           FROM agent_tasks WHERE retried_from_task_id IS NULL
           UNION ALL
           SELECT child.task_id,parent.root_task_id
           FROM agent_tasks child
           JOIN task_roots parent ON child.retried_from_task_id = parent.task_id
         ), catalog AS (
           SELECT task.*,
                  coalesce(root.root_task_id,task.task_id) AS root_task_id,
                  CASE
                    WHEN task.task_type = 'improvement_report' THEN 'system:' || coalesce(root.root_task_id,task.task_id)
                    WHEN task.improvement_case_id IS NOT NULL THEN 'case:' || task.improvement_case_id
                    ELSE 'task:' || coalesce(root.root_task_id,task.task_id)
                  END AS story_id
           FROM agent_tasks task
           LEFT JOIN task_roots root USING (task_id)
           WHERE task.task_type <> 'post-deploy-canary'
         ), active_groups AS (
           SELECT story_id,count(*)::int AS active_count,max(updated_at) AS updated_at
           FROM catalog WHERE status IN ('queued','running') GROUP BY story_id
         ), anchor AS (
           SELECT DISTINCT ON (catalog.story_id) catalog.*
           FROM catalog JOIN active_groups USING (story_id)
           WHERE catalog.status IN ('queued','running')
           ORDER BY catalog.story_id,catalog.updated_at DESC,catalog.created_at DESC,catalog.task_id DESC
         )
         SELECT anchor.task_id,anchor.root_task_id,anchor.story_id,anchor.improvement_case_id,
                anchor.task_type,coalesce(case_row.title,anchor.title) AS title,
                anchor.status,anchor.current_step,anchor.status_message,
                anchor.branch_name,anchor.pr_url,anchor.verify_passed,
                anchor.guild_id,anchor.channel_id,anchor.trace_id,
                anchor.discord_response_channel_id,anchor.discord_response_message_id,
                anchor.created_at,anchor.started_at,anchor.updated_at,
                stats.attempts,stats.failed_attempts,
                count(*) OVER ()::int AS total_count
         FROM anchor
         LEFT JOIN improvement_cases case_row ON case_row.case_id = anchor.improvement_case_id
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS attempts,
                  count(*) FILTER (WHERE candidate.status = 'failed')::int AS failed_attempts
           FROM catalog candidate WHERE candidate.story_id = anchor.story_id
         ) stats ON true
         ORDER BY anchor.updated_at DESC LIMIT 30`,
      ) : emptyRows(),
      !activityOnly || includeImprovements ? this.pool.query(
        `SELECT case_row.case_id,case_row.title,case_row.status,case_row.classification,
                case_row.severity,case_row.owning_domain,case_row.automation_state,
                case_row.automation_blocker,case_row.automation_next_action,
                case_row.automation_retry_trigger,case_row.automation_retry_at,
                case_row.automation_last_progress_at,case_row.first_seen_at,case_row.last_seen_at,
                work.pull_request_url,work.status AS work_status,related.related_case_ids,
                report.preview AS report_preview,report.author_is_bot AS report_author_is_bot,
                report.has_execution AS report_has_execution
         FROM improvement_cases case_row
         LEFT JOIN LATERAL (
           SELECT pull_request_url,status FROM improvement_work_attempts attempt
           WHERE attempt.case_id = case_row.case_id
           ORDER BY attempt.created_at DESC LIMIT 1
         ) work ON true
         LEFT JOIN LATERAL (
           SELECT left(regexp_replace(message.content,'\\s+',' ','g'),240) AS preview,
                  coalesce(author.is_bot,false) AS author_is_bot,
                  signal.execution_id IS NOT NULL AS has_execution
           FROM improvement_signals signal
           JOIN messages message
             ON message.id = signal.message_id
            AND message.guild_id = signal.guild_id
            AND message.channel_id = signal.channel_id
           JOIN discord_users author ON author.id = message.author_id
           WHERE signal.case_id = case_row.case_id
             AND signal.source = 'member_report'
             AND signal.active = true
             AND message.deleted_at IS NULL
             AND message.normalized_content <> ''
           ORDER BY signal.observed_at DESC,signal.signal_id DESC
           LIMIT 1
         ) report ON true
         ${RELATED_CASES_FOR_IMPROVEMENT_SQL}
         WHERE case_row.merged_into_case_id IS NULL
           AND case_row.status NOT IN ('resolved','dismissed')
         ORDER BY
           CASE case_row.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           case_row.updated_at DESC LIMIT 40`,
      ) : emptyRows(),
      activityOnly ? emptyRows() : this.pool.query(
        `SELECT status,count(*)::int AS count,
                count(*) FILTER (WHERE automation_state = 'blocked' OR severity = 'critical')::int AS attention_count
         FROM improvement_cases
         WHERE merged_into_case_id IS NULL GROUP BY status ORDER BY status`,
      ),
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
         SELECT recent.execution_id,recent.session_id,recent.attempt,recent.story_started_at,recent.story_updated_at,recent.is_system,
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
                event.group_event_count,linked.related_case_ids
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
        [now, includeConversation, includeSystem],
      ) : emptyRows(),
      includeRecentActivity && (includeCodeChanges || includeSystem)
        ? this.pool.query(recentTaskActivityQuery(activityEventLimit, includeSystem), [now])
        : emptyRows(),
      includeRecentActivity && includeImprovements ? this.pool.query(
        `WITH recent_cases AS (
           SELECT event.case_id,max(event.created_at) AS story_updated_at
           FROM improvement_case_events event
           JOIN improvement_cases case_row USING (case_id)
           WHERE event.created_at >= $1::timestamptz - make_interval(days => ${OPERATOR_ACTIVITY_WINDOW_DAYS})
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
                related.related_case_ids,
                report.preview AS report_preview,report.author_is_bot AS report_author_is_bot,
                report.has_execution AS report_has_execution
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
         LEFT JOIN LATERAL (
           SELECT left(regexp_replace(message.content,'\\s+',' ','g'),240) AS preview,
                  coalesce(author.is_bot,false) AS author_is_bot,
                  signal.execution_id IS NOT NULL AS has_execution
           FROM improvement_signals signal
           JOIN messages message
             ON message.id = signal.message_id
            AND message.guild_id = signal.guild_id
            AND message.channel_id = signal.channel_id
           JOIN discord_users author ON author.id = message.author_id
           WHERE signal.case_id = case_row.case_id
             AND signal.source = 'member_report'
             AND signal.active = true
             AND message.deleted_at IS NULL
             AND message.normalized_content <> ''
           ORDER BY signal.observed_at DESC,signal.signal_id DESC
           LIMIT 1
         ) report ON true
         ${RELATED_CASES_FOR_IMPROVEMENT_SQL}
         ORDER BY recent.story_updated_at DESC,event.created_at DESC,event.event_id DESC`,
        [now],
      ) : emptyRows(),
      !activityOnly || includeRecentActivity && includeReleases ? this.pool.query(
        `SELECT revision,deployment_id,verified_at FROM deployment_verifications
         WHERE verified_at >= $1::timestamptz - make_interval(days => ${OPERATOR_ACTIVITY_WINDOW_DAYS})
         ORDER BY verified_at DESC`,
        [now],
      ) : emptyRows(),
      activityOnly ? emptyRows() : this.pool.query(
        `SELECT producer.trigger,producer.activated_at,run.status,run.revision,
                run.outcome_code,run.started_at,run.completed_at
         FROM improvement_proof_producers producer
         LEFT JOIN LATERAL (
           SELECT * FROM improvement_proof_producer_runs candidate
           WHERE candidate.trigger = producer.trigger
           ORDER BY candidate.started_at DESC,candidate.run_id DESC LIMIT 1
         ) run ON true ORDER BY producer.trigger`,
      ),
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
    const improvementCounts = Object.fromEntries(caseCounts.rows.map((row) => [String(row.status), number(row.count)]));
    const openImprovementCount = caseCounts.rows
      .filter((row) => !["resolved", "dismissed"].includes(String(row.status)))
      .reduce((total, row) => total + number(row.count), 0);
    const attentionCount = caseCounts.rows.reduce((total, row) => total + number(row.attention_count), 0);
    const improvementRows = cases.rows.map((row) => ({
      caseId: String(row.case_id), title: improvementConsoleTitle(row), status: String(row.status),
      classification: String(row.classification), severity: String(row.severity),
      owningDomain: nullable(row.owning_domain), automationState: String(row.automation_state),
      blocker: nullable(row.automation_blocker), nextAction: String(row.automation_next_action),
      retryTrigger: nullable(row.automation_retry_trigger), retryAt: nullableDate(row.automation_retry_at),
      lastProgressAt: date(row.automation_last_progress_at), firstSeenAt: date(row.first_seen_at), lastSeenAt: date(row.last_seen_at),
      pullRequestUrl: nullable(row.pull_request_url), workStatus: nullable(row.work_status),
      relatedImprovementCaseIds: textArray(row.related_case_ids),
    }));
    const promptMentionLabels = await discordMentionLabels(this.pool, [...executions.rows, ...runtimeEvents.rows].map((row) => ({
      guild_id: row.delivery_guild_id, content: row.source_message_content, raw: row.source_message_raw,
    })));
    const runtimeActivityRows = runtimeEvents.rows.map((row) => ({
      ...row,
      title: resolvedDiscordSourceTitle(row.source_message_content, row.delivery_guild_id, row.title, promptMentionLabels),
    }));
    const activities = projectActivitySources(runtimeActivityRows, taskEvents.rows, caseEvents.rows);
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
        pullRequestUrl: nullable(row.pr_url),
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
      tasks: tasks.rows.map((row) => ({
        taskId: String(row.task_id), improvementCaseId: nullable(row.improvement_case_id),
        storyId: nullable(row.story_id), rootTaskId: nullable(row.root_task_id),
        taskType: String(row.task_type), title: String(row.title), status: String(row.status),
        currentStep: nullable(row.current_step), statusMessage: nullable(row.status_message),
        branchName: nullable(row.branch_name), pullRequestUrl: nullable(row.pr_url),
        attempts: number(row.attempts), failedAttempts: number(row.failed_attempts),
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
function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => item != null).map(String) : [];
}
function improvementConsoleTitle(row: Record<string, unknown>): string {
  const preview = consoleReportPreview(row.report_preview);
  if (!preview) return String(row.title);
  const subject = row.report_author_is_bot ? "reply" : row.report_has_execution ? "prompt" : "message";
  return `Reported ${subject}: ${preview}`;
}
function consoleReportPreview(value: unknown): string | null {
  const compact = nullable(value)
    ?.replace(/\s+-#\s+\d+(?:\.\d+)?s\s*$/i, "")
    .replaceAll("**", "")
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return null;
  return compact.length > 140 ? `${compact.slice(0, 137).trimEnd()}…` : compact;
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

function discordUrl(guildId: unknown, channelId: unknown, messageId: unknown): string | null {
  if (guildId == null || channelId == null || messageId == null) return null;
  return `https://discord.com/channels/${encodeURIComponent(String(guildId))}/${encodeURIComponent(String(channelId))}/${encodeURIComponent(String(messageId))}`;
}
