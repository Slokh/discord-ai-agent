import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";

const outputPath = path.resolve(process.argv[2] ?? ".discord-ai-agent/evals/production-feedback.json");
const pool = createPool(loadConfig());
try {
  const result = await pool.query(`
    SELECT f.run_id, f.rating, f.note, f.expected_behavior, f.failure_mode,
           f.expected_tools, f.forbidden_tools, f.must_contain, f.must_not_contain, f.updated_at,
           coalesce(turn.envelope->>'text', s.request) AS request,
           coalesce(turn.envelope->>'guildId', s.guild_id) AS guild_id,
           coalesce(turn.envelope->>'channelId', s.channel_id) AS channel_id,
           coalesce(turn.envelope->>'userId', s.user_id) AS user_id,
           turn.envelope->'visibleChannelIds' AS visible_channel_ids,
           s.metadata->>'appRevision' AS app_revision,
           s.metadata->>'promptVersion' AS prompt_version,
           s.metadata->>'toolVersion' AS tool_version,
           s.metadata->>'configVersion' AS config_version
    FROM agent_run_feedback f
    LEFT JOIN agent_runtime_executions e ON e.execution_id = f.run_id
    LEFT JOIN agent_runtime_sessions s ON s.session_id = e.session_id
    LEFT JOIN LATERAL (
      SELECT string_agg(chunk.content, '' ORDER BY chunk.chunk_index)::jsonb AS envelope
      FROM agent_runtime_artifacts artifact
      JOIN agent_runtime_artifact_chunks chunk USING (artifact_id)
      WHERE artifact.execution_id = e.execution_id AND artifact.kind = 'turn_envelope'
      GROUP BY artifact.artifact_id, artifact.created_at
      ORDER BY artifact.created_at DESC
      LIMIT 1
    ) turn ON true
    WHERE f.capture_eval = true
    ORDER BY f.updated_at ASC
  `);
  const prompts = result.rows.flatMap((row) => {
    const prompt = String(row.request ?? "").trim();
    if (!prompt) return [];
    const expectedTools = stringList(row.expected_tools);
    const forbiddenTools = stringList(row.forbidden_tools);
    const mustContain = stringList(row.must_contain);
    const mustNotContain = stringList(row.must_not_contain);
    const hasAssertion = expectedTools.length + forbiddenTools.length + mustContain.length + mustNotContain.length > 0;
    const visibleChannelIds = jsonStringList(row.visible_channel_ids);
    const hasReplayScope = Boolean(row.guild_id && row.channel_id && row.user_id && visibleChannelIds.length > 0);
    const promptArgs = compactArgs([
      ["--guild-id", row.guild_id],
      ["--channel-id", row.channel_id],
      ["--user-id", row.user_id],
      ["--visible-channel-ids", visibleChannelIds.join(",")],
    ]);
    return [{
      id: `production-${safeId(String(row.run_id))}`,
      category: String(row.failure_mode ?? "production-feedback"),
      prompt,
      notes: privateNotes(row),
      expectedTools,
      forbiddenTools,
      mustContain,
      mustNotContain,
      promptArgs,
      noMemory: true,
      useDiscordMemory: hasReplayScope,
      skip: !hasAssertion || !hasReplayScope,
      ...(!hasAssertion
        ? { skipReason: "Reviewer must add an expected/forbidden tool or answer phrase before this case can grade behavior." }
        : !hasReplayScope
          ? { skipReason: "The original requester's visible-channel scope is unavailable, so this case cannot be replayed faithfully." }
          : {}),
    }];
  });
  const suite = { version: 1, name: "private-production-feedback", prompts };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(suite, null, 2)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  process.stdout.write(`Exported ${prompts.length} private production regression cases to ${outputPath}\n`);
} finally {
  await pool.end();
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function jsonStringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function safeId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "run";
}

function compactArgs(entries: Array<[string, unknown]>) {
  return entries.flatMap(([flag, value]) => typeof value === "string" && value.trim() ? [flag, value] : []);
}

function privateNotes(row: Record<string, unknown>) {
  return [
    row.expected_behavior ? `Expected behavior: ${String(row.expected_behavior)}` : null,
    row.note ? `Reviewer note: ${String(row.note)}` : null,
    `Original rating: ${String(row.rating)}`,
    `Source revisions: app=${String(row.app_revision ?? "unknown")}, prompt=${String(row.prompt_version ?? "unknown")}, tools=${String(row.tool_version ?? "unknown")}, config=${String(row.config_version ?? "unknown")}`,
    `Captured: ${new Date(row.updated_at as string | number | Date).toISOString()}`,
  ].filter(Boolean).join("\n");
}
