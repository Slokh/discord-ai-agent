import { randomUUID } from "node:crypto";
import { assertImprovementProofPlan } from "../improvements/proofPlan.js";
import type { DbPool } from "./pool.js";
import type {
  ImprovementCase,
  ImprovementCaseStatus,
  ImprovementPullRequestSnapshot,
  ImprovementWorkStatus,
} from "./types.js";
import { rowToImprovementWorkAttempt } from "./improvementWorkRows.js";

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
      `SELECT case_row.*, work.work_id, work.status AS work_status
       FROM improvement_work_attempts work
       JOIN improvement_cases case_row ON case_row.case_id = work.case_id
       WHERE work.task_id = $1
       FOR UPDATE OF case_row, work`,
      [input.taskId],
    );
    if (!result.rows[0]) { await client.query("COMMIT"); return undefined; }
    const current = rowToImprovementCase(result.rows[0]);
    const target: ImprovementCaseStatus = input.succeeded ? "verifying" : "actionable";
    if (String(result.rows[0].work_status) !== "in_progress") { await client.query("COMMIT"); return current; }
    if (input.succeeded) await assertImprovementProofPlan(client, current.caseId);
    await client.query(
      `UPDATE improvement_work_attempts SET status = $2, pull_request_url = coalesce($3, pull_request_url),
         completed_at = now(), updated_at = now() WHERE work_id = $1`,
      [String(result.rows[0].work_id), input.succeeded ? "succeeded" : "failed", input.prUrl ?? null],
    );
    const updated = current.status === "in_progress"
      ? await client.query(
          `UPDATE improvement_cases SET status = $2, version = version + 1, updated_at = now()
           WHERE case_id = $1 RETURNING *`,
          [current.caseId, target],
        )
      : { rows: [result.rows[0]] };
    await insertCaseEvent(client, {
      caseId: current.caseId,
      eventName: input.succeeded ? "work.completed" : "work.failed",
      actorKind: "automation",
      summary: input.summary ?? (input.succeeded ? "Linked code work completed; deployment verification is required." : "Linked code work did not complete."),
      metadata: { workId: String(result.rows[0].work_id), source: "agent_task", taskId: input.taskId, prUrl: input.prUrl ?? null },
    });
    await client.query("COMMIT");
    return rowToImprovementCase(updated.rows[0]);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function linkImprovementCaseTask(pool: DbPool, input: {
  caseId: string;
  taskId: string;
  actorId: string;
  actorKind?: "operator" | "automation" | "system";
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const caseResult = await client.query("SELECT * FROM improvement_cases WHERE case_id = $1 FOR UPDATE", [input.caseId]);
    if (!caseResult.rows[0]) throw new Error(`Improvement case ${input.caseId} was not found.`);
    const improvement = rowToImprovementCase(caseResult.rows[0]);
    if (!(["actionable", "in_progress"] as ImprovementCaseStatus[]).includes(improvement.status)) throw new Error("Only an actionable improvement case can start work.");
    await assertImprovementProofPlan(client, input.caseId);
    const taskResult = await client.query("SELECT status, improvement_case_id FROM agent_tasks WHERE task_id = $1 FOR UPDATE", [input.taskId]);
    if (!taskResult.rows[0]) throw new Error(`Agent task ${input.taskId} was not found.`);
    if (!["queued", "running"].includes(String(taskResult.rows[0].status))) throw new Error("Only queued or running work can be linked to an improvement case.");
    if (taskResult.rows[0].improvement_case_id && taskResult.rows[0].improvement_case_id !== input.caseId) throw new Error("The agent task is already linked to another improvement case.");
    const sourceKey = `agent_task:${input.taskId}`;
    const existing = await client.query("SELECT * FROM improvement_work_attempts WHERE source_key = $1 FOR UPDATE", [sourceKey]);
    if (existing.rows[0] && String(existing.rows[0].case_id) !== input.caseId) throw new Error("The agent task is already linked to another improvement case.");
    await client.query("UPDATE agent_tasks SET improvement_case_id = $2, updated_at = now() WHERE task_id = $1", [input.taskId, input.caseId]);
    if (!existing.rows[0]) {
      const workId = `wrk-${randomUUID()}`;
      await client.query(
        `INSERT INTO improvement_work_attempts(work_id,case_id,source,source_key,status,task_id)
         VALUES ($1,$2,'agent_task',$3,'in_progress',$4)`,
        [workId, input.caseId, sourceKey, input.taskId],
      );
      await insertCaseEvent(client, { caseId: input.caseId, eventName: "work.started", actorKind: input.actorKind ?? "operator", actorId: input.actorId, metadata: { workId, source: "agent_task", taskId: input.taskId } });
    }
    const updated = improvement.status === "actionable"
      ? await client.query("UPDATE improvement_cases SET status = 'in_progress', version = version + 1, updated_at = now() WHERE case_id = $1 RETURNING *", [input.caseId])
      : { rows: [caseResult.rows[0]] };
    await client.query("COMMIT");
    return rowToImprovementCase(updated.rows[0]);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function linkImprovementCasePullRequest(pool: DbPool, input: {
  caseId: string;
  pullRequest: ImprovementPullRequestSnapshot;
  actorId: string;
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const repository = normalizeRepository(input.pullRequest.repository);
    const sourceKey = `github_pr:${repository}#${input.pullRequest.pullRequestNumber}`;
    const caseResult = await client.query("SELECT * FROM improvement_cases WHERE case_id = $1 FOR UPDATE", [input.caseId]);
    if (!caseResult.rows[0]) throw new Error(`Improvement case ${input.caseId} was not found.`);
    const existingResult = await client.query("SELECT * FROM improvement_work_attempts WHERE source_key = $1 FOR UPDATE", [sourceKey]);
    const existing = existingResult.rows[0];
    if (existing && String(existing.case_id) !== input.caseId) throw new Error("The pull request is already linked to another improvement case.");
    const current = rowToImprovementCase(caseResult.rows[0]);
    if (!existing && current.status !== "actionable") throw new Error("Only an actionable improvement case can start work.");
    if ((["resolved", "dismissed"] as ImprovementCaseStatus[]).includes(current.status)) {
      await client.query("COMMIT");
      return { case: current, work: rowToImprovementWorkAttempt(existing as Record<string, unknown>) };
    }
    if (existing && String(existing.status) === "succeeded") {
      await client.query("COMMIT");
      return { case: current, work: rowToImprovementWorkAttempt(existing) };
    }
    await assertImprovementProofPlan(client, input.caseId);
    const workStatus = pullRequestWorkStatus(input.pullRequest.state);
    const workId = existing ? String(existing.work_id) : `wrk-${randomUUID()}`;
    const priorStatus = existing ? String(existing.status) as ImprovementWorkStatus : null;
    const workResult = existing
      ? await client.query(
          `UPDATE improvement_work_attempts SET status = $2, pull_request_url = $3, head_revision = $4,
             merge_revision = $5, completed_at = CASE WHEN $2 = 'in_progress' THEN NULL ELSE now() END,
             updated_at = now() WHERE work_id = $1 RETURNING *`,
          [workId, workStatus, input.pullRequest.pullRequestUrl, input.pullRequest.headRevision, input.pullRequest.mergeRevision ?? null],
        )
      : await client.query(
          `INSERT INTO improvement_work_attempts(
             work_id,case_id,source,source_key,status,repository,pull_request_number,pull_request_url,
             head_revision,merge_revision,completed_at
           ) VALUES ($1,$2,'github_pull_request',$3,$4,$5,$6,$7,$8,$9,CASE WHEN $4 = 'in_progress' THEN NULL ELSE now() END)
           RETURNING *`,
          [workId, input.caseId, sourceKey, workStatus, repository, input.pullRequest.pullRequestNumber,
            input.pullRequest.pullRequestUrl, input.pullRequest.headRevision, input.pullRequest.mergeRevision ?? null],
        );
    const targetStatus = pullRequestCaseStatus(input.pullRequest.state);
    const updated = current.status === targetStatus
      ? { rows: [caseResult.rows[0]] }
      : await client.query(
          `UPDATE improvement_cases SET status = $2, version = version + 1, updated_at = now()
           WHERE case_id = $1 RETURNING *`,
          [input.caseId, targetStatus],
        );
    if (!existing) {
      await insertCaseEvent(client, {
        caseId: input.caseId, eventName: "work.started", actorKind: "operator", actorId: input.actorId,
        metadata: { workId, source: "github_pull_request", repository, pullRequestNumber: input.pullRequest.pullRequestNumber, pullRequestUrl: input.pullRequest.pullRequestUrl },
      });
    }
    if (priorStatus !== workStatus && workStatus !== "in_progress") {
      await insertCaseEvent(client, {
        caseId: input.caseId,
        eventName: workStatus === "succeeded" ? "work.completed" : "work.failed",
        actorKind: "automation",
        summary: workStatus === "succeeded" ? "Linked pull request merged; deployment verification is required." : "Linked pull request closed without merging.",
        metadata: { workId, source: "github_pull_request", repository, pullRequestNumber: input.pullRequest.pullRequestNumber, pullRequestUrl: input.pullRequest.pullRequestUrl, mergeRevision: input.pullRequest.mergeRevision ?? null },
      });
    }
    await client.query("COMMIT");
    return { case: rowToImprovementCase(updated.rows[0]), work: rowToImprovementWorkAttempt(workResult.rows[0]) };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function listActiveImprovementPullRequestWork(pool: DbPool) {
  const result = await pool.query(
    `SELECT * FROM improvement_work_attempts
     WHERE source = 'github_pull_request' AND status = 'in_progress'
     ORDER BY updated_at ASC`,
  );
  return result.rows.map(rowToImprovementWorkAttempt);
}

function rowToImprovementCase(row: Record<string, unknown>): ImprovementCase {
  return {
    caseId: String(row.case_id), guildId: nullable(row.guild_id), scope: String(row.scope) as ImprovementCase["scope"],
    privacy: String(row.privacy) as ImprovementCase["privacy"], title: String(row.title), status: String(row.status) as ImprovementCaseStatus,
    classification: String(row.classification) as ImprovementCase["classification"], severity: String(row.severity) as ImprovementCase["severity"],
    owningDomain: nullable(row.owning_domain), fingerprint: nullable(row.fingerprint), mergedIntoCaseId: nullable(row.merged_into_case_id),
    resolution: nullable(row.resolution), version: Number(row.version), metadata: object(row.metadata), firstSeenAt: date(row.first_seen_at),
    lastSeenAt: date(row.last_seen_at), resolvedAt: nullableDate(row.resolved_at), createdAt: date(row.created_at), updatedAt: date(row.updated_at),
  };
}

async function insertCaseEvent(client: Pick<DbPool, "query">, input: {
  caseId: string;
  eventName: string;
  actorKind: "operator" | "automation" | "system";
  actorId?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await client.query(
    `INSERT INTO improvement_case_events(case_id,event_name,actor_kind,actor_id,summary,metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.caseId, input.eventName, input.actorKind, input.actorId ?? null, input.summary?.slice(0, 1_000) ?? null, JSON.stringify(input.metadata ?? {})],
  );
}

function normalizeRepository(value: string) { const normalized = value.trim().toLowerCase(); if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) throw new Error("GitHub repository must be owner/repo."); return normalized; }
function pullRequestWorkStatus(state: ImprovementPullRequestSnapshot["state"]): ImprovementWorkStatus { return state === "open" ? "in_progress" : state === "merged" ? "succeeded" : "failed"; }
function pullRequestCaseStatus(state: ImprovementPullRequestSnapshot["state"]): ImprovementCaseStatus { return state === "open" ? "in_progress" : state === "merged" ? "verifying" : "actionable"; }
function nullable(value: unknown) { return value == null ? null : String(value); }
function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function date(value: unknown) { return value instanceof Date ? value : new Date(String(value)); }
function nullableDate(value: unknown) { return value == null ? null : date(value); }
