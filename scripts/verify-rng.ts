/**
 * Offline verifier for provably fair RNG sessions and draws.
 *
 * Database mode (verifies a whole session against stored rows):
 *   npm run verify:rng -- --session rng_ab12cd34ef56
 *
 * Standalone mode (no database; recompute a single draw from revealed values):
 *   npm run verify:rng -- --server-seed <hex> --client-seed <id> --nonce 0 --kind dice --sides 6 --count 2
 *   npm run verify:rng -- --server-seed <hex> --commitment <hex>            (commitment check only)
 *
 * Card draws in standalone mode take the shoe's shuffle nonce plus deck slice:
 *   npm run verify:rng -- --server-seed <hex> --client-seed <id> --nonce 1 --kind cards --deck-count 1 --start 0 --count 2
 */
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { RngRepository } from "../src/db/rngRepository.js";
import {
  formatRngOutcome,
  recomputeStoredRngDraw,
  rngCommitment,
  verifyRngCommitment,
  type RngOutcome,
  type StoredRngDrawKind
} from "../src/rng/provable.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function numberArg(name: string): number | undefined {
  const value = argValue(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got "${value}"`);
  return parsed;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function verifySessionFromDb(sessionId: string): Promise<boolean> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const rngRepo = new RngRepository(pool);
    const session = await rngRepo.getSession(sessionId);
    if (!session) {
      console.error(`Session ${sessionId} not found.`);
      return false;
    }
    console.log(`Session ${session.id} (${session.status})`);
    console.log(`  commitment: sha256:${session.commitment}`);
    if (session.status !== "revealed") {
      console.log(`  server seed: <still secret; ask the bot to "reveal randomness" first>`);
    } else {
      console.log(`  server seed: ${session.serverSeed}`);
    }
    console.log(`  client seed: ${session.clientSeed ?? "<unset>"} (${session.clientSeedSource ?? "unknown source"})`);

    let ok = true;
    if (!verifyRngCommitment(session.serverSeed, session.commitment)) {
      console.error("  ✗ COMMITMENT MISMATCH: sha256(serverSeed) does not equal the published commitment");
      ok = false;
    } else {
      console.log("  ✓ commitment matches sha256(server seed)");
    }

    const draws = await rngRepo.listDraws(session.id);
    if (draws.length === 0) {
      console.log("  (no draws recorded)");
      return ok;
    }
    if (!session.clientSeed) {
      console.error("  ✗ session has draws but no client seed; cannot verify");
      return false;
    }
    for (const draw of draws) {
      const recomputed = recomputeStoredRngDraw({
        serverSeed: session.serverSeed,
        clientSeed: session.clientSeed,
        nonce: draw.nonce,
        kind: draw.kind as StoredRngDrawKind,
        params: draw.params
      });
      const matches = deepEqual(recomputed, draw.outcome);
      const label = `${draw.kind}${draw.reason ? ` (${draw.reason})` : ""} nonce ${draw.nonce}`;
      if (matches) {
        console.log(`  ✓ ${label}: ${summarize(recomputed)}`);
      } else {
        console.error(`  ✗ ${label}: stored ${summarize(draw.outcome)} but recomputed ${summarize(recomputed)}`);
        ok = false;
      }
    }
    for (const problem of checkProtocolInvariants(session.nonceCounter, draws)) {
      console.error(`  ✗ protocol: ${problem}`);
      ok = false;
    }
    if (ok) console.log("  ✓ protocol invariants hold (nonce coverage, shoe accounting)");
    console.log(ok ? "All draws verified." : "VERIFICATION FAILED.");
    return ok;
  } finally {
    await pool.end();
  }
}

/**
 * Check that the session's stored transcript obeys the protocol, beyond each
 * row recomputing correctly:
 * - entropy-consuming draws (everything except `cards`) use each nonce in
 *   [0, nonceCounter) exactly once — no duplicated, skipped, or extra entropy;
 * - every `cards` row references a recorded shoe shuffle with matching deck
 *   count and size;
 * - card slices from each shoe are contiguous from position 0 and in-bounds,
 *   i.e. dealt without replacement with no overlaps or gaps.
 */
export function checkProtocolInvariants(
  nonceCounter: number,
  draws: Array<{ id: number; nonce: number; kind: string; params: Record<string, unknown> }>
): string[] {
  const problems: string[] = [];

  const entropyNonces = draws.filter((draw) => draw.kind !== "cards").map((draw) => draw.nonce);
  const expected = Array.from({ length: nonceCounter }, (_, index) => index);
  if (!deepEqual([...entropyNonces].sort((a, b) => a - b), expected)) {
    problems.push(
      `entropy draws used nonces [${entropyNonces.join(", ")}] but the session consumed nonces 0..${nonceCounter - 1}`
    );
  }

  const shoesByNonce = new Map<number, { deckCount: number; size: number }>();
  for (const draw of draws) {
    if (draw.kind === "shuffle" && draw.params.shoe === true) {
      shoesByNonce.set(draw.nonce, {
        deckCount: Number(draw.params.deckCount),
        size: Number(draw.params.size)
      });
    }
  }

  const positionByShoe = new Map<number, number>();
  for (const draw of draws) {
    if (draw.kind !== "cards") continue;
    const label = `cards row ${draw.id} (shuffle nonce ${draw.nonce})`;
    const shoe = shoesByNonce.get(draw.nonce);
    if (!shoe) {
      problems.push(`${label} references a shoe shuffle that was never recorded`);
      continue;
    }
    const deckCount = Number(draw.params.deckCount);
    const start = Number(draw.params.start);
    const count = Number(draw.params.count);
    if (deckCount !== shoe.deckCount || deckCount * 52 !== shoe.size) {
      problems.push(`${label} deck count ${deckCount} does not match the recorded ${shoe.deckCount}-deck shoe`);
    }
    const position = positionByShoe.get(draw.nonce) ?? 0;
    if (start !== position) {
      problems.push(`${label} deals cards ${start + 1}–${start + count} but the shoe was at position ${position}`);
    }
    if (start + count > shoe.size) {
      problems.push(`${label} deals past the end of the ${shoe.size}-card shoe`);
    }
    positionByShoe.set(draw.nonce, start + count);
  }

  return problems;
}

function verifyStandalone(): boolean {
  const serverSeed = argValue("server-seed");
  if (!serverSeed) throw new Error("Provide --session <id> or --server-seed <hex>.");

  const commitment = argValue("commitment");
  if (commitment) {
    const matches = verifyRngCommitment(serverSeed, commitment);
    console.log(`sha256(server seed) = ${rngCommitment(serverSeed)}`);
    console.log(matches ? "✓ commitment matches" : "✗ COMMITMENT MISMATCH");
    if (!argValue("kind")) return matches;
    if (!matches) return false;
  }

  const kind = argValue("kind") as StoredRngDrawKind | undefined;
  if (!kind) {
    if (!commitment) throw new Error("Provide --commitment and/or --kind to verify something.");
    return true;
  }
  const clientSeed = argValue("client-seed");
  const nonce = numberArg("nonce");
  if (!clientSeed || nonce === undefined) throw new Error("Draw verification needs --client-seed and --nonce.");

  const params: Record<string, unknown> = {};
  for (const [cli, key] of [
    ["count", "count"],
    ["min", "min"],
    ["max", "max"],
    ["sides", "sides"],
    ["size", "size"],
    ["deck-count", "deckCount"],
    ["start", "start"]
  ] as const) {
    const value = numberArg(cli);
    if (value !== undefined) params[key] = value;
  }
  const options = argValue("options");
  if (options) params.options = options.split(",").map((option) => option.trim());

  const recomputed = recomputeStoredRngDraw({ serverSeed, clientSeed, nonce, kind, params });
  console.log(`Recomputed ${kind} draw at nonce ${nonce}:`);
  console.log(`  ${summarize(recomputed)}`);
  console.log(JSON.stringify(recomputed, null, 2));
  return true;
}

function summarize(outcome: unknown): string {
  const record = outcome as Record<string, unknown>;
  if (Array.isArray(record?.cards)) return (record.cards as string[]).join(" ");
  if (record?.kind && (Array.isArray(record?.values) || Array.isArray(record?.permutation))) {
    try {
      return formatRngOutcome(record as unknown as RngOutcome);
    } catch {
      // fall through to JSON
    }
  }
  return JSON.stringify(outcome);
}

async function main() {
  const sessionId = argValue("session");
  const ok = sessionId ? await verifySessionFromDb(sessionId) : verifyStandalone();
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
