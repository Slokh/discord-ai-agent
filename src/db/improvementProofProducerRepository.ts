import { randomUUID } from "node:crypto";
import type { DbPool } from "./pool.js";
import {
  IMPROVEMENT_PROOF_PRODUCERS,
  improvementProofProducerPolicy,
  type ImprovementProofProducerPolicy,
} from "../improvements/proofProducerRegistry.js";
import type { ImprovementProofTrigger } from "../improvements/proofAdapterTypes.js";

export type ImprovementProofProducerRunStatus = "started" | "succeeded" | "failed";
export type ImprovementProofProducerRun = {
  runId: string;
  trigger: ImprovementProofTrigger;
  runKey: string;
  status: ImprovementProofProducerRunStatus;
  revision: string | null;
  deploymentId: string | null;
  outcomeCode: string | null;
  metadata: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date | null;
};
export type ImprovementProofProducerHealth = {
  trigger: ImprovementProofTrigger;
  state: "healthy" | "unobserved" | "unhealthy";
  reason: "current" | "not_yet_observed" | "missed_sla" | "run_in_progress_too_long" | "repeated_failures" | "latest_run_failed";
  latestRun: ImprovementProofProducerRun | null;
  latestSuccessAt: Date | null;
  consecutiveFailures: number;
  maxSilenceMs: number | null;
  nextExpectedAt: Date | null;
  evidenceKey: string;
};

export async function recordImprovementProofProducerRun(pool: DbPool, input: {
  trigger: ImprovementProofTrigger;
  runKey: string;
  status: ImprovementProofProducerRunStatus;
  revision?: string | null;
  deploymentId?: string | null;
  outcomeCode?: string | null;
  observedAt?: Date;
}) {
  const policy = improvementProofProducerPolicy(input.trigger);
  if (!policy) throw new Error(`Unknown improvement proof producer: ${input.trigger}.`);
  const runKey = stableIdentifier(input.runKey, "runKey", 200);
  const observedAt = input.observedAt ?? new Date();
  const status = input.status;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO improvement_proof_producer_runs(
         run_id,trigger,run_key,status,revision,deployment_id,outcome_code,metadata,started_at,completed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(trigger,run_key) DO UPDATE SET
         status = CASE
           WHEN improvement_proof_producer_runs.status IN ('succeeded','failed')
             THEN improvement_proof_producer_runs.status
           ELSE EXCLUDED.status
         END,
         revision = coalesce(EXCLUDED.revision, improvement_proof_producer_runs.revision),
         deployment_id = coalesce(EXCLUDED.deployment_id, improvement_proof_producer_runs.deployment_id),
         outcome_code = coalesce(EXCLUDED.outcome_code, improvement_proof_producer_runs.outcome_code),
         metadata = improvement_proof_producer_runs.metadata || EXCLUDED.metadata,
         completed_at = CASE
           WHEN improvement_proof_producer_runs.status IN ('succeeded','failed')
             THEN improvement_proof_producer_runs.completed_at
           ELSE EXCLUDED.completed_at
         END,
         updated_at = now()
       RETURNING *`,
      [
        `ippr-${randomUUID()}`,
        input.trigger,
        runKey,
        status,
        nullableBounded(input.revision, 200),
        nullableBounded(input.deploymentId, 300),
        nullableBounded(input.outcomeCode, 100),
        JSON.stringify({}),
        observedAt,
        status === "started" ? null : observedAt,
      ],
    );
    const run = rowToRun(result.rows[0]);
    if (run.status === "succeeded" && run.revision && run.deploymentId) {
      await recordProducerRecoveryProofs(client, run);
    }
    await client.query("COMMIT");
    return run;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listImprovementProofProducerHealth(pool: DbPool, input: { now?: Date } = {}) {
  const now = input.now ?? new Date();
  const [runs, activations] = await Promise.all([
    pool.query(
      `SELECT * FROM (
         SELECT producer_run.*,
                row_number() OVER (PARTITION BY trigger ORDER BY started_at DESC, run_id DESC) AS position
         FROM improvement_proof_producer_runs producer_run
       ) ranked WHERE position <= 20 ORDER BY trigger, position`,
    ),
    pool.query("SELECT trigger,activated_at FROM improvement_proof_producers"),
  ]);
  const activatedAt = new Map(activations.rows.map((row) => [String(row.trigger), date(row.activated_at)]));
  const byTrigger = new Map<ImprovementProofTrigger, ImprovementProofProducerRun[]>();
  for (const row of runs.rows) {
    const run = rowToRun(row);
    const entries = byTrigger.get(run.trigger) ?? [];
    entries.push(run);
    byTrigger.set(run.trigger, entries);
  }
  return IMPROVEMENT_PROOF_PRODUCERS.map((policy) => producerHealth(
    policy,
    byTrigger.get(policy.trigger) ?? [],
    activatedAt.get(policy.trigger) ?? null,
    now,
  ));
}

async function recordProducerRecoveryProofs(database: Pick<DbPool, "query">, run: ImprovementProofProducerRun) {
  await database.query(
    `INSERT INTO improvement_verification_proofs(
       proof_id,case_id,contract_id,contract_version,revision,deployment_id,source,status,
       reference_type,reference_id,run_key,summary,metadata
     )
     SELECT 'ivp-' || gen_random_uuid(),case_row.case_id,contract.contract_id,contract.version,$1,$2,
            'producer_health','passed','proof_producer',$3::text,$4,
            'The registered proof producer completed successfully.',
            jsonb_build_object('trigger',$3::text,'producerRunId',$5::text)
     FROM improvement_cases case_row
     JOIN improvement_contracts contract ON contract.case_id = case_row.case_id AND contract.active = true
     WHERE case_row.status = 'verifying'
       AND contract.checks @> jsonb_build_array(jsonb_build_object('kind','proof_producer_health','reference',$3::text))
     ON CONFLICT(source,contract_id,deployment_id,reference_id,run_key) DO NOTHING`,
    [run.revision, run.deploymentId, run.trigger, run.runKey, run.runId],
  );
}

function producerHealth(
  policy: ImprovementProofProducerPolicy,
  runs: ImprovementProofProducerRun[],
  activatedAt: Date | null,
  now: Date,
): ImprovementProofProducerHealth {
  const latestRun = runs[0] ?? null;
  const latestSuccess = runs.find((run) => run.status === "succeeded") ?? null;
  const consecutiveFailures = runs.findIndex((run) => run.status !== "failed") === -1
    ? runs.filter((run) => run.status === "failed").length
    : runs.findIndex((run) => run.status !== "failed");
  let state: ImprovementProofProducerHealth["state"] = "healthy";
  let reason: ImprovementProofProducerHealth["reason"] = "current";
  const silenceAnchor = latestSuccess?.completedAt ?? activatedAt;
  if (!latestRun && !activatedAt) {
    state = "unobserved";
    reason = "not_yet_observed";
  } else if (latestRun?.status === "started" && now.getTime() - latestRun.startedAt.getTime() > policy.maxRunDurationMs) {
    state = "unhealthy";
    reason = "run_in_progress_too_long";
  } else if (latestRun?.status === "started") {
    state = "healthy";
    reason = "current";
  } else if (consecutiveFailures >= policy.consecutiveFailureThreshold) {
    state = "unhealthy";
    reason = policy.consecutiveFailureThreshold === 1 ? "latest_run_failed" : "repeated_failures";
  } else if (policy.mode === "scheduled" && policy.maxSilenceMs != null && silenceAnchor && now.getTime() - silenceAnchor.getTime() > policy.maxSilenceMs) {
    state = "unhealthy";
    reason = "missed_sla";
  } else if (!latestRun) {
    state = "unobserved";
    reason = "not_yet_observed";
  }
  const cadenceAnchor = latestRun?.startedAt ?? activatedAt;
  return {
    trigger: policy.trigger,
    state,
    reason,
    latestRun,
    latestSuccessAt: latestSuccess?.completedAt ?? null,
    consecutiveFailures,
    maxSilenceMs: policy.maxSilenceMs,
    nextExpectedAt: policy.expectedIntervalMs != null && cadenceAnchor
      ? new Date(cadenceAnchor.getTime() + policy.expectedIntervalMs)
      : null,
    evidenceKey: [policy.trigger, state, reason, latestRun?.runKey ?? "none", latestRun?.status ?? "none", latestSuccess?.runKey ?? "none"].join(":"),
  };
}

function rowToRun(row: Record<string, unknown>): ImprovementProofProducerRun {
  return {
    runId: String(row.run_id),
    trigger: String(row.trigger) as ImprovementProofTrigger,
    runKey: String(row.run_key),
    status: String(row.status) as ImprovementProofProducerRunStatus,
    revision: nullable(row.revision),
    deploymentId: nullable(row.deployment_id),
    outcomeCode: nullable(row.outcome_code),
    metadata: object(row.metadata),
    startedAt: date(row.started_at),
    completedAt: row.completed_at == null ? null : date(row.completed_at),
  };
}

function bounded(value: string, name: string, max: number) {
  const normalized = value.trim().slice(0, max);
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}
function stableIdentifier(value: string, name: string, max: number) {
  const normalized = bounded(value, name, max);
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) throw new Error(`${name} must be an opaque stable identifier.`);
  return normalized;
}
function nullableBounded(value: string | null | undefined, max: number) { const normalized = value?.trim().slice(0, max); return normalized || null; }
function nullable(value: unknown) { return value == null ? null : String(value); }
function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function date(value: unknown) { return value instanceof Date ? value : new Date(String(value)); }
