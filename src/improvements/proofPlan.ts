import type { DbPool } from "../db/pool.js";
import type { ImprovementContractCheck } from "../db/types.js";
import { assertActionableContract } from "./policy.js";
import { improvementProofAdapterForCheck, PRIVATE_REPLAY_MUTATING_TOOL_NAMES } from "./proofAdapters.js";

export async function assertImprovementProofInputs(
  database: Pick<DbPool, "query">,
  caseId: string,
  checks: readonly ImprovementContractCheck[],
) {
  if (!checks.some((check) => improvementProofAdapterForCheck(check)?.id === "private_replay")) return;
  const replay = await database.query(
    `SELECT 1
     FROM improvement_signals signal
     JOIN agent_runtime_executions execution ON execution.execution_id = signal.execution_id
     JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
     JOIN LATERAL (
       SELECT string_agg(chunk.content, '' ORDER BY chunk.chunk_index)::jsonb AS envelope
       FROM agent_runtime_artifacts artifact
       JOIN agent_runtime_artifact_chunks chunk USING (artifact_id)
       WHERE artifact.execution_id = execution.execution_id AND artifact.kind = 'turn_envelope'
       GROUP BY artifact.artifact_id, artifact.created_at
       ORDER BY artifact.created_at DESC LIMIT 1
     ) turn ON true
     WHERE signal.case_id = $1 AND signal.active = true
       AND signal.guild_id IS NOT NULL AND signal.channel_id IS NOT NULL AND signal.reporter_id IS NOT NULL
       AND coalesce(nullif(turn.envelope->>'text', ''), nullif(session.request, '')) IS NOT NULL
       AND jsonb_typeof(turn.envelope->'visibleChannelIds') = 'array'
       AND jsonb_array_length(turn.envelope->'visibleChannelIds') > 0
       AND NOT EXISTS (
         SELECT 1 FROM agent_runtime_events event
         WHERE event.execution_id = execution.execution_id
           AND event.metadata->>'toolName' = ANY($2::text[])
       )
     LIMIT 1`,
    [caseId, PRIVATE_REPLAY_MUTATING_TOOL_NAMES],
  );
  if (!replay.rowCount) {
    throw new Error("Private-replay checks require safe retained input: requester, channel, prompt, visible-channel scope, and no mutating tool use.");
  }
}

export async function assertImprovementProofPlan(database: Pick<DbPool, "query">, caseId: string) {
  const contract = await database.query(
    "SELECT checks FROM improvement_contracts WHERE case_id = $1 AND active = true",
    [caseId],
  );
  const checks = (contract.rows[0]?.checks ?? []) as ImprovementContractCheck[];
  assertActionableContract(checks);
  await assertImprovementProofInputs(database, caseId, checks);
}
