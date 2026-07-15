import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createPool } from "../../src/db/pool.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("migration upgrade compatibility", () => {
  it("upgrades the previous schema through runtime spans, projections, and feedback without losing events", async () => {
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
      await client.query("INSERT INTO agent_run_feedback(run_id, rating, capture_eval) VALUES ('execution', 'good', true)");
      await expect(client.query("SELECT count(*)::int AS count FROM agent_run_feedback")).resolves.toEqual(expect.objectContaining({ rows: [expect.objectContaining({ count: 1 })] }));
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });
});
