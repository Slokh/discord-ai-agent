import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createPool } from "../../src/db/pool.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("forward migration upgrades", () => {
  it("replaces legacy report stores with improvement cases without losing runtime events", async () => {
    const pool = createPool(loadConfig());
    const schema = `upgrade_${randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      for (const version of ["001_initial", "002_provable_rng", "003_user_budget_overrides", "004_hnsw_embedding_index", "005_budget_turn_reservations"]) {
        await client.query(await readFile(path.resolve(`migrations/${version}.sql`), "utf8"));
      }
      await client.query("INSERT INTO agent_runtime_sessions(session_id, thread_key, title, request, requested_by) VALUES ('session', 'thread', 'title', 'request', 'tester')");
      await client.query("INSERT INTO agent_runtime_executions(execution_id, session_id) VALUES ('execution', 'session')");
      await client.query("INSERT INTO agent_runtime_events(session_id, execution_id, sequence, kind, event_name) VALUES ('session', 'execution', 1, 'status', 'agent.execution.queued')");
      await client.query(await readFile(path.resolve("migrations/006_runtime_event_spans.sql"), "utf8"));
      await client.query(await readFile(path.resolve("migrations/007_rng_active_channel_index.sql"), "utf8"));
      await client.query(await readFile(path.resolve("migrations/008_wallets_mpp.sql"), "utf8"));
      await client.query(`
        INSERT INTO wallet_transfers(
          id, guild_id, destination_address, purpose, token, token_address,
          token_decimals, amount_atomic, idempotency_key, memo_hex
        ) VALUES (
          'legacy-mpp', 'guild', '0x1111111111111111111111111111111111111111',
          'mpp_payment', 'USDC.e', '0x2222222222222222222222222222222222222222',
          6, 1000, 'legacy-mpp', '0x00'
        )
      `);
      for (const version of ["009_mpp_hardening", "010_managed_wallet_transfers", "011_remove_paid_service_prototype"]) {
        await client.query(await readFile(path.resolve(`migrations/${version}.sql`), "utf8"));
      }
      await client.query("UPDATE agent_runtime_events SET span_id = 'root', parent_span_id = NULL WHERE execution_id = 'execution'");
      const event = await client.query("SELECT span_id, event_name FROM agent_runtime_trace_projection WHERE execution_id = 'execution'");
      expect(event.rows).toEqual([expect.objectContaining({ span_id: "root", event_name: "agent.execution.queued" })]);
      await expect(client.query("SELECT count(*)::int AS count FROM wallet_accounts")).resolves.toEqual(
        expect.objectContaining({ rows: [expect.objectContaining({ count: 0 })] })
      );
      await expect(client.query("SELECT purpose, metadata->>'retiredPrototype' AS retired FROM wallet_transfers WHERE id = 'legacy-mpp'"))
        .resolves.toEqual(expect.objectContaining({
          rows: [expect.objectContaining({ purpose: "reconciliation", retired: "true" })]
        }));
      await expect(client.query("SELECT count(*)::int AS count FROM wallet_initial_grants"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ count: 0 })] }));
      await expect(client.query("SELECT count(*)::int AS count FROM mpp_payment_attempts"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ count: 0 })] }));
      await client.query(`
        INSERT INTO skills(name, file_path, source, content)
        VALUES ('legacy-database-skill', 'database:legacy-database-skill.md', 'database', '# Legacy')
      `);
      await client.query("INSERT INTO agent_run_feedback(run_id, rating, capture_eval) VALUES ('execution', 'good', true)");
      await expect(client.query("SELECT count(*)::int AS count FROM agent_run_feedback")).resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ count: 1 })] }));
      for (const version of [
        "012_starter_grants",
        "013_wager_request_idempotency",
        "014_durable_game_sessions",
        "015_verified_wager_settlement",
        "016_discord_bug_markers",
        "017_deployment_announcements",
        "018_discord_emoji_culture",
        "019_discord_component_actions",
        "020_discord_component_action_generations",
        "021_discord_component_action_expiry_index",
        "022_agent_runtime_binary_artifacts",
        "023_wallet_guild_settings",
        "024_remove_database_skills",
        "025_guild_agent_settings",
      ]) {
        await client.query(await readFile(path.resolve(`migrations/${version}.sql`), "utf8"));
      }
      await client.query(`
        INSERT INTO agent_runtime_artifacts(
          artifact_id, session_id, execution_id, kind, name, content_type,
          size_bytes, preview, redacted, metadata
        ) VALUES (
          'legacy-delivery', 'session', 'execution', 'discord_delivery_intent', 'legacy delivery', 'application/json',
          1, '', false, '{}'::jsonb
        );
        INSERT INTO agent_runtime_artifact_chunks(artifact_id, chunk_index, content)
        VALUES (
          'legacy-delivery', 0,
          '{"schemaVersion":1,"deliveryKey":"request","requesterUserId":"user","content":"done","storedContent":"done","responseRedacted":false,"footer":null,"presentation":null,"files":[{"name":"legacy.txt","contentType":"text/plain","dataBase64":"bGVnYWN5"}],"sourceMessageReaction":null}'
        );
        INSERT INTO agent_runtime_artifacts(
          artifact_id, session_id, execution_id, kind, name, content_type,
          size_bytes, preview, redacted, metadata
        ) VALUES ('legacy-envelope', 'session', 'execution', 'turn_envelope', 'legacy envelope', 'application/json', 1, '', false, '{}'::jsonb);
        INSERT INTO agent_runtime_artifact_chunks(artifact_id, chunk_index, content)
        VALUES ('legacy-envelope', 0, '{"schemaVersion":1,"source":"discord","requestId":"request"}');
        INSERT INTO agent_runtime_artifact_chunks(artifact_id, chunk_index, content)
        VALUES ('legacy-envelope', 1, ' ');
        INSERT INTO rng_sessions(
          id, thread_key, guild_id, channel_id, created_by_user_id, server_seed, commitment
        ) VALUES ('legacy-rng', 'legacy-thread', 'guild', 'channel', 'user', 'seed', 'commitment');
        INSERT INTO rng_draws(session_id, nonce, kind, params, outcome, message_id)
        VALUES ('legacy-rng', 0, 'coin', '{}'::jsonb, '{"kind":"coin","values":["heads"]}'::jsonb, 'root-message');
      `);
      await client.query(await readFile(path.resolve("migrations/026_remove_legacy_delivery_and_rng_scopes.sql"), "utf8"));
      await expect(client.query("SELECT count(*)::int AS count FROM discord_emoji_channel_profiles"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ count: 0 })] }));
      await expect(client.query("SELECT count(*)::int AS count FROM discord_component_actions"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ count: 0 })] }));
      await expect(client.query("SELECT count(*)::int AS count FROM agent_runtime_artifact_blobs"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ count: 1 })] }));
      await expect(client.query("SELECT count(*)::int AS count FROM wallet_guild_settings"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ count: 0 })] }));
      await expect(client.query("SELECT count(*)::int AS count FROM skills WHERE source = 'database'"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ count: 0 })] }));
      await expect(client.query("SELECT count(*)::int AS count FROM guild_agent_settings"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ count: 0 })] }));
      await expect(client.query(`
        SELECT string_agg(content, '' ORDER BY chunk_index)::jsonb ->> 'schemaVersion' AS version
        FROM agent_runtime_artifact_chunks
        WHERE artifact_id = 'legacy-delivery'
      `)).resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ version: "2" })] }));
      await expect(client.query(`
        SELECT content
        FROM agent_runtime_artifact_blobs
        WHERE artifact_id = 'legacy-delivery:delivery-file:1'
      `)).resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ content: Buffer.from("legacy") })] }));
      await expect(client.query("SELECT thread_key FROM rng_sessions WHERE id = 'legacy-rng'"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ thread_key: "legacy-thread:rng-root:root-message" })] }));
      await expect(client.query(`
        SELECT string_agg(content, '' ORDER BY chunk_index)::jsonb ->> 'schemaVersion' AS version
        FROM agent_runtime_artifact_chunks
        WHERE artifact_id = 'legacy-envelope'
      `)).resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ version: "2" })] }));
      await expect(client.query("SELECT count(*)::int AS count FROM agent_runtime_artifact_chunks WHERE artifact_id = 'legacy-envelope'"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ count: 1 })] }));
      for (const version of [
        "027_discord_bug_reports",
        "028_nanocodex_runtime_defaults",
        "029_remove_sandbox_leases",
        "030_run_feedback_regression_contract",
        "031_atomic_agent_event_sequences",
        "032_bug_report_retry_outcomes",
        "033_release_verifications",
        "034_release_verification_instances",
        "035_frog_entries",
        "036_runtime_run_list_indexes",
        "037_one_runtime_execution_per_task",
        "038_discord_retry_reactions",
      ]) {
        await client.query(await readFile(path.resolve(`migrations/${version}.sql`), "utf8"));
      }
      await client.query(`
        UPDATE agent_run_feedback
        SET failure_mode = 'wrong_tool', expected_tools = ARRAY['searchDiscordHistory'],
            forbidden_tools = ARRAY['transferWalletFunds'], must_contain = ARRAY['source']
        WHERE run_id = 'execution'
      `);
      await expect(client.query("SELECT failure_mode, expected_tools, forbidden_tools, must_contain FROM agent_run_feedback WHERE run_id = 'execution'"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({
          failure_mode: "wrong_tool",
          expected_tools: ["searchDiscordHistory"],
          forbidden_tools: ["transferWalletFunds"],
          must_contain: ["source"],
        })] }));
      await expect(client.query("SELECT event_sequence FROM agent_runtime_executions WHERE execution_id = 'execution'"))
        .resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ event_sequence: 1 })] }));
      await expect(client.query("SELECT retry_status, retried_at FROM discord_bug_reports LIMIT 0"))
        .resolves.toEqual(expect.objectContaining({ rows: [] }));
      await expect(client.query("SELECT revision, deployment_id, verified_at FROM deployment_verifications LIMIT 0"))
        .resolves.toEqual(expect.objectContaining({ rows: [] }));
      await expect(client.query("SELECT namespace, id, dedupe_key, contents, occurrence_count FROM frog_entries LIMIT 0"))
        .resolves.toEqual(expect.objectContaining({ rows: [] }));
      await expect(client.query("SELECT guild_id, message_id, user_id, emoji FROM discord_retry_reactions LIMIT 0"))
        .resolves.toEqual(expect.objectContaining({ rows: [] }));
      await client.query(await readFile(path.resolve("migrations/039_improvement_cases.sql"), "utf8"));
      await expect(client.query("SELECT case_id, status, classification FROM improvement_cases LIMIT 0"))
        .resolves.toEqual(expect.objectContaining({ rows: [] }));
      await expect(client.query("SELECT signal_id, case_id, source FROM improvement_signals LIMIT 0"))
        .resolves.toEqual(expect.objectContaining({ rows: [] }));
      for (const retired of ["discord_bug_markers", "discord_bug_reports", "agent_run_feedback", "frog_entries"]) {
        await expect(client.query("SELECT to_regclass($1) AS relation", [retired]))
          .resolves.toEqual(expect.objectContaining({ rows: [{ relation: null }] }));
      }
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });
});
