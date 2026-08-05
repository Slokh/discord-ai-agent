import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import type { ImprovementContractCheck } from "../src/db/types.js";
import { improvementContractAssertions, improvementContractReplaySkipReason } from "../src/observability/improvementContractReplay.js";

const outputPath = path.resolve(process.argv[2] ?? ".discord-ai-agent/evals/improvement-contracts.json");
const pool = createPool(loadConfig());
try {
  const result = await pool.query(`
    SELECT case_row.case_id, case_row.classification, contract.contract_id, contract.version, contract.expected_behavior, contract.checks,
           contract.source_revision, contract.created_at,
           signal.execution_id, signal.guild_id, signal.channel_id, signal.reporter_id AS user_id,
           coalesce(turn.envelope->>'text', session.request) AS request,
           turn.envelope->'visibleChannelIds' AS visible_channel_ids
    FROM improvement_contracts contract
    JOIN improvement_cases case_row ON case_row.case_id = contract.case_id
    JOIN LATERAL (
      SELECT candidate.* FROM improvement_signals candidate
      WHERE candidate.case_id = case_row.case_id AND candidate.execution_id IS NOT NULL
      ORDER BY candidate.observed_at ASC LIMIT 1
    ) signal ON true
    JOIN agent_runtime_executions execution ON execution.execution_id = signal.execution_id
    JOIN agent_runtime_sessions session ON session.session_id = execution.session_id
    LEFT JOIN LATERAL (
      SELECT string_agg(chunk.content, '' ORDER BY chunk.chunk_index)::jsonb AS envelope
      FROM agent_runtime_artifacts artifact
      JOIN agent_runtime_artifact_chunks chunk USING (artifact_id)
      WHERE artifact.execution_id = execution.execution_id AND artifact.kind = 'turn_envelope'
      GROUP BY artifact.artifact_id, artifact.created_at
      ORDER BY artifact.created_at DESC LIMIT 1
    ) turn ON true
    WHERE contract.active = true AND contract.executable = true
    ORDER BY contract.created_at ASC
  `);
  const prompts = result.rows.flatMap((row) => {
    const prompt = String(row.request ?? "").trim();
    if (!prompt) return [];
    const assertions = improvementContractAssertions((row.checks ?? []) as ImprovementContractCheck[]);
    const visibleChannelIds = stringList(row.visible_channel_ids);
    const hasAssertion = Object.values(assertions).some((values) => values.length > 0);
    const hasReplayScope = Boolean(row.guild_id && row.channel_id && row.user_id && visibleChannelIds.length > 0);
    const skipReason = improvementContractReplaySkipReason({ hasAssertion, hasReplayScope, expectedTools: assertions.expectedTools });
    return [{
      id: `improvement-${safeId(String(row.case_id))}-v${Number(row.version)}`,
      category: String(row.classification),
      sourceRevision: String(row.source_revision ?? "unknown"),
      improvementCaseId: String(row.case_id),
      improvementContractId: String(row.contract_id),
      improvementContractVersion: Number(row.version),
      prompt,
      notes: `Expected behavior: ${String(row.expected_behavior)}\nPrivate improvement case: ${String(row.case_id)}`,
      ...assertions,
      promptArgs: ["--guild-id", String(row.guild_id), "--channel-id", String(row.channel_id), "--user-id", String(row.user_id), "--visible-channel-ids", visibleChannelIds.join(",")],
      noMemory: true,
      useDiscordMemory: hasReplayScope,
      skip: Boolean(skipReason),
      ...(skipReason ? { skipReason } : {}),
    }];
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ version: 1, name: "private-improvement-contracts", prompts }, null, 2)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  process.stdout.write(`Exported ${prompts.length} private improvement contracts to ${outputPath}\n`);
} finally { await pool.end(); }

function stringList(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : []; }
function safeId(value: string) { return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "case"; }
