import type { DbPool } from "../db/pool.js";

const MEMBER_COHORT_SQL = "coalesce(nullif(execution.metadata->>'qualityCohort', ''), nullif(session.metadata->>'qualityCohort', '')) = 'member'";

export type RevisionQuality = {
  revision: string;
  windowHours: number;
  generatedAt: string;
  answers: Record<string, unknown>[];
  tools: Record<string, unknown>[];
  signals: Record<string, unknown>[];
  deliveries: Record<string, unknown>[];
  feedback: Record<string, unknown>[];
};

export type RevisionHealthPolicy = {
  minimumAnswers: number;
  minimumToolCalls: number;
  maxAnswerFailureRate: number;
  maxToolFailureRate: number;
  maxBadFeedbackRate: number;
  maxP95Ms: number;
  maxPendingDeliveries: number;
  maxAbandonedDeliveries: number;
  maxErrorSignals: number;
  maxFailureRateIncrease: number;
  maxLatencyMultiplier: number;
};

export type RevisionHealthAssessment = {
  status: "pass" | "insufficient_data" | "fail";
  recommendation: "rollout_healthy" | "observe" | "investigate" | "rollback_candidate";
  metrics: {
    answers: number;
    answerFailures: number;
    answerFailureRate: number;
    toolCalls: number;
    toolFailures: number;
    toolFailureRate: number;
    feedback: number;
    badFeedback: number;
    badFeedbackRate: number;
    p95Ms: number;
    pendingDeliveries: number;
    abandonedDeliveries: number;
    errorSignals: number;
  };
  violations: string[];
  comparisons: string[];
};

export const defaultRevisionHealthPolicy: RevisionHealthPolicy = Object.freeze({
  minimumAnswers: 10,
  minimumToolCalls: 5,
  maxAnswerFailureRate: 0.1,
  maxToolFailureRate: 0.15,
  maxBadFeedbackRate: 0.2,
  maxP95Ms: 120_000,
  maxPendingDeliveries: 0,
  maxAbandonedDeliveries: 0,
  maxErrorSignals: 0,
  maxFailureRateIncrease: 0.05,
  maxLatencyMultiplier: 1.5,
});

/** Returns content-free production quality aggregates from the canonical runtime ledger. */
export async function collectRevisionQuality(
  pool: DbPool,
  revision: string,
  hours: number,
): Promise<RevisionQuality> {
  const [answers, tools, signals, deliveries, feedback] = await Promise.all([
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
      `SELECT coalesce(event.metadata->>'toolName', 'unknown') AS tool,
              coalesce(event.metadata->>'status', 'ok') AS status,
              count(*)::int AS count
       FROM agent_runtime_events event
       JOIN agent_runtime_executions execution ON execution.execution_id = event.execution_id
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE event.created_at >= now() - ($1::text || ' hours')::interval
         AND event.event_name = 'agent.tool.complete'
         AND execution.task_id IS NULL
         AND execution.harness = 'nanocodex'
         AND ${MEMBER_COHORT_SQL}
         AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
       GROUP BY 1, 2
       ORDER BY 1, 2`,
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
      `SELECT feedback.rating,
              coalesce(feedback.failure_mode, 'unclassified') AS failure_mode,
              count(*)::int AS count
       FROM agent_run_feedback feedback
       JOIN agent_runtime_executions execution ON execution.execution_id = feedback.run_id
       JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
       WHERE feedback.updated_at >= now() - ($1::text || ' hours')::interval
         AND execution.task_id IS NULL
         AND execution.harness = 'nanocodex'
         AND ${MEMBER_COHORT_SQL}
         AND coalesce(nullif(execution.metadata->>'appRevision', ''), nullif(session.metadata->>'appRevision', ''), 'unknown') = $2
       GROUP BY feedback.rating, feedback.failure_mode
       ORDER BY feedback.rating, feedback.failure_mode`,
      [hours, revision],
    ),
  ]);

  return {
    revision,
    windowHours: hours,
    generatedAt: new Date().toISOString(),
    answers: answers.rows,
    tools: tools.rows,
    signals: signals.rows,
    deliveries: deliveries.rows,
    feedback: feedback.rows,
  };
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
  const comparisons: string[] = [];

  if (metrics.answers >= policy.minimumAnswers && metrics.answerFailureRate > policy.maxAnswerFailureRate) {
    violations.push(`answer failure rate ${percent(metrics.answerFailureRate)} exceeds ${percent(policy.maxAnswerFailureRate)}`);
  }
  if (metrics.toolCalls >= policy.minimumToolCalls && metrics.toolFailureRate > policy.maxToolFailureRate) {
    violations.push(`tool failure rate ${percent(metrics.toolFailureRate)} exceeds ${percent(policy.maxToolFailureRate)}`);
  }
  if (metrics.answers >= policy.minimumAnswers && metrics.badFeedbackRate > policy.maxBadFeedbackRate) {
    violations.push(`bad feedback per answer ${percent(metrics.badFeedbackRate)} exceeds ${percent(policy.maxBadFeedbackRate)}`);
  }
  if (metrics.answers >= policy.minimumAnswers && metrics.p95Ms > policy.maxP95Ms) {
    violations.push(`answer p95 ${metrics.p95Ms}ms exceeds ${policy.maxP95Ms}ms`);
  }
  if (metrics.pendingDeliveries > policy.maxPendingDeliveries) {
    violations.push(`${metrics.pendingDeliveries} overdue deliveries exceed ${policy.maxPendingDeliveries}`);
  }
  if (metrics.abandonedDeliveries > policy.maxAbandonedDeliveries) {
    violations.push(`${metrics.abandonedDeliveries} abandoned deliveries exceed ${policy.maxAbandonedDeliveries}`);
  }
  if (metrics.errorSignals > policy.maxErrorSignals) {
    violations.push(`${metrics.errorSignals} error signals exceed ${policy.maxErrorSignals}`);
  }

  if (baselineMetrics && metrics.answers >= policy.minimumAnswers && baselineMetrics.answers >= policy.minimumAnswers) {
    const failureIncrease = metrics.answerFailureRate - baselineMetrics.answerFailureRate;
    if (failureIncrease > policy.maxFailureRateIncrease) {
      comparisons.push(`answer failure rate increased by ${percent(failureIncrease)} from ${baseline?.revision}`);
    }
    if (baselineMetrics.p95Ms > 0 && metrics.p95Ms > baselineMetrics.p95Ms * policy.maxLatencyMultiplier) {
      comparisons.push(`answer p95 is ${(metrics.p95Ms / baselineMetrics.p95Ms).toFixed(2)}x ${baseline?.revision}`);
    }
  }
  violations.push(...comparisons);

  if (violations.length > 0) {
    const baselineHealthy = baseline && baselineMetrics && baselineMetrics.answers >= policy.minimumAnswers &&
      assessRevisionQuality(baseline, null, policy).status === "pass";
    return { status: "fail", recommendation: baselineHealthy ? "rollback_candidate" : "investigate", metrics, violations, comparisons };
  }
  if (metrics.answers < policy.minimumAnswers) {
    return { status: "insufficient_data", recommendation: "observe", metrics, violations, comparisons };
  }
  return { status: "pass", recommendation: "rollout_healthy", metrics, violations, comparisons };
}

function qualityMetrics(quality: RevisionQuality): RevisionHealthAssessment["metrics"] {
  const answers = total(quality.answers);
  const answerFailures = total(quality.answers, (row) => ["failed", "cancelled", "timed_out"].includes(String(row.status)));
  const toolCalls = total(quality.tools);
  const toolFailures = total(quality.tools, (row) => !["ok", "succeeded", "success"].includes(String(row.status)));
  const feedback = total(quality.feedback);
  const badFeedback = total(quality.feedback, (row) => String(row.rating) === "bad");
  return {
    answers,
    answerFailures,
    answerFailureRate: rate(answerFailures, answers),
    toolCalls,
    toolFailures,
    toolFailureRate: rate(toolFailures, toolCalls),
    feedback,
    badFeedback,
    badFeedbackRate: rate(badFeedback, answers),
    p95Ms: Math.max(0, ...quality.answers.map((row) => numeric(row.p95_ms))),
    pendingDeliveries: total(quality.deliveries, (row) => String(row.state) === "pending"),
    abandonedDeliveries: total(quality.deliveries, (row) => String(row.state) === "abandoned"),
    errorSignals: total(quality.signals, (row) => String(row.level) === "error"),
  };
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
