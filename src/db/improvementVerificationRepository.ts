import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { DbPool } from "./pool.js";
import type { ImprovementCase, ImprovementContractCheck, ImprovementPrivacy } from "./types.js";
import type { ImprovementReplayCheckResult } from "../observability/improvementContractReplay.js";
import { improvementCheckHash, improvementProofAdapterForCheck, isRevisionQualityClusterReference } from "../improvements/proofAdapters.js";
import {
  buildImprovementVerificationDossier,
  improvementVerificationApplicationKey,
  type ImprovementVerificationContract,
  type ImprovementVerificationDossier,
  type ImprovementVerificationProof,
  type ImprovementVerificationReceipt,
  type ImprovementVerificationStatus,
} from "../improvements/verification.js";

export type ImprovementEvalResultProof = {
  caseId: string;
  contractId: string;
  contractVersion: number;
  revision: string;
  deploymentId: string;
  status: ImprovementVerificationStatus;
  referenceId: string;
  runKey: string;
  durationMs: number;
  traceId: string | null;
  checkResults: ImprovementReplayCheckResult[];
};

export async function recordImprovementEvalResults(pool: DbPool, results: ImprovementEvalResultProof[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let recorded = 0;
    for (const input of results) {
      const proofId = `ivp-${randomUUID()}`;
      const contractRecord = await client.query(
        "SELECT checks FROM improvement_contracts WHERE contract_id = $1 AND case_id = $2 AND version = $3",
        [input.contractId, input.caseId, input.contractVersion],
      );
      if (!contractRecord.rows[0]) continue;
      const checkResults = safeCheckResultsForContract(
        input.checkResults,
        (contractRecord.rows[0].checks ?? []) as ImprovementContractCheck[],
      );
      if (proofStatus(checkResults) !== input.status) {
        throw new Error("Improvement replay aggregate status does not match its per-check conclusions.");
      }
      const execution = input.traceId ? await client.query(
        `SELECT execution.execution_id
         FROM agent_runtime_executions execution
         JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
         WHERE execution.trace_id = $1
           AND coalesce(nullif(execution.metadata->>'appRevision',''),nullif(session.metadata->>'appRevision',''),'unknown') = $2
         ORDER BY execution.created_at DESC LIMIT 1`,
        [bounded(input.traceId, "traceId", 300), bounded(input.revision, "revision", 200)],
      ) : null;
      if (input.status !== "inconclusive" && !execution?.rows[0]) {
        throw new Error("A terminal private replay proof requires a revision-matched runtime execution.");
      }
      const inserted = await client.query(
        `INSERT INTO improvement_verification_proofs(
           proof_id,case_id,contract_id,contract_version,revision,deployment_id,source,status,
           reference_type,reference_id,run_key,summary,metadata,execution_id,check_results
         )
         SELECT $1,contract.case_id,contract.contract_id,contract.version,$2,$3,'private_eval',$4,
                'private_eval_case',$5,$6,$7,$8,$9,$10
         FROM improvement_contracts contract
         WHERE contract.contract_id = $11 AND contract.case_id = $12 AND contract.version = $13
         ON CONFLICT(source,contract_id,deployment_id,reference_id,run_key) DO NOTHING
         RETURNING proof_id`,
        [proofId, bounded(input.revision, "revision", 200), bounded(input.deploymentId, "deploymentId", 300), input.status,
          bounded(input.referenceId, "referenceId", 300), bounded(input.runKey, "runKey", 200), proofSummary(input.status),
          JSON.stringify({ durationMs: Math.max(0, Math.trunc(input.durationMs)) }), execution?.rows[0]?.execution_id ?? null,
          JSON.stringify(checkResults), input.contractId, input.caseId, input.contractVersion],
      );
      recorded += inserted.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return { recorded, total: results.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordImprovementRevisionQualityResult(pool: DbPool, input: {
  revision: string;
  status: ImprovementVerificationStatus;
  runKey: string;
  presentFailureReferences?: string[];
  clusterAbsenceStatus?: Extract<ImprovementVerificationStatus, "passed" | "inconclusive">;
}) {
  const revision = bounded(input.revision, "revision", 200);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deployment = await client.query(
      "SELECT deployment_id FROM deployment_verifications WHERE revision = $1 ORDER BY verified_at DESC LIMIT 1",
      [revision],
    );
    if (!deployment.rows[0]) {
      await client.query("COMMIT");
      return { recorded: 0, deploymentId: null };
    }
    const deploymentId = String(deployment.rows[0].deployment_id);
    const candidates = await client.query(
      `SELECT case_row.case_id,contract.contract_id,contract.version,contract.checks
       FROM improvement_cases case_row
       JOIN improvement_contracts contract ON contract.case_id = case_row.case_id AND contract.active = true
       WHERE case_row.status = 'verifying'`,
    );
    const present = new Set((input.presentFailureReferences ?? []).map((reference) => bounded(reference, "failureReference", 200)));
    const runKey = bounded(input.runKey, "runKey", 200);
    let recorded = 0;
    for (const row of candidates.rows) {
      const references = revisionQualityReferences((row.checks ?? []) as ImprovementContractCheck[]);
      for (const reference of references) {
        const status = reference === "revision-quality-gate"
          ? input.status
          : present.has(reference)
            ? "failed"
            : input.clusterAbsenceStatus ?? "inconclusive";
        const result = await client.query(
          `INSERT INTO improvement_verification_proofs(
             proof_id,case_id,contract_id,contract_version,revision,deployment_id,source,status,
             reference_type,reference_id,run_key,summary,metadata
           ) VALUES ('ivp-' || gen_random_uuid(),$1,$2,$3,$4,$5,'revision_quality',$6,
                     'revision_quality',$7,$8,$9,'{}'::jsonb)
           ON CONFLICT(source,contract_id,deployment_id,reference_id,run_key) DO NOTHING
           RETURNING proof_id`,
          [String(row.case_id), String(row.contract_id), Number(row.version), revision, deploymentId, status,
            reference, runKey, qualityProofSummary(status, reference)],
        );
        recorded += result.rowCount ?? 0;
      }
    }
    await client.query("COMMIT");
    return { recorded, deploymentId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function inspectImprovementVerification(pool: DbPool, input: {
  caseId: string;
  revision: string;
  deploymentId?: string | null;
}) {
  return loadVerificationDossier(pool, input);
}

/** Rebuilds authoritative proof immediately before recording one immutable receipt. */
export async function verifyImprovementCase(pool: DbPool, input: {
  caseId: string;
  revision: string;
  deploymentId?: string | null;
  actorId: string;
  actorKind?: "operator" | "automation";
}) {
  const dossier = await loadVerificationDossier(pool, input);
  return applyVerificationDossier(pool, dossier, input.actorId, input.actorKind ?? "operator");
}

/** Runs after durable release promotion; failures remain case-local and never invalidate the release. */
export async function verifyImprovementCasesForDeployment(pool: DbPool, input: {
  revision: string;
  deploymentId: string;
  actorId?: string;
}) {
  const candidates = await pool.query(
    `SELECT case_id FROM improvement_cases
     WHERE status = 'verifying' AND merged_into_case_id IS NULL
     ORDER BY updated_at ASC, case_id ASC`,
  );
  const results: Array<{ caseId: string; status: ImprovementVerificationStatus | "error"; recorded: boolean; error?: string }> = [];
  for (const row of candidates.rows) {
    const caseId = String(row.case_id);
    try {
      const outcome = await verifyImprovementCase(pool, {
        caseId,
        revision: input.revision,
        deploymentId: input.deploymentId,
        actorId: input.actorId ?? "release-verifier",
        actorKind: "automation",
      });
      results.push({ caseId, status: outcome.receipt.status, recorded: outcome.recorded });
    } catch (error) {
      results.push({ caseId, status: "error", recorded: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

async function loadVerificationDossier(
  database: Pick<DbPool, "query">,
  input: { caseId: string; revision: string; deploymentId?: string | null },
): Promise<ImprovementVerificationDossier> {
  const caseResult = await database.query("SELECT * FROM improvement_cases WHERE case_id = $1", [input.caseId]);
  if (!caseResult.rows[0]) throw new Error(`Improvement case ${input.caseId} was not found.`);
  const improvementCase = minimalCase(caseResult.rows[0]);
  if (!(["verifying", "resolved", "actionable"] as ImprovementCase["status"][]).includes(improvementCase.status)) {
    throw new Error("Only a verifying improvement case can collect deployed contract proof.");
  }
  const contractResult = await database.query(
    "SELECT * FROM improvement_contracts WHERE case_id = $1 AND active = true ORDER BY version DESC LIMIT 1",
    [input.caseId],
  );
  if (!contractResult.rows[0]) throw new Error("Deployment verification requires an active contract.");
  const contract = verificationContract(contractResult.rows[0]);
  if (!contract.executable) throw new Error("Deployment verification requires an executable contract.");
  const revision = bounded(input.revision, "revision", 200);
  const deployment = input.deploymentId
    ? await database.query(
      "SELECT revision,deployment_id,verified_at FROM deployment_verifications WHERE revision = $1 AND deployment_id = $2",
      [revision, bounded(input.deploymentId, "deploymentId", 300)],
    )
    : await database.query(
      "SELECT revision,deployment_id,verified_at FROM deployment_verifications WHERE revision = $1 ORDER BY verified_at DESC LIMIT 1",
      [revision],
    );
  if (!deployment.rows[0]) throw new Error(`Revision ${revision} has no durable deployment verification.`);
  const deploymentId = String(deployment.rows[0].deployment_id);
  const proofResult = await database.query(
    `SELECT * FROM improvement_verification_proofs
     WHERE contract_id = $1 AND revision = $2 AND deployment_id = $3
     ORDER BY created_at DESC, proof_id DESC`,
    [contract.contractId, revision, deploymentId],
  );
  return buildImprovementVerificationDossier({
    improvementCase,
    contract,
    revision,
    deploymentId,
    deploymentVerifiedAt: new Date(deployment.rows[0].verified_at),
    proofs: uniqueProofSources(proofResult.rows.map(verificationProof)),
  });
}

async function applyVerificationDossier(
  pool: DbPool,
  dossier: ImprovementVerificationDossier,
  actorId: string,
  actorKind: "operator" | "automation",
) {
  const expectedKey = improvementVerificationApplicationKey({
    caseId: dossier.case.caseId,
    contractId: dossier.contract.contractId,
    contractVersion: dossier.contract.version,
    revision: dossier.deployment.revision,
    deploymentId: dossier.deployment.deploymentId,
    executionId: dossier.executionId,
    status: dossier.status,
    checks: dossier.checks,
  });
  if (expectedKey !== dossier.applicationKey) throw new Error("Improvement verification application key does not match its proof.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const caseResult = await client.query("SELECT * FROM improvement_cases WHERE case_id = $1 FOR UPDATE", [dossier.case.caseId]);
    if (!caseResult.rows[0]) throw new Error(`Improvement case ${dossier.case.caseId} was not found.`);
    const current = minimalCase(caseResult.rows[0]);
    const prior = await client.query("SELECT * FROM improvement_verification_receipts WHERE application_key = $1", [dossier.applicationKey]);
    if (prior.rows[0]) {
      await client.query("COMMIT");
      return { recorded: false, case: current, receipt: rowToImprovementVerificationReceipt(prior.rows[0]) };
    }
    if (current.version !== dossier.case.version) throw new Error(`Improvement case ${current.caseId} changed; regenerate deployed proof.`);
    if (current.status !== "verifying") throw new Error("Only a verifying improvement case can apply deployed contract proof.");
    const contract = await client.query(
      "SELECT * FROM improvement_contracts WHERE contract_id = $1 AND case_id = $2 AND version = $3 AND active = true FOR UPDATE",
      [dossier.contract.contractId, current.caseId, dossier.contract.version],
    );
    if (!contract.rows[0]) throw new Error("The active improvement contract changed; regenerate deployed proof.");
    const deployment = await client.query(
      "SELECT 1 FROM deployment_verifications WHERE revision = $1 AND deployment_id = $2",
      [dossier.deployment.revision, dossier.deployment.deploymentId],
    );
    if (!deployment.rowCount) throw new Error("The deployment proof is no longer available.");

    const receiptId = `ivr-${randomUUID()}`;
    const evidenceId = `evi-${randomUUID()}`;
    const evidenceKind = dossier.status === "passed" ? "deployment_verification" : "contract_verification";
    const disposition = dossier.status === "passed" ? "supports" : dossier.status === "failed" ? "contradicts" : "inconclusive";
    const summary = receiptSummary(dossier.status, dossier.contract.version, dossier.deployment.revision);
    await client.query(
      `INSERT INTO improvement_evidence(
         evidence_id,case_id,kind,disposition,summary,reference_type,reference_id,collected_by_execution_id,privacy,metadata
       ) VALUES ($1,$2,$3,$4,$5,'improvement_verification_receipt',$6,$7,$8,$9)`,
      [evidenceId, current.caseId, evidenceKind, disposition, summary, receiptId, dossier.executionId, current.privacy,
        JSON.stringify({ revision: dossier.deployment.revision, deploymentId: dossier.deployment.deploymentId, contractVersion: dossier.contract.version })],
    );
    const transitionApplied = dossier.status !== "inconclusive";
    const receipt = await client.query(
      `INSERT INTO improvement_verification_receipts(
         receipt_id,case_id,contract_id,contract_version,revision,deployment_id,execution_id,status,
         checks,application_key,evidence_id,applied,actor_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [receiptId, current.caseId, dossier.contract.contractId, dossier.contract.version, dossier.deployment.revision,
        dossier.deployment.deploymentId, dossier.executionId, dossier.status, JSON.stringify(dossier.checks), dossier.applicationKey,
        evidenceId, transitionApplied, actorId],
    );
    let updated = current;
    if (dossier.status === "passed") {
      const result = await client.query(
        `UPDATE improvement_cases SET status = 'resolved', resolution = $2, resolved_at = now(), version = version + 1, updated_at = now()
         WHERE case_id = $1 RETURNING *`,
        [current.caseId, `Contract v${dossier.contract.version} verified on deployment ${dossier.deployment.revision}.`],
      );
      updated = minimalCase(result.rows[0]);
    } else if (dossier.status === "failed") {
      const result = await client.query(
        `UPDATE improvement_cases SET status = 'actionable', resolution = NULL, resolved_at = NULL, version = version + 1, updated_at = now()
         WHERE case_id = $1 RETURNING *`,
        [current.caseId],
      );
      updated = minimalCase(result.rows[0]);
    }
    await insertVerificationEvent(client, {
      caseId: current.caseId,
      eventName: `verification.${dossier.status}`,
      actorId,
      actorKind,
      summary,
      metadata: { receiptId, evidenceId, revision: dossier.deployment.revision, deploymentId: dossier.deployment.deploymentId, contractVersion: dossier.contract.version },
    });
    await client.query("COMMIT");
    return { recorded: true, case: updated, receipt: rowToImprovementVerificationReceipt(receipt.rows[0]) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function rowToImprovementVerificationReceipt(row: Record<string, unknown>): ImprovementVerificationReceipt {
  return {
    receiptId: String(row.receipt_id),
    caseId: String(row.case_id),
    contractId: String(row.contract_id),
    contractVersion: Number(row.contract_version),
    revision: String(row.revision),
    deploymentId: String(row.deployment_id),
    executionId: nullable(row.execution_id),
    status: String(row.status) as ImprovementVerificationStatus,
    checks: Array.isArray(row.checks) ? row.checks : [],
    applicationKey: String(row.application_key),
    evidenceId: nullable(row.evidence_id),
    applied: Boolean(row.applied),
    actorId: nullable(row.actor_id),
    createdAt: date(row.created_at),
  } as ImprovementVerificationReceipt;
}

function minimalCase(row: Record<string, unknown>) {
  return {
    caseId: String(row.case_id),
    version: Number(row.version),
    status: String(row.status) as ImprovementCase["status"],
    privacy: String(row.privacy) as ImprovementPrivacy,
    title: String(row.title),
  };
}

function verificationContract(row: Record<string, unknown>): ImprovementVerificationContract {
  return {
    contractId: String(row.contract_id),
    caseId: String(row.case_id),
    version: Number(row.version),
    expectedBehavior: String(row.expected_behavior),
    checks: Array.isArray(row.checks) ? row.checks as ImprovementContractCheck[] : [],
    executable: Boolean(row.executable),
    createdAt: date(row.created_at),
  };
}

function verificationProof(row: Record<string, unknown>): ImprovementVerificationProof {
  return {
    status: String(row.status) as ImprovementVerificationStatus,
    source: String(row.source) as ImprovementVerificationProof["source"],
    referenceType: String(row.reference_type),
    referenceId: String(row.reference_id),
    summary: String(row.summary),
    executionId: nullable(row.execution_id),
    checkResults: Array.isArray(row.check_results) ? row.check_results as ImprovementReplayCheckResult[] : [],
    createdAt: date(row.created_at),
  };
}

async function insertVerificationEvent(client: PoolClient, input: {
  caseId: string;
  eventName: string;
  actorId: string;
  actorKind: "operator" | "automation";
  summary: string;
  metadata: Record<string, unknown>;
}) {
  await client.query(
    `INSERT INTO improvement_case_events(case_id,event_name,actor_kind,actor_id,summary,metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.caseId, input.eventName, input.actorKind, input.actorId, input.summary, JSON.stringify(input.metadata)],
  );
}

function proofSummary(status: ImprovementVerificationStatus) {
  if (status === "passed") return "The case-specific private contract replay passed.";
  if (status === "failed") return "The case-specific private contract replay failed.";
  return "The case-specific private contract replay did not produce executable proof.";
}

function qualityProofSummary(status: ImprovementVerificationStatus, reference = "revision-quality-gate") {
  if (reference !== "revision-quality-gate") {
    if (status === "passed") return "The deployed revision had enough traffic and did not reproduce this failure cluster.";
    if (status === "failed") return "Production observation reproduced this failure cluster on the deployed revision.";
    return "The deployed revision does not yet have enough member traffic to disprove this failure cluster.";
  }
  if (status === "passed") return "The deployed revision passed its traffic-sampled production quality gate.";
  if (status === "failed") return "The deployed revision failed its traffic-sampled production quality gate.";
  return "The deployed revision does not yet have enough member traffic for the production quality gate.";
}

function uniqueProofSources(proofs: ImprovementVerificationProof[]) {
  const seen = new Set<string>();
  return proofs.filter((proof) => {
    const key = `${proof.source}:${proof.referenceId}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });
}

function revisionQualityReferences(checks: ImprovementContractCheck[]) {
  const references = new Set<string>();
  for (const check of checks) {
    if (check.kind === "delivery_state" && check.state === "delivered") references.add("revision-quality-gate");
    if (check.kind === "deployment_canary" && (check.reference === "revision-quality-gate" || isRevisionQualityClusterReference(check.reference))) {
      references.add(check.reference);
    }
  }
  return [...references];
}

function receiptSummary(status: ImprovementVerificationStatus, contractVersion: number, revision: string) {
  if (status === "passed") return `Every executable check in contract v${contractVersion} passed on verified revision ${revision}.`;
  if (status === "failed") return `At least one executable check in contract v${contractVersion} failed on verified revision ${revision}.`;
  return `Contract v${contractVersion} lacks complete proof on verified revision ${revision}.`;
}

function bounded(value: string, name: string, max: number) {
  const normalized = value.trim().slice(0, max);
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function safeCheckResultsForContract(results: ImprovementReplayCheckResult[], checks: ImprovementContractCheck[]) {
  const expected = checks
    .filter((check) => improvementProofAdapterForCheck(check)?.id === "private_replay")
    .map(improvementCheckHash);
  const seen = new Set<string>();
  const safe = results.map((result) => {
    if (!/^[a-f0-9]{64}$/.test(result.checkHash)) throw new Error("Improvement replay check hash is invalid.");
    if (!(["passed", "failed", "inconclusive"] as const).includes(result.status)) throw new Error("Improvement replay check status is invalid.");
    if (seen.has(result.checkHash)) throw new Error("Improvement replay check results contain a duplicate conclusion.");
    seen.add(result.checkHash);
    return { checkHash: result.checkHash, status: result.status };
  });
  if (safe.length !== expected.length || expected.some((checkHash) => !seen.has(checkHash))) {
    throw new Error("Improvement replay check results do not match the contract's private-replay checks.");
  }
  return safe;
}

function proofStatus(results: ImprovementReplayCheckResult[]): ImprovementVerificationStatus {
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.length > 0 && results.every((result) => result.status === "passed")) return "passed";
  return "inconclusive";
}

function nullable(value: unknown) { return value == null ? null : String(value); }
function date(value: unknown) { return value instanceof Date ? value : new Date(String(value)); }
