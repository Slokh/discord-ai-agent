import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config/env.js";
import { createApplicationServices } from "../src/runtime/applicationServices.js";
import { loadAgentRuntimeTurnEnvelope } from "../src/agent/runtimeEnvelope.js";
import { hasFaithfulPrivateReplayContext } from "../src/agent/turnReplay.js";
import { REPLAY_RUBRIC } from "./evalJudge.js";

/**
 * Exports recent production turns as private replay cases. Each case replays
 * the turn's retained envelope (same requester, channel, visible channels and
 * reply chain) under the current prompt and tools, and is graded against the
 * reply that was actually delivered. Cases contain member content, so they are
 * written only under the git-ignored .discord-ai-agent/evals directory.
 *
 * Usage: npm run eval:export-replays -- [--days 7] [--limit 50] [--out .discord-ai-agent/evals/replay.json]
 */
const PRIVATE_EVAL_DIR = ".discord-ai-agent/evals";

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const services = createApplicationServices({ config, enableWalletRuntime: false });
try {
  const rows = await services.pool.query(
    `SELECT execution.execution_id, execution.updated_at
     FROM agent_runtime_executions execution
     JOIN agent_runtime_sessions session USING (session_id)
     WHERE execution.status = 'succeeded'
       AND execution.task_id IS NULL
       AND session.metadata->>'kind' = 'discord_channel'
       AND coalesce(execution.metadata->>'source', '') <> 'cli.prompt'
       AND coalesce(execution.metadata->>'steeredIntoRequestId', '') = ''
       AND execution.updated_at >= now() - make_interval(days => $1)
     ORDER BY execution.updated_at DESC
     LIMIT $2`,
    [args.days, args.limit * 3],
  );
  const cases = [];
  for (const row of rows.rows) {
    if (cases.length >= args.limit) break;
    const executionId = String(row.execution_id);
    const envelopeArtifact = await services.agentRuntime.getLatestArtifactContentForExecution({ executionId, kind: "turn_envelope" });
    if (!envelopeArtifact?.artifactId) continue;
    const envelope = await loadAgentRuntimeTurnEnvelope({ agentRuntime: services.agentRuntime, artifactId: envelopeArtifact.artifactId })
      .catch(() => null);
    if (!envelope || !hasFaithfulPrivateReplayContext(envelope)) continue;
    const reference = await services.agentRuntime.getLatestArtifactContentForExecution({ executionId, kind: "response" });
    if (!reference?.content?.trim()) continue;
    cases.push({
      id: `replay-${executionId}`,
      category: "replay",
      prompt: envelope.text,
      promptArgs: [
        "--guild-id", envelope.guildId,
        "--channel-id", envelope.channelId,
        "--user-id", envelope.userId,
        "--user-name", envelope.userDisplayName,
        "--visible-channel-ids", envelope.visibleChannelIds.join(","),
        "--replay-turn-envelope-artifact", envelopeArtifact.artifactId,
        "--read-only",
      ],
      noMemory: true,
      rubric: REPLAY_RUBRIC,
      referenceAnswer: reference.content,
    });
  }
  const out = args.out ?? path.join(PRIVATE_EVAL_DIR, `replay-${new Date().toISOString().slice(0, 10)}.json`);
  if (!path.resolve(out).startsWith(path.resolve(PRIVATE_EVAL_DIR))) {
    throw new Error(`Replay cases hold member content and must be written under ${PRIVATE_EVAL_DIR}.`);
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify({ version: 1, name: "production-replay", prompts: cases }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ exported: cases.length, considered: rows.rowCount, out })}\n`);
} finally {
  await services.close();
}

function parseArgs(argv: string[]) {
  const parsed: { days: number; limit: number; out?: string } = { days: 7, limit: 50 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--days" && value) { parsed.days = positive(value, arg); index += 1; }
    else if (arg === "--limit" && value) { parsed.limit = positive(value, arg); index += 1; }
    else if (arg === "--out" && value) { parsed.out = value; index += 1; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function positive(value: string, option: string) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${option} must be a positive integer.`);
  return number;
}
