import { randomUUID } from "node:crypto";
import type {
  ImprovementCase,
  ImprovementCaseStatus,
  ImprovementClassification,
  ImprovementContractCheck,
  ImprovementPrivacy,
  ImprovementSeverity,
  ImprovementSignal,
  ImprovementSignalSource,
} from "./types.js";
import type { DbPool } from "./pool.js";
import { assertActionableContract, assertImprovementChecks, assertImprovementTransition, improvementChecksExecutable } from "../improvements/policy.js";
import { normalizeImprovementTitle } from "../improvements/coalescing.js";

export type RecordImprovementSignalInput = {
  source: ImprovementSignalSource;
  sourceKey: string;
  reporterKind: ImprovementSignal["reporterKind"];
  reporterId?: string | null;
  guildId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  executionId?: string | null;
  taskId?: string | null;
  appRevision?: string | null;
  scope?: ImprovementCase["scope"];
  privacy?: ImprovementPrivacy;
  summary: string;
  details?: string | null;
  severity?: ImprovementSeverity;
  classification?: ImprovementClassification;
  owningDomain?: string | null;
  fingerprint?: string | null;
  metadata?: Record<string, unknown>;
  observedAt?: Date;
};

export async function recordImprovementSignal(pool: DbPool, input: RecordImprovementSignalInput): Promise<{
  case: ImprovementCase;
  signal: ImprovementSignal;
  caseCreated: boolean;
  signalCreated: boolean;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sourceKey = required(input.sourceKey, "sourceKey", 500);
    const existing = await client.query("SELECT * FROM improvement_signals WHERE source_key = $1 FOR UPDATE", [sourceKey]);
    if (existing.rows[0]) {
      let signal = rowToImprovementSignal(existing.rows[0]);
      if (!signal.active) {
        const reactivated = await client.query(
          `UPDATE improvement_signals SET active = true, withdrawn_at = NULL, observed_at = coalesce($2, now()), updated_at = now()
           WHERE signal_id = $1 RETURNING *`,
          [signal.signalId, input.observedAt ?? null],
        );
        signal = rowToImprovementSignal(reactivated.rows[0]);
        await client.query(
          `UPDATE improvement_cases SET status = CASE WHEN status = 'dismissed' AND resolution = 'All source signals were withdrawn.' THEN 'open' ELSE status END,
             resolution = CASE WHEN status = 'dismissed' AND resolution = 'All source signals were withdrawn.' THEN NULL ELSE resolution END,
             resolved_at = CASE WHEN status = 'dismissed' AND resolution = 'All source signals were withdrawn.' THEN NULL ELSE resolved_at END,
             last_seen_at = greatest(last_seen_at, coalesce($2, now())), version = version + 1, updated_at = now()
           WHERE case_id = $1`,
          [signal.caseId, input.observedAt ?? null],
        );
        await insertCaseEvent(client, { caseId: signal.caseId, signalId: signal.signalId, eventName: "signal.reactivated", actorKind: input.reporterKind, actorId: input.reporterId });
      }
      const caseResult = await client.query("SELECT * FROM improvement_cases WHERE case_id = $1", [signal.caseId]);
      await client.query("COMMIT");
      return { case: rowToImprovementCase(caseResult.rows[0]), signal, caseCreated: false, signalCreated: false };
    }

    const privacy = input.privacy ?? "private";
    const scope = input.scope ?? (input.guildId ? "guild" : "repository");
    const fingerprint = input.fingerprint?.trim() || null;
    if (fingerprint) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`improvement:${input.guildId ?? "global"}:${privacy}:${fingerprint}`]);
    const candidate = fingerprint
      ? await client.query(
          `SELECT * FROM improvement_cases
           WHERE guild_id IS NOT DISTINCT FROM $1 AND privacy = $2 AND fingerprint = $3
             AND merged_into_case_id IS NULL AND status NOT IN ('resolved', 'dismissed')
           ORDER BY last_seen_at DESC LIMIT 1 FOR UPDATE`,
          [input.guildId ?? null, privacy, fingerprint],
        )
      : { rows: [] as Record<string, unknown>[] };
    const caseCreated = !candidate.rows[0];
    const caseId = candidate.rows[0] ? String(candidate.rows[0].case_id) : `imp-${randomUUID()}`;
    const title = normalizeImprovementTitle(input.summary);
    if (!title) throw new Error("Improvement signal summary is required.");
    let improvementCase: ImprovementCase;
    if (candidate.rows[0]) {
      const updated = await client.query(
        `UPDATE improvement_cases SET
           last_seen_at = greatest(last_seen_at, coalesce($2, now())),
           severity = CASE
             WHEN array_position(ARRAY['low','medium','high','critical'], $3::text) > array_position(ARRAY['low','medium','high','critical'], severity)
               THEN $3 ELSE severity END,
           version = version + 1, updated_at = now()
         WHERE case_id = $1 RETURNING *`,
        [caseId, input.observedAt ?? null, input.severity ?? "medium"],
      );
      improvementCase = rowToImprovementCase(updated.rows[0]);
    } else {
      const inserted = await client.query(
        `INSERT INTO improvement_cases(
           case_id, guild_id, scope, privacy, title, classification, severity,
           owning_domain, fingerprint, metadata, first_seen_at, last_seen_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11,now()),coalesce($11,now())) RETURNING *`,
        [caseId, input.guildId ?? null, scope, privacy, title, input.classification ?? "unknown", input.severity ?? "medium",
          input.owningDomain ?? null, fingerprint, JSON.stringify(input.metadata ?? {}), input.observedAt ?? null],
      );
      improvementCase = rowToImprovementCase(inserted.rows[0]);
    }

    const signalId = `sig-${randomUUID()}`;
    const insertedSignal = await client.query(
      `INSERT INTO improvement_signals(
         signal_id, case_id, source, source_key, reporter_kind, reporter_id,
         guild_id, channel_id, message_id, execution_id, task_id, app_revision,
         privacy, summary, details, severity_hint, classification_hint,
         owning_domain_hint, fingerprint, metadata, observed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,coalesce($21,now())) RETURNING *`,
      [signalId, caseId, input.source, sourceKey, input.reporterKind, input.reporterId ?? null,
        input.guildId ?? null, input.channelId ?? null, input.messageId ?? null, input.executionId ?? null, input.taskId ?? null,
        input.appRevision ?? null, privacy, title, input.details?.slice(0, 12_000) ?? null, input.severity ?? null,
        input.classification ?? null, input.owningDomain ?? null, fingerprint, JSON.stringify(input.metadata ?? {}), input.observedAt ?? null],
    );
    const signal = rowToImprovementSignal(insertedSignal.rows[0]);
    await insertCaseEvent(client, {
      caseId,
      signalId,
      eventName: "signal.received",
      actorKind: input.reporterKind,
      actorId: input.reporterId,
      summary: title,
      metadata: { source: input.source, caseCreated },
    });
    if (caseCreated) await insertCaseEvent(client, { caseId, eventName: "case.created", actorKind: "system", summary: title });
    else await insertCaseEvent(client, { caseId, signalId, eventName: "case.coalesced", actorKind: "system", summary: "Attached a matching signal to the existing case." });
    await client.query("COMMIT");
    return { case: improvementCase, signal, caseCreated, signalCreated: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function withdrawImprovementSignal(pool: DbPool, input: { sourceKey: string; actorId?: string | null }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE improvement_signals SET active = false, withdrawn_at = now(), updated_at = now()
       WHERE source_key = $1 AND active = true RETURNING *`,
      [input.sourceKey],
    );
    if (!result.rows[0]) { await client.query("COMMIT"); return false; }
    const signal = rowToImprovementSignal(result.rows[0]);
    await insertCaseEvent(client, { caseId: signal.caseId, signalId: signal.signalId, eventName: "signal.withdrawn", actorKind: "member", actorId: input.actorId });
    const active = await client.query("SELECT 1 FROM improvement_signals WHERE case_id = $1 AND active = true LIMIT 1", [signal.caseId]);
    if (!active.rowCount) {
      await client.query(
        `UPDATE improvement_cases SET status = 'dismissed', resolution = 'All source signals were withdrawn.', resolved_at = now(), version = version + 1, updated_at = now()
         WHERE case_id = $1 AND status IN ('open', 'needs_evidence')`,
        [signal.caseId],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function listImprovementSignalsForReporter(pool: DbPool, input: { guildId: string; reporterId: string; visibleChannelIds?: string[]; limit?: number }) {
  const result = await pool.query(
    `SELECT signal.*, case_row.status AS case_status, case_row.classification AS case_classification,
            case_row.severity AS case_severity, case_row.title AS case_title, case_row.updated_at AS case_updated_at
     FROM improvement_signals signal JOIN improvement_cases case_row USING(case_id)
     WHERE signal.guild_id = $1 AND signal.reporter_id = $2 AND signal.active = true
       AND (signal.channel_id IS NULL OR signal.channel_id = ANY($3::text[]))
     ORDER BY signal.observed_at DESC LIMIT $4`,
    [input.guildId, input.reporterId, input.visibleChannelIds ?? [], boundedLimit(input.limit)],
  );
  return result.rows.map((row) => ({ signal: rowToImprovementSignal(row), case: rowToImprovementCaseProjection(row) }));
}

export async function withdrawImprovementSignalsForMessage(pool: DbPool, input: { guildId: string; messageId: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE improvement_signals SET active = false, withdrawn_at = now(), updated_at = now()
       WHERE guild_id = $1 AND message_id = $2 AND source = 'member_report' AND active = true
       RETURNING case_id`,
      [input.guildId, input.messageId],
    );
    const caseIds = [...new Set(result.rows.map((row) => String(row.case_id)))];
    if (caseIds.length) {
      await client.query(
        `UPDATE improvement_cases case_row SET status = 'dismissed', resolution = 'All source signals were withdrawn.',
           resolved_at = now(), version = version + 1, updated_at = now()
         WHERE case_row.case_id = ANY($1::text[]) AND case_row.status IN ('open', 'needs_evidence')
           AND NOT EXISTS (SELECT 1 FROM improvement_signals signal WHERE signal.case_id = case_row.case_id AND signal.active = true)`,
        [caseIds],
      );
    }
    await client.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function listImprovementCases(pool: DbPool, input: { statuses?: ImprovementCaseStatus[]; limit?: number } = {}) {
  const result = await pool.query(
    `SELECT * FROM improvement_cases
     WHERE merged_into_case_id IS NULL AND (cardinality($1::text[]) = 0 OR status = ANY($1::text[]))
     ORDER BY last_seen_at DESC, case_id DESC LIMIT $2`,
    [input.statuses ?? [], boundedLimit(input.limit, 100)],
  );
  return result.rows.map(rowToImprovementCase);
}

export async function suggestImprovementCaseMerges(pool: DbPool, input: { caseId: string; limit?: number }) {
  const result = await pool.query(
    `SELECT candidate.*, similarity(source.title, candidate.title)::float AS similarity
     FROM improvement_cases source
     JOIN improvement_cases candidate ON candidate.case_id <> source.case_id
       AND candidate.guild_id IS NOT DISTINCT FROM source.guild_id
       AND candidate.privacy = source.privacy
       AND candidate.merged_into_case_id IS NULL
       AND candidate.status NOT IN ('resolved', 'dismissed')
       AND (candidate.owning_domain IS NOT DISTINCT FROM source.owning_domain OR candidate.classification = source.classification)
     WHERE source.case_id = $1 AND similarity(source.title, candidate.title) >= 0.35
     ORDER BY similarity DESC, candidate.last_seen_at DESC LIMIT $2`,
    [input.caseId, boundedLimit(input.limit, 20)],
  );
  return result.rows.map((row) => ({ case: rowToImprovementCase(row), similarity: Number(row.similarity) }));
}

export async function getImprovementCase(pool: DbPool, caseId: string) {
  const [caseResult, signals, evidence, contracts, events] = await Promise.all([
    pool.query("SELECT * FROM improvement_cases WHERE case_id = $1", [caseId]),
    pool.query("SELECT * FROM improvement_signals WHERE case_id = $1 ORDER BY observed_at ASC", [caseId]),
    pool.query("SELECT * FROM improvement_evidence WHERE case_id = $1 ORDER BY created_at ASC", [caseId]),
    pool.query("SELECT * FROM improvement_contracts WHERE case_id = $1 ORDER BY version DESC", [caseId]),
    pool.query("SELECT * FROM improvement_case_events WHERE case_id = $1 ORDER BY event_id ASC", [caseId]),
  ]);
  if (!caseResult.rows[0]) return undefined;
  return {
    case: rowToImprovementCase(caseResult.rows[0]),
    signals: signals.rows.map(rowToImprovementSignal),
    evidence: evidence.rows.map(rowToEvidence),
    contracts: contracts.rows.map(rowToContract),
    events: events.rows.map(rowToEvent),
  };
}

export async function transitionImprovementCase(pool: DbPool, input: {
  caseId: string;
  to: ImprovementCaseStatus;
  actorKind: "operator" | "developer" | "automation" | "system";
  actorId?: string | null;
  classification?: ImprovementClassification;
  severity?: ImprovementSeverity;
  owningDomain?: string | null;
  resolution?: string | null;
  expectedVersion?: number;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query("SELECT * FROM improvement_cases WHERE case_id = $1 FOR UPDATE", [input.caseId]);
    if (!currentResult.rows[0]) throw new Error(`Improvement case ${input.caseId} was not found.`);
    const current = rowToImprovementCase(currentResult.rows[0]);
    if (input.expectedVersion != null && current.version !== input.expectedVersion) throw new Error(`Improvement case ${input.caseId} changed; expected version ${input.expectedVersion}, found ${current.version}.`);
    assertImprovementTransition(current.status, input.to);
    if (input.to === "actionable") {
      const contract = await client.query("SELECT checks FROM improvement_contracts WHERE case_id = $1 AND active = true", [input.caseId]);
      assertActionableContract((contract.rows[0]?.checks ?? []) as ImprovementContractCheck[]);
      const evidence = await client.query("SELECT 1 FROM improvement_evidence WHERE case_id = $1 AND disposition = 'supports' LIMIT 1", [input.caseId]);
      if (!evidence.rowCount) throw new Error("An actionable improvement case requires supporting evidence.");
    }
    if (input.to === "resolved") {
      const verified = await client.query(
        "SELECT 1 FROM improvement_evidence WHERE case_id = $1 AND kind = 'deployment_verification' AND disposition = 'supports' LIMIT 1",
        [input.caseId],
      );
      if (!verified.rowCount) throw new Error("A verifying improvement case requires successful deployment evidence before resolution.");
    }
    const updated = await client.query(
      `UPDATE improvement_cases SET status = $2, classification = coalesce($3, classification), severity = coalesce($4, severity),
         owning_domain = coalesce($5, owning_domain), resolution = $6,
         resolved_at = CASE WHEN $2 IN ('resolved','dismissed') THEN now() ELSE NULL END,
         version = version + 1, updated_at = now() WHERE case_id = $1 RETURNING *`,
      [input.caseId, input.to, input.classification ?? null, input.severity ?? null, input.owningDomain ?? null, input.resolution ?? null],
    );
    await insertCaseEvent(client, { caseId: input.caseId, eventName: `case.${input.to}`, actorKind: input.actorKind, actorId: input.actorId, summary: input.resolution ?? `${current.status} -> ${input.to}` });
    await client.query("COMMIT");
    return rowToImprovementCase(updated.rows[0]);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function addImprovementEvidence(pool: DbPool, input: {
  caseId: string; signalId?: string | null; kind: string; disposition: "supports" | "contradicts" | "inconclusive";
  summary: string; referenceType?: string | null; referenceId?: string | null; collectedByExecutionId?: string | null;
  privacy?: ImprovementPrivacy; metadata?: Record<string, unknown>; actorId?: string | null;
}) {
  const evidenceId = `evi-${randomUUID()}`;
  const result = await pool.query(
    `INSERT INTO improvement_evidence(evidence_id,case_id,signal_id,kind,disposition,summary,reference_type,reference_id,collected_by_execution_id,privacy,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [evidenceId, input.caseId, input.signalId ?? null, required(input.kind, "kind", 100), input.disposition, required(input.summary, "summary", 4_000),
      input.referenceType ?? null, input.referenceId ?? null, input.collectedByExecutionId ?? null, input.privacy ?? "private", JSON.stringify(input.metadata ?? {})],
  );
  await recordImprovementCaseEvent(pool, { caseId: input.caseId, signalId: input.signalId, eventName: "evidence.attached", actorKind: "automation", actorId: input.actorId, summary: input.summary, metadata: { evidenceId, disposition: input.disposition } });
  return rowToEvidence(result.rows[0]);
}

export async function acceptImprovementContract(pool: DbPool, input: {
  caseId: string; expectedBehavior: string; checks: ImprovementContractCheck[]; sourceRevision?: string | null; createdBy: string;
}) {
  assertImprovementChecks(input.checks);
  const executable = improvementChecksExecutable(input.checks);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const caseResult = await client.query("SELECT status FROM improvement_cases WHERE case_id = $1 FOR UPDATE", [input.caseId]);
    if (!caseResult.rows[0]) throw new Error(`Improvement case ${input.caseId} was not found.`);
    if (["actionable", "in_progress", "verifying"].includes(String(caseResult.rows[0].status)) && !executable) {
      throw new Error("An actionable, in-progress, or verifying case must retain an executable contract.");
    }
    const versionResult = await client.query("SELECT coalesce(max(version),0)::int + 1 AS version FROM improvement_contracts WHERE case_id = $1", [input.caseId]);
    const version = Number(versionResult.rows[0]?.version ?? 1);
    await client.query("UPDATE improvement_contracts SET active = false WHERE case_id = $1 AND active = true", [input.caseId]);
    const result = await client.query(
      `INSERT INTO improvement_contracts(contract_id,case_id,version,expected_behavior,checks,executable,source_revision,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [`con-${randomUUID()}`, input.caseId, version, required(input.expectedBehavior, "expectedBehavior", 4_000), JSON.stringify(input.checks), executable, input.sourceRevision ?? null, input.createdBy],
    );
    await insertCaseEvent(client, { caseId: input.caseId, eventName: "contract.accepted", actorKind: input.createdBy === "automation" ? "automation" : "operator", actorId: input.createdBy, summary: input.expectedBehavior, metadata: { version, executable } });
    await client.query("COMMIT");
    return rowToContract(result.rows[0]);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function mergeImprovementCases(pool: DbPool, input: { sourceCaseId: string; targetCaseId: string; actorId: string }) {
  if (input.sourceCaseId === input.targetCaseId) throw new Error("A case cannot be merged into itself.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query("SELECT * FROM improvement_cases WHERE case_id = ANY($1::text[]) ORDER BY case_id FOR UPDATE", [[input.sourceCaseId, input.targetCaseId]]);
    if (rows.rowCount !== 2) throw new Error("Both improvement cases must exist before merging.");
    const cases = rows.rows.map(rowToImprovementCase);
    if (cases[0]?.guildId !== cases[1]?.guildId || cases[0]?.privacy !== cases[1]?.privacy) {
      throw new Error("Improvement cases can only merge within the same guild and privacy boundary.");
    }
    await client.query("UPDATE improvement_signals SET case_id = $2, updated_at = now() WHERE case_id = $1", [input.sourceCaseId, input.targetCaseId]);
    await client.query("UPDATE improvement_evidence SET case_id = $2 WHERE case_id = $1", [input.sourceCaseId, input.targetCaseId]);
    await client.query("UPDATE improvement_contracts SET active = false WHERE case_id = $1", [input.sourceCaseId]);
    await client.query("UPDATE improvement_cases SET status = 'dismissed', merged_into_case_id = $2, resolution = $3, resolved_at = now(), version = version + 1, updated_at = now() WHERE case_id = $1", [input.sourceCaseId, input.targetCaseId, `Merged into ${input.targetCaseId}.`]);
    await client.query("UPDATE improvement_cases SET first_seen_at = least(first_seen_at, (SELECT first_seen_at FROM improvement_cases WHERE case_id = $1)), last_seen_at = greatest(last_seen_at, (SELECT last_seen_at FROM improvement_cases WHERE case_id = $1)), version = version + 1, updated_at = now() WHERE case_id = $2", [input.sourceCaseId, input.targetCaseId]);
    await insertCaseEvent(client, { caseId: input.sourceCaseId, eventName: "case.merged", actorKind: "operator", actorId: input.actorId, metadata: { targetCaseId: input.targetCaseId } });
    await insertCaseEvent(client, { caseId: input.targetCaseId, eventName: "case.coalesced", actorKind: "operator", actorId: input.actorId, metadata: { sourceCaseId: input.sourceCaseId } });
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function recordImprovementCaseEvent(pool: DbPool, input: Parameters<typeof insertCaseEvent>[1]) {
  await insertCaseEvent(pool, input);
}

export async function completeImprovementWorkForTask(pool: DbPool, input: {
  taskId: string;
  succeeded: boolean;
  prUrl?: string | null;
  summary?: string | null;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT case_row.* FROM improvement_cases case_row
       JOIN agent_tasks task ON task.improvement_case_id = case_row.case_id
       WHERE task.task_id = $1 FOR UPDATE`,
      [input.taskId],
    );
    if (!result.rows[0]) { await client.query("COMMIT"); return undefined; }
    const current = rowToImprovementCase(result.rows[0]);
    const target: ImprovementCaseStatus = input.succeeded ? "verifying" : "actionable";
    if (current.status !== "in_progress") { await client.query("COMMIT"); return current; }
    const updated = await client.query(
      `UPDATE improvement_cases SET status = $2, version = version + 1, updated_at = now()
       WHERE case_id = $1 RETURNING *`,
      [current.caseId, target],
    );
    await insertCaseEvent(client, {
      caseId: current.caseId,
      eventName: input.succeeded ? "work.completed" : "work.failed",
      actorKind: "automation",
      summary: input.summary ?? (input.succeeded ? "Linked code work completed; deployment verification is required." : "Linked code work did not complete."),
      metadata: { taskId: input.taskId, prUrl: input.prUrl ?? null },
    });
    await client.query("COMMIT");
    return rowToImprovementCase(updated.rows[0]);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function linkImprovementCaseTask(pool: DbPool, input: { caseId: string; taskId: string; actorId: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const caseResult = await client.query("SELECT * FROM improvement_cases WHERE case_id = $1 FOR UPDATE", [input.caseId]);
    if (!caseResult.rows[0]) throw new Error(`Improvement case ${input.caseId} was not found.`);
    const improvement = rowToImprovementCase(caseResult.rows[0]);
    if (improvement.status !== "actionable") throw new Error("Only an actionable improvement case can start work.");
    const taskResult = await client.query("SELECT status, improvement_case_id FROM agent_tasks WHERE task_id = $1 FOR UPDATE", [input.taskId]);
    if (!taskResult.rows[0]) throw new Error(`Agent task ${input.taskId} was not found.`);
    if (!["queued", "running"].includes(String(taskResult.rows[0].status))) throw new Error("Only queued or running work can be linked to an improvement case.");
    if (taskResult.rows[0].improvement_case_id && taskResult.rows[0].improvement_case_id !== input.caseId) throw new Error("The agent task is already linked to another improvement case.");
    await client.query("UPDATE agent_tasks SET improvement_case_id = $2, updated_at = now() WHERE task_id = $1", [input.taskId, input.caseId]);
    const updated = await client.query("UPDATE improvement_cases SET status = 'in_progress', version = version + 1, updated_at = now() WHERE case_id = $1 RETURNING *", [input.caseId]);
    await insertCaseEvent(client, { caseId: input.caseId, eventName: "work.started", actorKind: "operator", actorId: input.actorId, metadata: { taskId: input.taskId } });
    await client.query("COMMIT");
    return rowToImprovementCase(updated.rows[0]);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function verifyImprovementCase(pool: DbPool, input: {
  caseId: string; revision: string; summary: string; actorId: string; privacy?: ImprovementPrivacy;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const caseResult = await client.query("SELECT * FROM improvement_cases WHERE case_id = $1 FOR UPDATE", [input.caseId]);
    if (!caseResult.rows[0]) throw new Error(`Improvement case ${input.caseId} was not found.`);
    const current = rowToImprovementCase(caseResult.rows[0]);
    if (current.status !== "verifying") throw new Error("Only a verifying improvement case can be resolved by deployed evidence.");
    const contract = await client.query("SELECT 1 FROM improvement_contracts WHERE case_id = $1 AND active = true AND executable = true", [input.caseId]);
    if (!contract.rowCount) throw new Error("Deployment verification requires an active executable contract.");
    const revision = required(input.revision, "revision", 200);
    const summary = required(input.summary, "summary", 4_000);
    const evidenceId = `evi-${randomUUID()}`;
    await client.query(
      `INSERT INTO improvement_evidence(evidence_id,case_id,kind,disposition,summary,reference_type,reference_id,privacy,metadata)
       VALUES ($1,$2,'deployment_verification','supports',$3,'deployment_revision',$4,$5,$6)`,
      [evidenceId, input.caseId, summary, revision, input.privacy ?? "private", JSON.stringify({ revision })],
    );
    const updated = await client.query(
      `UPDATE improvement_cases SET status = 'resolved', resolution = $2, resolved_at = now(), version = version + 1, updated_at = now()
       WHERE case_id = $1 RETURNING *`,
      [input.caseId, `Verified on deployment ${revision}.`],
    );
    await insertCaseEvent(client, { caseId: input.caseId, eventName: "case.resolved", actorKind: "operator", actorId: input.actorId, summary, metadata: { revision, evidenceId } });
    await client.query("COMMIT");
    return rowToImprovementCase(updated.rows[0]);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function clearImprovementDataForUser(pool: DbPool, userId: string) {
  await pool.query(
    `DELETE FROM improvement_evidence evidence
     WHERE evidence.signal_id IN (SELECT signal_id FROM improvement_signals WHERE reporter_id = $1)
        OR evidence.collected_by_execution_id IN (
          SELECT execution.execution_id FROM agent_runtime_executions execution
          JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
          WHERE session.user_id = $1 OR session.requested_by = $1
        )`,
    [userId],
  );
  const result = await pool.query("DELETE FROM improvement_signals WHERE reporter_id = $1 RETURNING case_id", [userId]);
  const caseIds = [...new Set(result.rows.map((row) => String(row.case_id)))];
  for (const caseId of caseIds) {
    await pool.query(
      `DELETE FROM improvement_cases case_row WHERE case_id = $1
       AND NOT EXISTS (SELECT 1 FROM improvement_signals signal WHERE signal.case_id = case_row.case_id)
       AND NOT EXISTS (SELECT 1 FROM improvement_evidence evidence WHERE evidence.case_id = case_row.case_id)`,
      [caseId],
    );
  }
  await pool.query("UPDATE improvement_case_events SET actor_id = NULL WHERE actor_id = $1", [userId]);
  return result.rowCount ?? 0;
}

async function insertCaseEvent(client: Pick<DbPool, "query">, input: {
  caseId: string; signalId?: string | null; eventName: string; actorKind: "member" | "agent" | "operator" | "developer" | "automation" | "system";
  actorId?: string | null; summary?: string | null; metadata?: Record<string, unknown>;
}) {
  await client.query(
    `INSERT INTO improvement_case_events(case_id,signal_id,event_name,actor_kind,actor_id,summary,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.caseId, input.signalId ?? null, input.eventName, input.actorKind, input.actorId ?? null, input.summary?.slice(0, 1_000) ?? null, JSON.stringify(input.metadata ?? {})],
  );
}

function rowToImprovementCase(row: Record<string, unknown>): ImprovementCase {
  return {
    caseId: String(row.case_id), guildId: nullable(row.guild_id), scope: String(row.scope) as ImprovementCase["scope"],
    privacy: String(row.privacy) as ImprovementPrivacy, title: String(row.title), status: String(row.status) as ImprovementCaseStatus,
    classification: String(row.classification) as ImprovementClassification, severity: String(row.severity) as ImprovementSeverity,
    owningDomain: nullable(row.owning_domain), fingerprint: nullable(row.fingerprint), mergedIntoCaseId: nullable(row.merged_into_case_id),
    resolution: nullable(row.resolution), version: Number(row.version), metadata: object(row.metadata), firstSeenAt: date(row.first_seen_at),
    lastSeenAt: date(row.last_seen_at), resolvedAt: nullableDate(row.resolved_at), createdAt: date(row.created_at), updatedAt: date(row.updated_at),
  };
}

function rowToImprovementCaseProjection(row: Record<string, unknown>): ImprovementCase {
  return {
    caseId: String(row.case_id), guildId: nullable(row.guild_id), scope: "guild", privacy: String(row.privacy) as ImprovementPrivacy,
    title: String(row.case_title), status: String(row.case_status) as ImprovementCaseStatus,
    classification: String(row.case_classification) as ImprovementClassification, severity: String(row.case_severity) as ImprovementSeverity,
    owningDomain: nullable(row.owning_domain_hint), fingerprint: nullable(row.fingerprint), mergedIntoCaseId: null, resolution: null,
    version: 0, metadata: {}, firstSeenAt: date(row.observed_at), lastSeenAt: date(row.observed_at), resolvedAt: null,
    createdAt: date(row.created_at), updatedAt: date(row.case_updated_at),
  };
}

function rowToImprovementSignal(row: Record<string, unknown>): ImprovementSignal {
  return {
    signalId: String(row.signal_id), caseId: String(row.case_id), source: String(row.source) as ImprovementSignalSource,
    sourceKey: String(row.source_key), reporterKind: String(row.reporter_kind) as ImprovementSignal["reporterKind"], reporterId: nullable(row.reporter_id),
    guildId: nullable(row.guild_id), channelId: nullable(row.channel_id), messageId: nullable(row.message_id), executionId: nullable(row.execution_id),
    taskId: nullable(row.task_id), appRevision: nullable(row.app_revision), privacy: String(row.privacy) as ImprovementPrivacy, summary: String(row.summary),
    details: nullable(row.details), severityHint: row.severity_hint == null ? null : String(row.severity_hint) as ImprovementSeverity,
    classificationHint: row.classification_hint == null ? null : String(row.classification_hint) as ImprovementClassification,
    owningDomainHint: nullable(row.owning_domain_hint), fingerprint: nullable(row.fingerprint), active: Boolean(row.active), metadata: object(row.metadata),
    observedAt: date(row.observed_at), withdrawnAt: nullableDate(row.withdrawn_at), createdAt: date(row.created_at), updatedAt: date(row.updated_at),
  };
}

function rowToEvidence(row: Record<string, unknown>) { return { evidenceId: String(row.evidence_id), caseId: String(row.case_id), signalId: nullable(row.signal_id), kind: String(row.kind), disposition: String(row.disposition), summary: String(row.summary), referenceType: nullable(row.reference_type), referenceId: nullable(row.reference_id), collectedByExecutionId: nullable(row.collected_by_execution_id), privacy: String(row.privacy), metadata: object(row.metadata), createdAt: date(row.created_at) }; }
function rowToContract(row: Record<string, unknown>) { return { contractId: String(row.contract_id), caseId: String(row.case_id), version: Number(row.version), expectedBehavior: String(row.expected_behavior), checks: Array.isArray(row.checks) ? row.checks as ImprovementContractCheck[] : [], executable: Boolean(row.executable), sourceRevision: nullable(row.source_revision), createdBy: String(row.created_by), active: Boolean(row.active), createdAt: date(row.created_at) }; }
function rowToEvent(row: Record<string, unknown>) { return { eventId: Number(row.event_id), caseId: String(row.case_id), signalId: nullable(row.signal_id), eventName: String(row.event_name), actorKind: String(row.actor_kind), actorId: nullable(row.actor_id), summary: nullable(row.summary), metadata: object(row.metadata), createdAt: date(row.created_at) }; }

function required(value: string, label: string, max: number) { const normalized = value.trim().slice(0, max); if (!normalized) throw new Error(`${label} is required.`); return normalized; }
function boundedLimit(value?: number, max = 50) { return Math.max(1, Math.min(max, Math.trunc(value ?? 20))); }
function nullable(value: unknown) { return value == null ? null : String(value); }
function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function date(value: unknown) { return value instanceof Date ? value : new Date(String(value)); }
function nullableDate(value: unknown) { return value == null ? null : date(value); }
