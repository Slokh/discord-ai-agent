import { createHash } from "node:crypto";
import type { DbPool } from "../../src/db/pool.js";

export async function cleanupRepositoryTestRows(pool: DbPool) {
  await pool.query("DELETE FROM deployment_verifications WHERE revision LIKE 'test-%'");
  await pool.query("DELETE FROM guild_agent_settings WHERE guild_id LIKE 'guild-%'");
  await pool.query("DELETE FROM discord_component_actions WHERE guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%'");
  await pool.query("DELETE FROM deployment_announcements WHERE guild_id LIKE 'guild-%'");
  await pool.query("DELETE FROM agent_run_feedback WHERE run_id LIKE 'run-%'");
  await pool.query(`DELETE FROM tool_audit_logs WHERE user_id LIKE 'user-%' OR guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%' OR trace_id LIKE 'trace-%'`);
  await pool.query(`DELETE FROM trace_events WHERE user_id LIKE 'user-%' OR guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%' OR trace_id LIKE 'trace-%'`);
  await pool.query("DELETE FROM discord_delivery_obligations WHERE execution_id LIKE 'agent-execution-%' OR guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%'");
  await pool.query("DELETE FROM agent_runtime_artifact_chunks WHERE artifact_id IN (SELECT artifact_id FROM agent_runtime_artifacts WHERE session_id LIKE 'codegen-session-%' OR session_id LIKE 'agent-session-%' OR execution_id LIKE 'codegen-execution-%' OR execution_id LIKE 'agent-task-execution-%')");
  await pool.query("DELETE FROM agent_runtime_artifacts WHERE session_id LIKE 'codegen-session-%' OR session_id LIKE 'agent-session-%' OR execution_id LIKE 'codegen-execution-%' OR execution_id LIKE 'agent-task-execution-%'");
  await pool.query("DELETE FROM agent_runtime_events WHERE session_id LIKE 'codegen-session-%' OR session_id LIKE 'agent-session-%' OR execution_id LIKE 'codegen-execution-%' OR execution_id LIKE 'agent-task-execution-%'");
  await pool.query("DELETE FROM agent_runtime_executions WHERE execution_id LIKE 'codegen-execution-%' OR execution_id LIKE 'agent-task-execution-%' OR session_id LIKE 'codegen-session-%' OR session_id LIKE 'agent-session-%'");
  await pool.query("DELETE FROM agent_runtime_messages WHERE session_id LIKE 'codegen-session-%' OR session_id LIKE 'agent-session-%'");
  await pool.query("DELETE FROM agent_runtime_sessions WHERE session_id LIKE 'codegen-session-%' OR session_id LIKE 'agent-session-%' OR trace_id LIKE 'trace-%'");
  await pool.query("DELETE FROM process_runs WHERE run_id LIKE 'run-%' OR trace_id LIKE 'trace-%' OR guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%'");
  await pool.query("DELETE FROM skill_changes WHERE skill_name LIKE 'skill-%' OR requester_id LIKE 'user-%'");
  await pool.query("DELETE FROM skills WHERE name LIKE 'skill-%'");
  await pool.query("DELETE FROM conversation_snapshots WHERE thread_key LIKE 'discord:guild-%'");
  await pool.query("DELETE FROM conversation_messages WHERE thread_key LIKE 'discord:guild-%'");
  await pool.query("DELETE FROM conversation_sessions WHERE guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%'");
  await pool.query("DELETE FROM crawl_cursors WHERE guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%'");
  await pool.query("DELETE FROM agent_tasks WHERE guild_id LIKE 'guild-%' OR channel_id LIKE 'channel-%' OR task_id LIKE 'task-%'");
  await pool.query("DELETE FROM server_overlays WHERE guild_id LIKE 'guild-%'");
  await pool.query("DELETE FROM interaction_blocks WHERE guild_id LIKE 'guild-%' OR user_id LIKE 'user-%'");
  await pool.query("DELETE FROM user_budget_overrides WHERE guild_id LIKE 'guild-%' OR user_id LIKE 'user-%'");
  await pool.query("DELETE FROM budget_turn_reservations WHERE guild_id LIKE 'guild-%' OR user_id LIKE 'user-%' OR request_id LIKE 'request-%'");
  await pool.query("DELETE FROM discord_user_aliases WHERE guild_id LIKE 'guild-%' OR user_id LIKE 'user-%'");
  await pool.query("DELETE FROM privacy_deletions WHERE user_id LIKE 'user-%'");
  await pool.query("DELETE FROM attachments WHERE message_id LIKE 'message-%'");
  await pool.query("DELETE FROM message_embeddings WHERE message_id LIKE 'message-%'");
  await pool.query("DELETE FROM messages WHERE id LIKE 'message-%' OR guild_id LIKE 'guild-%' OR author_id LIKE 'user-%'");
  await pool.query("DELETE FROM channels WHERE id LIKE 'channel-%' OR id LIKE 'parent-%' OR id LIKE '%thread-%' OR guild_id LIKE 'guild-%'");
  await pool.query("DELETE FROM guilds WHERE id LIKE 'guild-%'");
  await pool.query("DELETE FROM discord_users WHERE id LIKE 'user-%'");
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
