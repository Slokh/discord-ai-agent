import type { DbPool } from "./pool.js";

/**
 * The improvement loop and reminders were removed, but their tables still hold
 * member data. Privacy deletion keeps clearing them until a migration drops
 * the tables.
 */
export async function clearRetiredFeatureDataForUser(pool: DbPool, userId: string): Promise<void> {
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
  await pool.query(
    `UPDATE improvement_reporter_conversations conversation SET
       clarification_answer = NULL,
       answer_signal_id = NULL,
       answered_at = NULL,
       updated_at = now()
     WHERE conversation.answer_signal_id IN (
       SELECT signal_id FROM improvement_signals WHERE reporter_id = $1
     )`,
    [userId],
  );
  const result = await pool.query("DELETE FROM improvement_signals WHERE reporter_id = $1 RETURNING case_id", [userId]);
  await pool.query(
    `DELETE FROM improvement_reporter_conversations conversation
     WHERE NOT EXISTS (
       SELECT 1 FROM improvement_reporter_conversation_signals mapping
       WHERE mapping.conversation_id = conversation.conversation_id
     )`,
  );
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
  await pool.query("DELETE FROM scheduled_reminders WHERE requester_id = $1", [userId]);
}
