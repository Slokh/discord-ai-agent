import { createHash } from "node:crypto";
import type { DbPool } from "../db/pool.js";
import type { AutomatedImprovementDetectionInput } from "../improvements/detections.js";
import { TOOL_NAMES_BY_CAPABILITY } from "../tools/toolDefinition.js";

const MEMBER_COHORT_SQL = "coalesce(nullif(execution.metadata->>'qualityCohort', ''), nullif(session.metadata->>'qualityCohort', '')) = 'member'";
const SUCCESSFUL_TOOL_STATUSES = ["ok", "succeeded", "success", "reused"];
const MAX_CLUSTER_EXECUTIONS = 20;

export type RevisionQualityFailureKind = "runtime_event" | "tool" | "tool_latency" | "delivery" | "answer_status" | "quality_metric";

export type RevisionQualityFailureCluster = {
  reference: string;
  kind: RevisionQualityFailureKind;
  category: string | null;
  eventName: string | null;
  errorKind: string | null;
  errorCode: string | null;
  errorStatus: number | null;
  toolName: string | null;
  status: string | null;
  latencyBudgetMs: number | null;
  maxDurationMs: number | null;
  count: number;
};

export type RevisionQualityPrivateFailureCluster = RevisionQualityFailureCluster & {
  executionIds: string[];
};

export type RevisionQuality = {
  revision: string;
  windowHours: number;
  generatedAt: string;
  answers: Record<string, unknown>[];
  tools: Record<string, unknown>[];
  signals: Record<string, unknown>[];
  deliveries: Record<string, unknown>[];
  improvements: Record<string, unknown>[];
  failureClusters: RevisionQualityFailureCluster[];
};

export type RevisionHealthViolationCode =
  | "answer_failure_rate"
  | "tool_failure_rate"
  | "improvement_signal_rate"
  | "answer_latency"
  | "overdue_delivery"
  | "abandoned_delivery"
  | "runtime_error"
  | "answer_failure_increase"
  | "latency_increase";

export type RevisionHealthPolicy = {
  minimumAnswers: number;
  minimumToolCalls: number;
  minimumToolLatencySamples: number;
  maxAnswerFailureRate: number;
  maxToolFailureRate: number;
  maxImprovementSignalRate: number;
  maxP95Ms: number;
  maxPendingDeliveries: number;
  maxAbandonedDeliveries: number;
  maxErrorSignals: number;
  maxFailureRateIncrease: number;
  maxLatencyMultiplier: number;
};

export type RevisionHealthAssessment = {
  status: "pass" | "awaiting_traffic" | "insufficient_data" | "fail";
  recommendation: "rollout_healthy" | "observe" | "investigate" | "rollback_candidate";
  sample: {
    minimumAnswers: number;
    minimumToolCalls: number;
    answersRemaining: number;
    toolCallsRemaining: number;
  };
  metrics: {
    answers: number;
    answerFailures: number;
    answerFailureRate: number;
    toolCalls: number;
    toolAttempts: number;
    toolRetries: number;
    recoveredValidationRetries: number;
    toolFailures: number;
    toolFailureRate: number;
    improvementSignals: number;
    improvementSignalRate: number;
    p95Ms: number;
    pendingDeliveries: number;
    abandonedDeliveries: number;
    errorSignals: number;
  };
  violationCodes: RevisionHealthViolationCode[];
  violations: string[];
  comparisons: string[];
};

export const defaultRevisionHealthPolicy: RevisionHealthPolicy = Object.freeze({
  minimumAnswers: 10,
  minimumToolCalls: 5,
  minimumToolLatencySamples: 3,
  maxAnswerFailureRate: 0.1,
  maxToolFailureRate: 0.15,
  maxImprovementSignalRate: 0.2,
  maxP95Ms: 120_000,
  maxPendingDeliveries: 0,
  maxAbandonedDeliveries: 0,
  maxErrorSignals: 0,
  maxFailureRateIncrease: 0.05,
  maxLatencyMultiplier: 1.5,
});

const REVISION_FAILURE_OCCURRENCES_SQL = `
WITH error_events AS (
  SELECT event.execution_id,
         event.event_name,
         nullif(event.metadata->>'errorKind', '') AS error_kind,
         nullif(event.metadata->>'errorCode', '') AS error_code,
         CASE WHEN (event.metadata->>'errorStatus') ~ '^[0-9]{3}$' THEN (event.metadata->>'errorStatus')::int ELSE NULL END AS error_status,
         nullif(event.metadata->>'category', '') AS category,
         event.sequence
  FROM agent_runtime_events event
  JOIN agent_runtime_executions execution ON execution.execution_id = event.execution_id
  JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
  WHERE event.created_at >= now() - ($1::text || ' hours')::interval
    AND event.level = 'error'
    AND execution.task_id IS NULL
    AND execution.harness = 'nanocodex'
    AND ${MEMBER_COHORT_SQL}
    AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
), specific_errors AS (
  SELECT DISTINCT execution_id,event_name,error_kind,error_code,error_status,category
  FROM error_events
  WHERE event_name NOT IN ('agent.span','agent.execution.failed','agent.nanocodex.runtime_failed')
), ranked_fallback_errors AS (
  SELECT error_events.*,
         row_number() OVER (
           PARTITION BY error_events.execution_id
           ORDER BY CASE error_events.event_name
             WHEN 'agent.nanocodex.runtime_failed' THEN 1
             WHEN 'agent.execution.failed' THEN 2
             ELSE 3
           END, error_events.sequence DESC
         ) AS fallback_rank
  FROM error_events
  WHERE error_events.event_name IN ('agent.span','agent.execution.failed','agent.nanocodex.runtime_failed')
    AND NOT EXISTS (SELECT 1 FROM specific_errors specific WHERE specific.execution_id = error_events.execution_id)
), root_errors AS (
  SELECT execution_id,event_name,error_kind,error_code,error_status,category FROM specific_errors
  UNION ALL
  SELECT execution_id,event_name,error_kind,error_code,error_status,category
  FROM ranked_fallback_errors WHERE fallback_rank = 1
), terminal_tools AS (
  SELECT event.execution_id,
         coalesce(nullif(event.metadata->>'toolName', ''), 'unknown') AS tool_name,
         coalesce(nullif(event.metadata->>'status', ''), 'ok') AS status,
         nullif(event.metadata->>'errorCode', '') AS error_code,
         event.duration_ms,
         CASE WHEN (event.metadata->>'latencyBudgetMs') ~ '^[0-9]+$' THEN (event.metadata->>'latencyBudgetMs')::int ELSE NULL END AS latency_budget_ms,
         coalesce(event.metadata->>'latencyBudgetExceeded', 'false') = 'true' AS latency_budget_exceeded,
         row_number() OVER (
           PARTITION BY event.execution_id,event.metadata->>'toolName'
           ORDER BY event.sequence DESC
         ) AS terminal_rank
  FROM agent_runtime_events event
  JOIN agent_runtime_executions execution ON execution.execution_id = event.execution_id
  JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
  WHERE event.created_at >= now() - ($1::text || ' hours')::interval
    AND event.event_name = 'agent.tool.complete'
    AND execution.task_id IS NULL
    AND execution.harness = 'nanocodex'
    AND ${MEMBER_COHORT_SQL}
    AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
), tool_failures AS (
  SELECT execution_id,tool_name,status,error_code
  FROM terminal_tools
  WHERE terminal_rank = 1 AND status NOT IN ('ok','succeeded','success','reused')
), tool_latency_occurrences AS (
  SELECT execution_id,tool_name,
         max(latency_budget_ms) AS latency_budget_ms,
         max(duration_ms) AS max_duration_ms
  FROM terminal_tools
  WHERE status IN ('ok','succeeded','success')
    AND latency_budget_exceeded = true
  GROUP BY execution_id,tool_name
), delivery_failures AS (
  SELECT obligation.execution_id,obligation.state AS status
  FROM discord_delivery_obligations obligation
  JOIN agent_runtime_executions execution ON execution.execution_id = obligation.execution_id
  JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
  WHERE ((obligation.state = 'pending' AND obligation.updated_at <= now() - interval '5 minutes')
      OR (obligation.state = 'abandoned' AND obligation.created_at >= now() - ($1::text || ' hours')::interval))
    AND execution.task_id IS NULL
    AND execution.harness = 'nanocodex'
    AND ${MEMBER_COHORT_SQL}
    AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
), answer_failures AS (
  SELECT execution.execution_id,execution.status
  FROM agent_runtime_executions execution
  JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
  WHERE execution.created_at >= now() - ($1::text || ' hours')::interval
    AND execution.status IN ('failed','cancelled','timed_out')
    AND execution.task_id IS NULL
    AND execution.harness = 'nanocodex'
    AND ${MEMBER_COHORT_SQL}
    AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
    AND NOT EXISTS (SELECT 1 FROM root_errors root WHERE root.execution_id = execution.execution_id)
    AND NOT EXISTS (SELECT 1 FROM tool_failures tool WHERE tool.execution_id = execution.execution_id)
)
SELECT 'runtime_event' AS kind,root.category,root.event_name,
       coalesce(root.error_kind, 'unknown_error') AS error_kind,root.error_code,root.error_status,
       NULL::text AS tool_name,NULL::text AS status,NULL::int AS latency_budget_ms,NULL::int AS max_duration_ms,root.execution_id
FROM root_errors root
UNION ALL
SELECT 'tool', 'tool', NULL, NULL,tool.error_code,NULL,tool.tool_name,tool.status,NULL,NULL,tool.execution_id
FROM tool_failures tool
UNION ALL
SELECT 'tool_latency', 'tool', NULL,NULL,NULL,NULL,latency.tool_name,'budget_exceeded',latency.latency_budget_ms,latency.max_duration_ms,latency.execution_id
FROM tool_latency_occurrences latency
UNION ALL
SELECT 'delivery', 'delivery', NULL,NULL,NULL,NULL,NULL,delivery.status,NULL,NULL,delivery.execution_id
FROM delivery_failures delivery
UNION ALL
SELECT 'answer_status', 'system',NULL,NULL,NULL,NULL,NULL,answer.status,NULL,NULL,answer.execution_id
FROM answer_failures answer
ORDER BY kind,event_name,tool_name,status,execution_id`;

/** Returns content-free production quality aggregates from the canonical runtime ledger. */
export async function collectRevisionQuality(
  pool: DbPool,
  revision: string,
  hours: number,
): Promise<RevisionQuality> {
  return (await collectRevisionQualityObservation(pool, revision, hours)).quality;
}

/** Collects private execution references for intake while returning only safe clusters in the public quality view. */
export async function collectRevisionQualityObservation(
  pool: DbPool,
  revision: string,
  hours: number,
): Promise<{ quality: RevisionQuality; failureClusters: RevisionQualityPrivateFailureCluster[] }> {
  const [answers, tools, signals, deliveries, improvements, failures] = await Promise.all([
    pool.query(
      `SELECT coalesce(nullif(execution.model, ''), 'unknown') AS model,
              execution.status,
              count(*)::int AS count,
              round(coalesce(percentile_cont(0.95) WITHIN GROUP (
                ORDER BY extract(epoch FROM (execution.completed_at - execution.started_at)) * 1000
              ) FILTER (WHERE execution.started_at IS NOT NULL AND execution.completed_at IS NOT NULL), 0))::int AS p95_ms
       FROM agent_runtime_executions execution
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE execution.created_at >= now() - ($1::text || ' hours')::interval
         AND execution.task_id IS NULL
         AND execution.harness = 'nanocodex'
         AND ${MEMBER_COHORT_SQL}
         AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
       GROUP BY 1, execution.status
       ORDER BY 1, execution.status`,
      [hours, revision],
    ),
    pool.query(
      `WITH tool_attempts AS (
         SELECT event.execution_id,
                coalesce(event.metadata->>'toolName', 'unknown') AS tool,
                coalesce(event.metadata->>'status', 'ok') AS status,
                event.duration_ms,
                CASE WHEN (event.metadata->>'latencyBudgetMs') ~ '^[0-9]+$' THEN (event.metadata->>'latencyBudgetMs')::int ELSE NULL END AS latency_budget_ms,
                coalesce(event.metadata->>'latencyBudgetExceeded', 'false') = 'true' AS latency_budget_exceeded,
                row_number() OVER (PARTITION BY event.execution_id, event.metadata->>'toolName' ORDER BY event.sequence DESC) AS terminal_rank,
                count(*) OVER (PARTITION BY event.execution_id, event.metadata->>'toolName') AS attempt_count,
                count(*) FILTER (WHERE event.metadata->>'errorCode' = 'invalid_tool_arguments')
                  OVER (PARTITION BY event.execution_id, event.metadata->>'toolName') AS validation_retry_count
         FROM agent_runtime_events event
       JOIN agent_runtime_executions execution ON execution.execution_id = event.execution_id
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE event.created_at >= now() - ($1::text || ' hours')::interval
         AND event.event_name = 'agent.tool.complete'
         AND execution.task_id IS NULL
         AND execution.harness = 'nanocodex'
         AND ${MEMBER_COHORT_SQL}
         AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
       )
       SELECT tool, status, count(*)::int AS count,
              sum(attempt_count)::int AS attempt_count,
              sum(greatest(attempt_count - 1, 0))::int AS retry_count,
              sum(CASE WHEN status IN ('ok', 'succeeded', 'success', 'reused') THEN validation_retry_count ELSE 0 END)::int AS recovered_validation_retry_count,
              round(coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
                FILTER (WHERE status IN ('ok','succeeded','success')), 0))::int AS p50_ms,
              round(coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
                FILTER (WHERE status IN ('ok','succeeded','success')), 0))::int AS p95_ms,
              coalesce(max(duration_ms) FILTER (WHERE status IN ('ok','succeeded','success')), 0)::int AS max_ms,
              max(latency_budget_ms) FILTER (WHERE status IN ('ok','succeeded','success')) AS latency_budget_ms,
              count(*) FILTER (WHERE status IN ('ok','succeeded','success') AND latency_budget_exceeded = true)::int AS slow_success_count
       FROM tool_attempts
       WHERE terminal_rank = 1
       GROUP BY tool, status
       ORDER BY tool, status`,
      [hours, revision],
    ),
    pool.query(
      `SELECT event.level, count(*)::int AS count
       FROM agent_runtime_events event
       JOIN agent_runtime_executions execution ON execution.execution_id = event.execution_id
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE event.created_at >= now() - ($1::text || ' hours')::interval
         AND event.level IN ('warn', 'error')
         AND execution.task_id IS NULL
         AND execution.harness = 'nanocodex'
         AND ${MEMBER_COHORT_SQL}
         AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
       GROUP BY event.level
       ORDER BY event.level`,
      [hours, revision],
    ),
    pool.query(
      `SELECT obligation.state, count(*)::int AS count
       FROM discord_delivery_obligations obligation
       JOIN agent_runtime_executions execution ON execution.execution_id = obligation.execution_id
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE ((obligation.state = 'pending' AND obligation.updated_at <= now() - interval '5 minutes')
           OR (obligation.state <> 'pending' AND obligation.created_at >= now() - ($1::text || ' hours')::interval))
         AND execution.task_id IS NULL
         AND execution.harness = 'nanocodex'
         AND ${MEMBER_COHORT_SQL}
         AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
       GROUP BY obligation.state
       ORDER BY obligation.state`,
      [hours, revision],
    ),
    pool.query(
      `SELECT signal.source, case_row.classification, count(*)::int AS count
       FROM improvement_signals signal
       JOIN improvement_cases case_row ON case_row.case_id = signal.case_id
       WHERE signal.observed_at >= now() - ($1::text || ' hours')::interval
         AND signal.active = true
         AND signal.app_revision = $2
         AND signal.source IN ('member_report','agent_report','operator_report','developer_report')
       GROUP BY signal.source, case_row.classification
       ORDER BY signal.source, case_row.classification`,
      [hours, revision],
    ),
    pool.query(REVISION_FAILURE_OCCURRENCES_SQL, [hours, revision]),
  ]);

  const failureClusters = groupFailureOccurrences(failures.rows.map(rowToFailureOccurrence));
  const quality = {
    revision,
    windowHours: hours,
    generatedAt: new Date().toISOString(),
    answers: answers.rows,
    tools: tools.rows,
    signals: signals.rows,
    deliveries: deliveries.rows,
    improvements: improvements.rows,
    failureClusters: failureClusters.map(({ executionIds: _executionIds, ...cluster }) => cluster),
  };
  return { quality, failureClusters };
}

/** Finds the most recently active prior revision in the same observation window. */
export async function findBaselineRevision(pool: DbPool, revision: string, hours: number): Promise<string | null> {
  const result = await pool.query(
    `SELECT coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') AS revision,
            max(execution.created_at) AS latest_at
     FROM agent_runtime_executions execution
     JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
     WHERE execution.created_at >= now() - ($1::text || ' hours')::interval
       AND execution.task_id IS NULL
       AND execution.harness = 'nanocodex'
       AND ${MEMBER_COHORT_SQL}
       AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') NOT IN ($2, 'unknown')
     GROUP BY 1
     ORDER BY latest_at DESC
     LIMIT 1`,
    [hours, revision],
  );
  return result.rows[0]?.revision ? String(result.rows[0].revision) : null;
}

export function assessRevisionQuality(
  quality: RevisionQuality,
  baseline?: RevisionQuality | null,
  policy: RevisionHealthPolicy = defaultRevisionHealthPolicy,
): RevisionHealthAssessment {
  const metrics = qualityMetrics(quality);
  const baselineMetrics = baseline ? qualityMetrics(baseline) : null;
  const violations: string[] = [];
  const violationCodes: RevisionHealthViolationCode[] = [];
  const comparisons: string[] = [];
  const sample = {
    minimumAnswers: policy.minimumAnswers,
    minimumToolCalls: policy.minimumToolCalls,
    answersRemaining: Math.max(0, policy.minimumAnswers - metrics.answers),
    toolCallsRemaining: Math.max(0, policy.minimumToolCalls - metrics.toolCalls),
  };

  if (metrics.answers >= policy.minimumAnswers && metrics.answerFailureRate > policy.maxAnswerFailureRate) {
    violationCodes.push("answer_failure_rate");
    violations.push(`answer failure rate ${percent(metrics.answerFailureRate)} exceeds ${percent(policy.maxAnswerFailureRate)}`);
  }
  if (metrics.toolCalls >= policy.minimumToolCalls && metrics.toolFailureRate > policy.maxToolFailureRate) {
    violationCodes.push("tool_failure_rate");
    violations.push(`tool failure rate ${percent(metrics.toolFailureRate)} exceeds ${percent(policy.maxToolFailureRate)}`);
  }
  if (metrics.answers >= policy.minimumAnswers && metrics.improvementSignalRate > policy.maxImprovementSignalRate) {
    violationCodes.push("improvement_signal_rate");
    violations.push(`improvement signals per answer ${percent(metrics.improvementSignalRate)} exceeds ${percent(policy.maxImprovementSignalRate)}`);
  }
  if (metrics.answers >= policy.minimumAnswers && metrics.p95Ms > policy.maxP95Ms) {
    violationCodes.push("answer_latency");
    violations.push(`answer p95 ${metrics.p95Ms}ms exceeds ${policy.maxP95Ms}ms`);
  }
  if (metrics.pendingDeliveries > policy.maxPendingDeliveries) {
    violationCodes.push("overdue_delivery");
    violations.push(`${metrics.pendingDeliveries} overdue deliveries exceed ${policy.maxPendingDeliveries}`);
  }
  if (metrics.abandonedDeliveries > policy.maxAbandonedDeliveries) {
    violationCodes.push("abandoned_delivery");
    violations.push(`${metrics.abandonedDeliveries} abandoned deliveries exceed ${policy.maxAbandonedDeliveries}`);
  }
  if (metrics.errorSignals > policy.maxErrorSignals) {
    violationCodes.push("runtime_error");
    violations.push(`${metrics.errorSignals} error signals exceed ${policy.maxErrorSignals}`);
  }

  if (baselineMetrics && metrics.answers >= policy.minimumAnswers && baselineMetrics.answers >= policy.minimumAnswers) {
    const failureIncrease = metrics.answerFailureRate - baselineMetrics.answerFailureRate;
    if (failureIncrease > policy.maxFailureRateIncrease) {
      violationCodes.push("answer_failure_increase");
      comparisons.push(`answer failure rate increased by ${percent(failureIncrease)} from ${baseline?.revision}`);
    }
    if (baselineMetrics.p95Ms > 0 && metrics.p95Ms > baselineMetrics.p95Ms * policy.maxLatencyMultiplier) {
      violationCodes.push("latency_increase");
      comparisons.push(`answer p95 is ${(metrics.p95Ms / baselineMetrics.p95Ms).toFixed(2)}x ${baseline?.revision}`);
    }
  }
  violations.push(...comparisons);

  if (violations.length > 0) {
    const baselineHealthy = baseline && baselineMetrics && baselineMetrics.answers >= policy.minimumAnswers &&
      assessRevisionQuality(baseline, null, policy).status === "pass";
    return { status: "fail", recommendation: baselineHealthy ? "rollback_candidate" : "investigate", sample, metrics, violationCodes, violations, comparisons };
  }
  if (metrics.answers === 0) {
    return { status: "awaiting_traffic", recommendation: "observe", sample, metrics, violationCodes, violations, comparisons };
  }
  if (metrics.answers < policy.minimumAnswers) {
    return { status: "insufficient_data", recommendation: "observe", sample, metrics, violationCodes, violations, comparisons };
  }
  return { status: "pass", recommendation: "rollout_healthy", sample, metrics, violationCodes, violations, comparisons };
}

/** Converts a failed gate into one content-free signal per exact root-cause occurrence. */
export function revisionQualityDetectionInputs(
  quality: RevisionQuality,
  assessment: RevisionHealthAssessment,
  failureClusters: RevisionQualityPrivateFailureCluster[],
): AutomatedImprovementDetectionInput[] {
  const selected = new Map<string, RevisionQualityPrivateFailureCluster>();
  for (const cluster of failureClusters) {
    if (cluster.kind === "tool_latency") selected.set(cluster.reference, cluster);
  }
  if (assessment.status === "fail") {
    for (const violationCode of assessment.violationCodes) {
      const matches = failureClusters.filter((cluster) => clusterMatchesViolation(cluster, violationCode));
      if (matches.length > 0) {
        for (const cluster of matches) selected.set(cluster.reference, cluster);
        continue;
      }
      const metric = metricFailureCluster(violationCode);
      selected.set(metric.reference, metric);
    }
  }
  return [...selected.values()].flatMap((cluster) => {
    const executionIds = cluster.executionIds.slice(0, MAX_CLUSTER_EXECUTIONS);
    const occurrences = executionIds.length > 0 ? executionIds : [null];
    return occurrences.map((executionId): AutomatedImprovementDetectionInput => ({
      source: "runtime_detection",
      sourceId: `revision-quality:${quality.revision}:${cluster.reference.slice("revision-quality:".length)}:${shortHash(executionId ?? "aggregate")}`,
      summary: failureSummary(cluster),
      stableCode: cluster.reference,
      executionId,
      appRevision: quality.revision,
      scope: "deployment",
      classification: cluster.kind === "tool_latency" ? "defect" : "external_incident",
      severity: cluster.kind === "tool_latency" ? "medium" : "high",
      owningDomain: failureDomain(cluster),
      metadata: {
        assessmentStatus: assessment.status,
        recommendation: assessment.recommendation,
        windowHours: quality.windowHours,
        failureKind: cluster.kind,
        failureCategory: cluster.category,
        failureEventName: cluster.eventName,
        failureErrorKind: cluster.errorKind,
        failureErrorCode: cluster.errorCode,
        failureErrorStatus: cluster.errorStatus,
        failureToolName: cluster.toolName,
        failureStatus: cluster.status,
        latencyBudgetMs: cluster.latencyBudgetMs,
        maxDurationMs: cluster.maxDurationMs,
        occurrenceCount: cluster.count,
        sampledExecutionCount: executionIds.length,
      },
    }));
  });
}

/** Returns exact slow-success references that have enough healthy calls of the same capability to prove absence. */
export function revisionQualityClusterAbsenceStatuses(
  quality: RevisionQuality,
  policy: RevisionHealthPolicy = defaultRevisionHealthPolicy,
) {
  const successfulCallsByTool = new Map<string, number>();
  for (const row of quality.tools) {
    const status = String(row.status);
    if (!SUCCESSFUL_TOOL_STATUSES.includes(status) || status === "reused") continue;
    const toolName = String(row.tool ?? "unknown");
    successfulCallsByTool.set(toolName, (successfulCallsByTool.get(toolName) ?? 0) + numeric(row.count));
  }
  const statuses: Record<string, "passed"> = {};
  for (const [toolName, count] of successfulCallsByTool) {
    if (count < policy.minimumToolLatencySamples) continue;
    const reference = clusterFromDimensions({
      kind: "tool_latency",
      category: "tool",
      eventName: null,
      errorKind: null,
      errorCode: null,
      errorStatus: null,
      toolName,
      status: "budget_exceeded",
      latencyBudgetMs: null,
      maxDurationMs: null,
      executionIds: [],
      count: 1,
    }).reference;
    statuses[reference] = "passed";
  }
  return statuses;
}

function qualityMetrics(quality: RevisionQuality): RevisionHealthAssessment["metrics"] {
  const answers = total(quality.answers);
  const answerFailures = total(quality.answers, (row) => ["failed", "cancelled", "timed_out"].includes(String(row.status)));
  const toolCalls = total(quality.tools);
  const toolAttempts = totalField(quality.tools, "attempt_count", "count");
  const toolRetries = totalField(quality.tools, "retry_count");
  const recoveredValidationRetries = totalField(quality.tools, "recovered_validation_retry_count");
  const toolFailures = total(quality.tools, (row) => !SUCCESSFUL_TOOL_STATUSES.includes(String(row.status)));
  const improvementSignals = total(quality.improvements);
  return {
    answers,
    answerFailures,
    answerFailureRate: rate(answerFailures, answers),
    toolCalls,
    toolAttempts,
    toolRetries,
    recoveredValidationRetries,
    toolFailures,
    toolFailureRate: rate(toolFailures, toolCalls),
    improvementSignals,
    improvementSignalRate: rate(improvementSignals, answers),
    p95Ms: Math.max(0, ...quality.answers.map((row) => numeric(row.p95_ms))),
    pendingDeliveries: total(quality.deliveries, (row) => String(row.state) === "pending"),
    abandonedDeliveries: total(quality.deliveries, (row) => String(row.state) === "abandoned"),
    errorSignals: quality.failureClusters
      .filter((cluster) => cluster.kind === "runtime_event")
      .reduce((sum, cluster) => sum + cluster.count, 0),
  };
}

function clusterMatchesViolation(cluster: RevisionQualityFailureCluster, violation: RevisionHealthViolationCode) {
  if (violation === "runtime_error") return cluster.kind === "runtime_event";
  if (violation === "tool_failure_rate") return cluster.kind === "tool";
  if (violation === "overdue_delivery") return cluster.kind === "delivery" && cluster.status === "pending";
  if (violation === "abandoned_delivery") return cluster.kind === "delivery" && cluster.status === "abandoned";
  if (violation === "answer_failure_rate" || violation === "answer_failure_increase") return cluster.kind === "answer_status";
  return false;
}

function metricFailureCluster(code: RevisionHealthViolationCode): RevisionQualityPrivateFailureCluster {
  return clusterFromDimensions({
    kind: "quality_metric",
    category: "observability",
    eventName: null,
    errorKind: null,
    errorCode: null,
    errorStatus: null,
    toolName: null,
    status: code,
    latencyBudgetMs: null,
    maxDurationMs: null,
    executionIds: [],
    count: 1,
  });
}

function groupFailureOccurrences(occurrences: FailureOccurrence[]) {
  const grouped = new Map<string, RevisionQualityPrivateFailureCluster>();
  for (const occurrence of occurrences) {
    const { executionId, ...dimensions } = occurrence;
    const candidate = clusterFromDimensions({ ...dimensions, executionIds: [executionId], count: 1 });
    const existing = grouped.get(candidate.reference);
    if (!existing) {
      grouped.set(candidate.reference, candidate);
      continue;
    }
    existing.count += 1;
    existing.latencyBudgetMs = existing.latencyBudgetMs ?? candidate.latencyBudgetMs;
    existing.maxDurationMs = Math.max(existing.maxDurationMs ?? 0, candidate.maxDurationMs ?? 0) || null;
    if (!existing.executionIds.includes(executionId)) existing.executionIds.push(executionId);
  }
  return [...grouped.values()]
    .map((cluster) => ({ ...cluster, executionIds: cluster.executionIds.sort() }))
    .sort((left, right) => left.reference.localeCompare(right.reference));
}

function clusterFromDimensions(input: Omit<RevisionQualityPrivateFailureCluster, "reference">): RevisionQualityPrivateFailureCluster {
  const canonical = JSON.stringify({
    kind: input.kind,
    category: input.category,
    eventName: input.eventName,
    errorKind: input.errorKind,
    errorCode: input.errorCode,
    errorStatus: input.errorStatus,
    toolName: input.toolName,
    status: input.status,
  });
  return { ...input, reference: `revision-quality:${input.kind}:${shortHash(canonical, 24)}` };
}

function failureSummary(cluster: RevisionQualityFailureCluster) {
  if (cluster.kind === "runtime_event") {
    const kind = cluster.errorKind && cluster.errorKind !== "unknown_error" ? ` (${cluster.errorKind})` : "";
    return `Production member execution emitted ${cluster.eventName ?? "an unknown runtime error"}${kind}.`;
  }
  if (cluster.kind === "tool") return `Production tool ${cluster.toolName ?? "unknown"} ended ${cluster.status ?? "in error"}.`;
  if (cluster.kind === "tool_latency") {
    const budget = cluster.latencyBudgetMs == null ? "configured latency budget" : `${cluster.latencyBudgetMs}ms latency budget`;
    return `Production tool ${cluster.toolName ?? "unknown"} exceeded its ${budget} while still succeeding.`;
  }
  if (cluster.kind === "delivery") return `Production Discord delivery remained ${cluster.status ?? "unhealthy"}.`;
  if (cluster.kind === "answer_status") return `Production member execution ended ${cluster.status ?? "unsuccessfully"}.`;
  return `Production quality metric ${cluster.status ?? "unknown"} violated policy.`;
}

function failureDomain(cluster: RevisionQualityFailureCluster) {
  if (cluster.kind === "delivery") return "discord-delivery";
  if (cluster.kind === "tool") return "tools";
  if (cluster.kind === "tool_latency") {
    if (TOOL_NAMES_BY_CAPABILITY.discordContext.includes(cluster.toolName as never)) return "retrieval";
    if (TOOL_NAMES_BY_CAPABILITY.images.includes(cluster.toolName as never)) return "images";
    if (TOOL_NAMES_BY_CAPABILITY.externalResearch.includes(cluster.toolName as never)) return "external-research";
    return "tools";
  }
  if (cluster.kind === "answer_status") return "runtime";
  if (cluster.category === "model") return "models";
  if (cluster.category === "retrieval") return "retrieval";
  if (cluster.category === "delivery") return "discord-delivery";
  return "observability";
}

type FailureOccurrence = Omit<RevisionQualityFailureCluster, "reference" | "count"> & { executionId: string };

function rowToFailureOccurrence(row: Record<string, unknown>): FailureOccurrence {
  return {
    kind: String(row.kind) as RevisionQualityFailureKind,
    category: nullableString(row.category),
    eventName: nullableString(row.event_name),
    errorKind: nullableString(row.error_kind),
    errorCode: nullableString(row.error_code),
    errorStatus: row.error_status == null ? null : numeric(row.error_status),
    toolName: nullableString(row.tool_name),
    status: nullableString(row.status),
    latencyBudgetMs: row.latency_budget_ms == null ? null : numeric(row.latency_budget_ms),
    maxDurationMs: row.max_duration_ms == null ? null : numeric(row.max_duration_ms),
    executionId: String(row.execution_id),
  };
}

function nullableString(value: unknown) {
  return value == null ? null : String(value);
}

function shortHash(value: string, length = 16) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function totalField(rows: Record<string, unknown>[], field: string, fallback?: string) {
  return rows.reduce((sum, row) => sum + numeric(row[field] ?? (fallback ? row[fallback] : 0)), 0);
}

function total(rows: Record<string, unknown>[], include: (row: Record<string, unknown>) => boolean = () => true) {
  return rows.reduce((sum, row) => sum + (include(row) ? numeric(row.count) : 0), 0);
}

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}
