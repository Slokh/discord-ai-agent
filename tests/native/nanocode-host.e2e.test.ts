import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { deleteNanocodeSessionsForUser, recordNanocodeSession } from "../../src/db/nanocodeSessionRepository.js";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NanocodeHost, nanocodeSessionId, type NanocodeToolDefinition } from "../../src/agent/nanocodeHost.js";
import { startFakeResponsesServer, type FakeModelStep, type RecordedResponsesRequest } from "../support/fakeResponsesServer.js";

/**
 * Runs the real nanocode host binary against a local fake model. Build it
 * with `cargo build --manifest-path native/nanocodex-runtime/Cargo.toml` or
 * point NANOCODE_HOST_BINARY at one. NANOCODE_TEST_DATABASE_URL enables the
 * durable-store cases.
 */
const binary = process.env.NANOCODE_HOST_BINARY
  ?? path.join(process.cwd(), "native/nanocodex-runtime/target/debug/discord-agent-nanocodex-runtime");
const databaseUrl = process.env.NANOCODE_TEST_DATABASE_URL;

const tools: NanocodeToolDefinition[] = [{
  type: "function",
  name: "add",
  description: "Add two numbers.",
  strict: false,
  parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
}];

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Fake = Awaited<ReturnType<typeof startFakeResponsesServer>>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function harness(script: (request: RecordedResponsesRequest, index: number) => FakeModelStep, options: { durable?: boolean } = {}) {
  const fake = await startFakeResponsesServer(script);
  cleanups.push(fake.close);
  const start = () => {
    const host = new NanocodeHost({
      tools,
      apiBaseUrl: fake.baseUrl,
      env: {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: "test-key",
        ...(options.durable && databaseUrl ? { DATABASE_URL: databaseUrl } : { NANOCODE_STORE: "memory" }),
      },
      binary,
    });
    cleanups.push(() => host.stop());
    return host;
  };
  return { fake, start };
}

function lastItem(request: RecordedResponsesRequest) {
  return ((request.body.input as Array<Record<string, unknown>>) ?? []).at(-1);
}

const addTwice: (request: RecordedResponsesRequest) => FakeModelStep = (request) =>
  lastItem(request)?.type === "custom_tool_call_output"
    ? { kind: "message", text: `done after ${(request.body.input as unknown[]).length} items` }
    : { kind: "exec", code: "const [a, b] = await Promise.all([tools.add({a: 40, b: 2}), tools.add({a: 1, b: 1})]);\ntext(JSON.stringify([a, b]));" };

function turn(host: NanocodeHost, requestId: string, sessionKey: string, text: string, extra: Partial<Parameters<NanocodeHost["runTurn"]>[0]> = {}) {
  const started: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  return {
    started,
    maxConcurrent: () => maxConcurrent,
    result: host.runTurn({
      requestId,
      sessionId: nanocodeSessionId(sessionKey),
      model: "gpt-6-luna",
      thinking: "low",
      instructions: "You are a test agent.",
      prompt: { text, images: [] },
      executeTool: async (call) => {
        started.push(call.callId);
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const args = call.arguments as { a: number; b: number };
        await new Promise((resolve) => setTimeout(resolve, 150));
        concurrent -= 1;
        return { success: true, output: String(args.a + args.b) };
      },
      ...extra,
    }),
  };
}

describe.skipIf(!existsSync(binary))("nanocode host (real binary, fake model)", () => {
  it("runs parallel Code Mode tool calls concurrently and continues the session", async () => {
    const { fake, start } = await harness(addTwice);
    const host = start();
    const first = turn(host, "req-1", "thread:user:a", "first");
    await expect(first.result).resolves.toMatchObject({ finalMessage: "done after 7 items", resumed: false });
    expect(first.started).toHaveLength(2);
    expect(first.maxConcurrent()).toBe(2);

    const second = turn(host, "req-2", "thread:user:a", "second");
    const result = await second.result;
    expect(result.resumed).toBe(true);
    // The second turn's first request carries the whole first turn.
    expect((fake.requests[2]!.body.input as unknown[]).length).toBeGreaterThan((fake.requests[0]!.body.input as unknown[]).length);
  });

  it("sends inline images and bootstrap context only when a session starts", async () => {
    const { fake, start } = await harness(() => ({ kind: "message", text: "ok" }));
    const host = start();
    await turn(host, "req-1", "thread:user:b", "look", { prompt: { text: "look", images: [PIXEL] }, bootstrap: "EARLIER CONTEXT" }).result;
    await turn(host, "req-2", "thread:user:b", "again", { bootstrap: "EARLIER CONTEXT" }).result;
    const firstMessage = JSON.stringify(lastItem(fake.requests[0]!));
    expect(firstMessage).toContain("input_image");
    expect(firstMessage).toContain("EARLIER CONTEXT");
    expect(JSON.stringify(lastItem(fake.requests[1]!))).not.toContain("EARLIER CONTEXT");
  });

  it("steers a running turn with a follow-up message", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { fake, start } = await harness((request) => {
      const text = JSON.stringify(request.body.input);
      if (lastItem(request)?.type === "custom_tool_call_output") return { kind: "message", text: text.includes("ALSO MULTIPLY") ? "saw steer" : "no steer" };
      return { kind: "exec", code: "text(String(await tools.add({a: 1, b: 2})));" };
    });
    const host = start();
    const running = turn(host, "req-1", "thread:user:c", "add", {
      executeTool: async () => {
        await gate;
        return { success: true, output: "3" };
      },
    });
    await waitFor(() => fake.requests.length === 1 && host.activeRequest(nanocodeSessionId("thread:user:c")) === "req-1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(host.steer({ requestId: "req-1", steerId: "steer-1", prompt: { text: "ALSO MULTIPLY", images: [] } })).resolves.toBe(true);
    release();
    await expect(running.result).resolves.toMatchObject({ finalMessage: "saw steer" });
  });

  it("fails a cancelled turn", async () => {
    const controller = new AbortController();
    const { start } = await harness(() => ({ kind: "exec", code: "text(String(await tools.add({a: 1, b: 2})));" }));
    const host = start();
    const running = turn(host, "req-1", "thread:user:d", "add", {
      abortSignal: controller.signal,
      executeTool: async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { success: true, output: "3" };
      },
    });
    await expect(running.result).rejects.toThrow();
  });

  it.skipIf(!databaseUrl)("resumes a durable session in a new process and replays a request without a second model call", async () => {
    const { fake, start } = await harness(addTwice, { durable: true });
    const sessionKey = `thread:user:durable:${Date.now()}`;
    const first = start();
    await expect(turn(first, "req-1", sessionKey, "first").result).resolves.toMatchObject({ resumed: false });
    await first.stop();
    const calls = fake.requests.length;

    const second = start();
    await expect(turn(second, "req-2", sessionKey, "second").result).resolves.toMatchObject({ resumed: true });
    const afterSecond = fake.requests.length;
    expect(afterSecond).toBe(calls + 2);
    await expect(turn(second, "req-1", sessionKey, "first").result).resolves.toMatchObject({ finalMessage: "done after 7 items" });
    expect(fake.requests.length).toBe(afterSecond);
  });
});

describe.skipIf(!existsSync(binary) || !databaseUrl)("nanocode session deletion (real binary, Postgres)", () => {
  it("deletes one requester's session and leaves a session that shares its records resumable", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    cleanups.push(() => pool.end());
    await pool.query(readFileSync(path.join(process.cwd(), "migrations/066_nanocode_sessions.sql"), "utf8"));
    const { fake, start } = await harness(addTwice, { durable: true });
    const run = Date.now();
    const keyA = `thread:member-a:${run}`;
    const keyB = `thread:member-b:${run}`;
    const first = start();
    // Identical prompts and tool output give the two sessions shared records.
    await turn(first, `a-1-${run}`, keyA, "same words").result;
    await turn(first, `b-1-${run}`, keyB, "same words").result;
    await first.stop();
    await recordNanocodeSession(pool, { sessionId: nanocodeSessionId(keyA), userId: `member-a-${run}`, threadKey: "thread" });
    await recordNanocodeSession(pool, { sessionId: nanocodeSessionId(keyB), userId: `member-b-${run}`, threadKey: "thread" });

    await expect(deleteNanocodeSessionsForUser(pool, `member-a-${run}`)).resolves.toBe(1);
    const left = await pool.query(
      "SELECT count(*)::int AS states FROM nanocode.states WHERE split_part(id, ':', 1) = $1",
      [nanocodeSessionId(keyA)],
    );
    expect(left.rows[0].states).toBe(0);
    const heldByA = await pool.query(
      "SELECT count(*)::int AS records FROM nanocode.records WHERE split_part(holder, ':', 1) = $1",
      [nanocodeSessionId(keyA)],
    );
    expect(heldByA.rows[0].records).toBe(0);

    const second = start();
    const before = fake.requests.length;
    await expect(turn(second, `b-2-${run}`, keyB, "again").result).resolves.toMatchObject({ resumed: true });
    expect(fake.requests.length).toBe(before + 2);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export type { Fake };
