import type { DbPool } from "./pool.js";
import { listImprovementProofProducerHealth } from "./improvementProofProducerRepository.js";

const DEFAULT_WINDOW_HOURS = 30 * 24;
const MAX_WINDOW_HOURS = 365 * 24;
const TOP_CLUSTER_LIMIT = 10;

export type ImprovementMetricCount = { name: string; cases: number };
export type ImprovementLatencyDistribution = { samples: number; medianMs: number | null; p95Ms: number | null };

export type ImprovementEffectivenessReport = {
  generatedAt: Date;
  window: { hours: number; since: Date; casesEntered: number };
  current: {
    cases: number;
    unresolved: number;
    byStatus: ImprovementMetricCount[];
    byAutomationState: ImprovementMetricCount[];
    blockers: ImprovementMetricCount[];
    retryTriggers: ImprovementMetricCount[];
  };
  flow: {
    triagedCases: number;
    workStartedCases: number;
    repairCompletedCases: number;
    resolvedCases: number;
    dismissedCases: number;
    terminalRate: number | null;
    verifiedResolutionRate: number | null;
    dismissalRate: number | null;
    latencyMs: {
      signalToTriage: ImprovementLatencyDistribution;
      triageToWork: ImprovementLatencyDistribution;
      workToVerification: ImprovementLatencyDistribution;
      verificationToResolution: ImprovementLatencyDistribution;
      endToEndResolution: ImprovementLatencyDistribution;
    };
    bySignalSource: ImprovementMetricCount[];
  };
  automation: {
    proofProducers: {
      healthy: number;
      unhealthy: number;
      unobserved: number;
      producers: Array<{
        trigger: string;
        state: "healthy" | "unhealthy" | "unobserved";
        reason: string;
        consecutiveFailures: number;
        latestSuccessAt: Date | null;
      }>;
    };
    repairTasks: {
      total: number;
      queued: number;
      running: number;
      succeeded: number;
      failed: number;
      noChanges: number;
      cancelled: number;
      terminalSuccessRate: number | null;
      retryAttempts: number;
      retryExhaustedCases: number;
    };
    humanIntervention: {
      operatorActionCases: number;
      operatorActionRate: number | null;
      reviewRequestCases: number;
      reviewRequestsByReason: ImprovementMetricCount[];
    };
  };
  recurrence: {
    recurringClusters: number;
    recurrentCases: number;
    topClusters: Array<{ clusterKey: string; priorCases: number; recurrentCases: number }>;
  };
  economics: {
    resolvedCases: number;
    resolvedCasesWithTasks: number;
    costObservedCases: number;
    costCoverageRate: number | null;
    totalEstimatedCostUsd: number | null;
    averageEstimatedCostUsdPerObservedCase: number | null;
    taskLatencyMsPerResolvedCase: ImprovementLatencyDistribution;
  };
  attention: {
    status: "ok" | "needs_attention";
    blockedCases: number;
    stalledCases: number;
    retryExhaustedCases: number;
    recurringClusters: number;
    unhealthyProofProducers: number;
  };
};

/** Aggregates content-free effectiveness measures from the canonical improvement and runtime ledgers. */
export async function getImprovementEffectiveness(pool: DbPool, input: {
  hours?: number;
  now?: Date;
  stalledAfterMs?: number;
} = {}): Promise<ImprovementEffectivenessReport> {
  const hours = boundedInteger(input.hours ?? DEFAULT_WINDOW_HOURS, 1, MAX_WINDOW_HOURS, "hours");
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - hours * 60 * 60 * 1_000);
  const stalledAfterMs = boundedInteger(input.stalledAfterMs ?? 24 * 60 * 60 * 1_000, 1, 365 * 24 * 60 * 60 * 1_000, "stalledAfterMs");
  const parameters = [since, now];

  const [currentResult, flowResult, latencyResult, sourceResult, automationResult, interventionResult, recurrenceResult, economicsResult, proofProducers] = await Promise.all([
    pool.query(
      `SELECT status, automation_state, automation_blocker, automation_retry_trigger,
              count(*)::int AS cases,
              count(*) FILTER (
                WHERE automation_state <> 'complete'
                  AND $1::timestamptz - automation_last_progress_at > $2::double precision * interval '1 millisecond'
              )::int AS stalled_cases
       FROM improvement_cases
       WHERE merged_into_case_id IS NULL
       GROUP BY status, automation_state, automation_blocker, automation_retry_trigger`,
      [now, stalledAfterMs],
    ),
    pool.query(
      `${cohortMilestonesSql()}
       SELECT count(*)::int AS cases_entered,
              count(*) FILTER (WHERE triaged_at IS NOT NULL)::int AS triaged_cases,
              count(*) FILTER (WHERE work_started_at IS NOT NULL)::int AS work_started_cases,
              count(*) FILTER (WHERE work_completed_at IS NOT NULL)::int AS repair_completed_cases,
              count(*) FILTER (WHERE status = 'resolved')::int AS resolved_cases,
              count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed_cases
       FROM milestones`,
      parameters,
    ),
    pool.query(
      `${cohortMilestonesSql()}, duration_values AS (
         SELECT 'signal_to_triage' AS metric, greatest(0, extract(epoch FROM triaged_at - first_seen_at) * 1000) AS value FROM milestones WHERE triaged_at IS NOT NULL
         UNION ALL
         SELECT 'triage_to_work', greatest(0, extract(epoch FROM work_started_at - triaged_at) * 1000) FROM milestones WHERE triaged_at IS NOT NULL AND work_started_at IS NOT NULL
         UNION ALL
         SELECT 'work_to_verification', greatest(0, extract(epoch FROM work_completed_at - work_started_at) * 1000) FROM milestones WHERE work_started_at IS NOT NULL AND work_completed_at IS NOT NULL
         UNION ALL
         SELECT 'verification_to_resolution', greatest(0, extract(epoch FROM resolved_at - work_completed_at) * 1000) FROM milestones WHERE work_completed_at IS NOT NULL AND resolved_at IS NOT NULL
         UNION ALL
         SELECT 'end_to_end_resolution', greatest(0, extract(epoch FROM resolved_at - first_seen_at) * 1000) FROM milestones WHERE resolved_at IS NOT NULL
       )
       SELECT metric, count(*)::int AS samples,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY value))::bigint AS median_ms,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY value))::bigint AS p95_ms
       FROM duration_values GROUP BY metric ORDER BY metric`,
      parameters,
    ),
    pool.query(
      `SELECT signal.source AS name, count(DISTINCT signal.case_id)::int AS cases
       FROM improvement_signals signal
       JOIN improvement_cases case_row ON case_row.case_id = signal.case_id
       WHERE case_row.merged_into_case_id IS NULL
         AND case_row.first_seen_at BETWEEN $1 AND $2
       GROUP BY signal.source ORDER BY cases DESC, name ASC`,
      parameters,
    ),
    pool.query(
      `WITH repair_tasks AS (
         SELECT task_id, status FROM agent_tasks
         WHERE task_type = 'improvement_repair' AND created_at BETWEEN $1 AND $2
       ), repair_retries AS (
         SELECT count(*)::int AS attempts
         FROM improvement_case_events
         WHERE event_name = 'reconciliation.repair_queued'
           AND created_at BETWEEN $1 AND $2
           AND metadata->>'attempt' ~ '^[0-9]+$'
           AND (metadata->>'attempt')::int > 1
       ), exhausted AS (
         SELECT count(DISTINCT case_id)::int AS cases
         FROM improvement_case_events
         WHERE event_name = 'reconciliation.awaiting_operator'
           AND created_at BETWEEN $1 AND $2
           AND metadata->>'reason' = 'automated_repair_retries_exhausted'
       )
       SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'running')::int AS running,
              count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'no_changes')::int AS no_changes,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              (SELECT attempts FROM repair_retries) AS retry_attempts,
              (SELECT cases FROM exhausted) AS retry_exhausted_cases
       FROM repair_tasks`,
      parameters,
    ),
    pool.query(
      `WITH cohort AS (
         SELECT case_id FROM improvement_cases
         WHERE merged_into_case_id IS NULL AND first_seen_at BETWEEN $1 AND $2
       ), operator_cases AS (
         SELECT DISTINCT event.case_id
         FROM improvement_case_events event JOIN cohort USING (case_id)
         WHERE event.actor_kind IN ('operator', 'developer')
           AND event.event_name NOT IN ('signal.received', 'case.created', 'case.coalesced')
       ), review_reasons AS (
         SELECT coalesce(nullif(event.metadata->>'reason', ''), 'unknown') AS reason,
                count(DISTINCT event.case_id)::int AS cases
         FROM improvement_case_events event JOIN cohort USING (case_id)
         WHERE event.event_name = 'reconciliation.awaiting_operator'
         GROUP BY reason
       )
       SELECT (SELECT count(*)::int FROM operator_cases) AS operator_action_cases,
              (SELECT count(DISTINCT event.case_id)::int FROM improvement_case_events event JOIN cohort USING (case_id) WHERE event.event_name = 'reconciliation.awaiting_operator') AS review_request_cases,
              coalesce((SELECT jsonb_agg(jsonb_build_object('name', reason, 'cases', cases) ORDER BY cases DESC, reason ASC) FROM review_reasons), '[]'::jsonb) AS review_reasons`,
      parameters,
    ),
    pool.query(
      `WITH recurrences AS (
         SELECT md5(coalesce(newer.guild_id, 'global') || ':' || newer.privacy || ':' || newer.fingerprint) AS cluster_key,
                count(DISTINCT older.case_id)::int AS prior_cases,
                count(DISTINCT newer.case_id)::int AS recurrent_cases
         FROM improvement_cases newer
         JOIN improvement_cases older
           ON older.guild_id IS NOT DISTINCT FROM newer.guild_id
          AND older.privacy = newer.privacy
          AND older.fingerprint = newer.fingerprint
          AND older.case_id <> newer.case_id
          AND older.resolved_at IS NOT NULL
          AND older.resolved_at < newer.first_seen_at
         WHERE newer.merged_into_case_id IS NULL
           AND older.merged_into_case_id IS NULL
           AND newer.fingerprint IS NOT NULL
           AND newer.first_seen_at BETWEEN $1 AND $2
         GROUP BY newer.guild_id, newer.privacy, newer.fingerprint
       )
       SELECT cluster_key, prior_cases, recurrent_cases,
              count(*) OVER ()::int AS recurring_clusters_total,
              sum(recurrent_cases) OVER ()::int AS recurrent_cases_total
       FROM recurrences ORDER BY recurrent_cases DESC, prior_cases DESC, cluster_key ASC LIMIT ${TOP_CLUSTER_LIMIT}`,
      parameters,
    ),
    pool.query(
      `WITH resolved_cases AS (
         SELECT case_id FROM improvement_cases
         WHERE merged_into_case_id IS NULL
           AND status = 'resolved'
           AND first_seen_at BETWEEN $1 AND $2
       ), task_costs AS (
         SELECT execution.task_id, sum(metric.estimated_cost_usd)::double precision AS estimated_cost_usd
         FROM agent_runtime_executions execution
         JOIN agent_runtime_metric_projection metric ON metric.execution_id = execution.execution_id
         WHERE execution.task_id IS NOT NULL AND metric.estimated_cost_usd IS NOT NULL
         GROUP BY execution.task_id
       ), case_metrics AS (
         SELECT resolved.case_id,
                count(task.task_id)::int AS tasks,
                sum(cost.estimated_cost_usd)::double precision AS estimated_cost_usd,
                sum(extract(epoch FROM coalesce(task.completed_at, task.updated_at) - coalesce(task.started_at, task.created_at)) * 1000)::double precision AS task_latency_ms
         FROM resolved_cases resolved
         LEFT JOIN improvement_work_attempts work ON work.case_id = resolved.case_id AND work.task_id IS NOT NULL
         LEFT JOIN agent_tasks task ON task.task_id = work.task_id
         LEFT JOIN task_costs cost ON cost.task_id = task.task_id
         GROUP BY resolved.case_id
       )
       SELECT count(*)::int AS resolved_cases,
              count(*) FILTER (WHERE tasks > 0)::int AS resolved_cases_with_tasks,
              count(*) FILTER (WHERE estimated_cost_usd IS NOT NULL)::int AS cost_observed_cases,
              sum(estimated_cost_usd)::double precision AS total_estimated_cost_usd,
              (avg(estimated_cost_usd) FILTER (WHERE estimated_cost_usd IS NOT NULL))::double precision AS average_estimated_cost_usd,
              count(*) FILTER (WHERE tasks > 0)::int AS latency_samples,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY task_latency_ms) FILTER (WHERE tasks > 0))::bigint AS median_task_latency_ms,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY task_latency_ms) FILTER (WHERE tasks > 0))::bigint AS p95_task_latency_ms
       FROM case_metrics`,
      parameters,
    ),
    listImprovementProofProducerHealth(pool, { now }),
  ]);

  const currentRows = currentResult.rows;
  const currentCases = sumRows(currentRows, "cases");
  const unresolved = currentRows.filter((row) => !["resolved", "dismissed"].includes(String(row.status))).reduce((sum, row) => sum + integer(row.cases), 0);
  const stalledCases = currentRows.reduce((sum, row) => sum + integer(row.stalled_cases), 0);
  const flow = flowResult.rows[0] ?? {};
  const casesEntered = integer(flow.cases_entered);
  const resolvedCases = integer(flow.resolved_cases);
  const dismissedCases = integer(flow.dismissed_cases);
  const repair = automationResult.rows[0] ?? {};
  const terminalRepairTasks = integer(repair.succeeded) + integer(repair.failed) + integer(repair.no_changes) + integer(repair.cancelled);
  const intervention = interventionResult.rows[0] ?? {};
  const recurrenceRows = recurrenceResult.rows;
  const recurringClusters = integer(recurrenceRows[0]?.recurring_clusters_total);
  const recurrentCases = integer(recurrenceRows[0]?.recurrent_cases_total);
  const economics = economicsResult.rows[0] ?? {};
  const blockedCases = currentRows.filter((row) => String(row.automation_state) === "blocked").reduce((sum, row) => sum + integer(row.cases), 0);
  const retryExhaustedCases = integer(repair.retry_exhausted_cases);
  const unhealthyProofProducers = proofProducers.filter((producer) => producer.state === "unhealthy").length;

  return {
    generatedAt: now,
    window: { hours, since, casesEntered },
    current: {
      cases: currentCases,
      unresolved,
      byStatus: groupedCounts(currentRows, "status"),
      byAutomationState: groupedCounts(currentRows, "automation_state"),
      blockers: groupedCounts(currentRows.filter((row) => row.automation_blocker != null), "automation_blocker"),
      retryTriggers: groupedCounts(currentRows.filter((row) => row.automation_retry_trigger != null), "automation_retry_trigger"),
    },
    flow: {
      triagedCases: integer(flow.triaged_cases),
      workStartedCases: integer(flow.work_started_cases),
      repairCompletedCases: integer(flow.repair_completed_cases),
      resolvedCases,
      dismissedCases,
      terminalRate: rate(resolvedCases + dismissedCases, casesEntered),
      verifiedResolutionRate: rate(resolvedCases, casesEntered),
      dismissalRate: rate(dismissedCases, casesEntered),
      latencyMs: latencyMap(latencyResult.rows),
      bySignalSource: sourceResult.rows.map(countRow),
    },
    automation: {
      proofProducers: {
        healthy: proofProducers.filter((producer) => producer.state === "healthy").length,
        unhealthy: unhealthyProofProducers,
        unobserved: proofProducers.filter((producer) => producer.state === "unobserved").length,
        producers: proofProducers.map((producer) => ({
          trigger: producer.trigger,
          state: producer.state,
          reason: producer.reason,
          consecutiveFailures: producer.consecutiveFailures,
          latestSuccessAt: producer.latestSuccessAt,
        })),
      },
      repairTasks: {
        total: integer(repair.total),
        queued: integer(repair.queued),
        running: integer(repair.running),
        succeeded: integer(repair.succeeded),
        failed: integer(repair.failed),
        noChanges: integer(repair.no_changes),
        cancelled: integer(repair.cancelled),
        terminalSuccessRate: rate(integer(repair.succeeded), terminalRepairTasks),
        retryAttempts: integer(repair.retry_attempts),
        retryExhaustedCases,
      },
      humanIntervention: {
        operatorActionCases: integer(intervention.operator_action_cases),
        operatorActionRate: rate(integer(intervention.operator_action_cases), casesEntered),
        reviewRequestCases: integer(intervention.review_request_cases),
        reviewRequestsByReason: jsonCounts(intervention.review_reasons),
      },
    },
    recurrence: {
      recurringClusters,
      recurrentCases,
      topClusters: recurrenceRows.map((row) => ({
        clusterKey: String(row.cluster_key),
        priorCases: integer(row.prior_cases),
        recurrentCases: integer(row.recurrent_cases),
      })),
    },
    economics: {
      resolvedCases: integer(economics.resolved_cases),
      resolvedCasesWithTasks: integer(economics.resolved_cases_with_tasks),
      costObservedCases: integer(economics.cost_observed_cases),
      costCoverageRate: rate(integer(economics.cost_observed_cases), integer(economics.resolved_cases_with_tasks)),
      totalEstimatedCostUsd: nullableNumber(economics.total_estimated_cost_usd),
      averageEstimatedCostUsdPerObservedCase: nullableNumber(economics.average_estimated_cost_usd),
      taskLatencyMsPerResolvedCase: {
        samples: integer(economics.latency_samples),
        medianMs: nullableInteger(economics.median_task_latency_ms),
        p95Ms: nullableInteger(economics.p95_task_latency_ms),
      },
    },
    attention: {
      status: blockedCases > 0 || stalledCases > 0 || retryExhaustedCases > 0 || recurringClusters > 0 || unhealthyProofProducers > 0 ? "needs_attention" : "ok",
      blockedCases,
      stalledCases,
      retryExhaustedCases,
      recurringClusters,
      unhealthyProofProducers,
    },
  };
}

function cohortMilestonesSql() {
  return `WITH milestones AS (
    SELECT case_row.case_id, case_row.first_seen_at, case_row.status, case_row.resolved_at,
           (SELECT min(event.created_at) FROM improvement_case_events event WHERE event.case_id = case_row.case_id AND event.event_name = 'triage.applied') AS triaged_at,
           (SELECT min(work.started_at) FROM improvement_work_attempts work WHERE work.case_id = case_row.case_id) AS work_started_at,
           (SELECT min(work.completed_at) FROM improvement_work_attempts work WHERE work.case_id = case_row.case_id AND work.status = 'succeeded') AS work_completed_at
    FROM improvement_cases case_row
    WHERE case_row.merged_into_case_id IS NULL AND case_row.first_seen_at BETWEEN $1 AND $2
  )`;
}

function latencyMap(rows: Record<string, unknown>[]) {
  const values = new Map(rows.map((row) => [String(row.metric), distribution(row)]));
  return {
    signalToTriage: values.get("signal_to_triage") ?? emptyDistribution(),
    triageToWork: values.get("triage_to_work") ?? emptyDistribution(),
    workToVerification: values.get("work_to_verification") ?? emptyDistribution(),
    verificationToResolution: values.get("verification_to_resolution") ?? emptyDistribution(),
    endToEndResolution: values.get("end_to_end_resolution") ?? emptyDistribution(),
  };
}

function distribution(row: Record<string, unknown>): ImprovementLatencyDistribution {
  return { samples: integer(row.samples), medianMs: nullableInteger(row.median_ms), p95Ms: nullableInteger(row.p95_ms) };
}
function emptyDistribution(): ImprovementLatencyDistribution { return { samples: 0, medianMs: null, p95Ms: null }; }
function groupedCounts(rows: Record<string, unknown>[], key: string) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const name = String(row[key]);
    totals.set(name, (totals.get(name) ?? 0) + integer(row.cases));
  }
  return [...totals.entries()].map(([name, cases]) => ({ name, cases })).sort((a, b) => b.cases - a.cases || a.name.localeCompare(b.name));
}
function jsonCounts(value: unknown): ImprovementMetricCount[] {
  return Array.isArray(value) ? value.map((entry) => countRow(entry as Record<string, unknown>)) : [];
}
function countRow(row: Record<string, unknown>): ImprovementMetricCount { return { name: String(row.name), cases: integer(row.cases) }; }
function sumRows(rows: Record<string, unknown>[], key: string) { return rows.reduce((sum, row) => sum + integer(row[key]), 0); }
function rate(numerator: number, denominator: number) { return denominator > 0 ? numerator / denominator : null; }
function integer(value: unknown) { const number = Number(value ?? 0); return Number.isFinite(number) ? Math.trunc(number) : 0; }
function nullableInteger(value: unknown) { return value == null ? null : integer(value); }
function nullableNumber(value: unknown) { const number = value == null ? Number.NaN : Number(value); return Number.isFinite(number) ? number : null; }
function boundedInteger(value: number, min: number, max: number, name: string) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  const integerValue = Math.trunc(value);
  if (integerValue < min || integerValue > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return integerValue;
}
