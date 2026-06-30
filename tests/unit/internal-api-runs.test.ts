import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import { startInternalApi, type InternalApiRuntime } from "../../src/control/internalApi.js";
import type {
  DiscordAiAgentRepository,
  ProcessRunArtifactContent,
  ProcessRunArtifactRecord,
  ProcessRunEventRecord,
  ProcessRunRecord
} from "../../src/db/repositories.js";

describe("internal API run endpoints", () => {
  let runtime: InternalApiRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  it("serves run list, detail, events, artifacts, and SSE snapshots", async () => {
    runtime = await startInternalApi({ config: testConfig(), repo: fakeRepo() });
    const auth = { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` };

    const list = await fetch(`${runtime.url}/api/runs`, { headers: auth });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual(expect.objectContaining({ runs: [expect.objectContaining({ runId: "run-1" })] }));

    const detail = await fetch(`${runtime.url}/api/runs/run-1`, { headers: auth });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toEqual(expect.objectContaining({ run: expect.objectContaining({ runId: "run-1" }) }));

    const events = await fetch(`${runtime.url}/api/runs/run-1/events`, { headers: auth });
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toEqual(expect.objectContaining({ events: [expect.objectContaining({ name: "model.complete" })] }));

    const artifact = await fetch(`${runtime.url}/api/runs/run-1/artifacts/artifact-1`, { headers: auth });
    expect(artifact.status).toBe(200);
    await expect(artifact.text()).resolves.toBe("artifact body");

    const stream = await fetch(`${runtime.url}/api/runs/run-1/stream`, { headers: auth });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    expect(Buffer.from(chunk.value ?? new Uint8Array()).toString("utf8")).toContain("event: snapshot");
  });

  it("excludes embedding runs from the list unless requested", async () => {
    const listInputs: Array<{ includeEmbeddings?: boolean }> = [];
    runtime = await startInternalApi({
      config: testConfig(),
      repo: fakeRepo({ onListProcessRuns: (input) => listInputs.push({ includeEmbeddings: input.includeEmbeddings }) })
    });
    const auth = { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` };

    const defaultList = await fetch(`${runtime.url}/api/runs`, { headers: auth });
    expect(defaultList.status).toBe(200);
    expect(listInputs.at(-1)).toEqual({ includeEmbeddings: false });

    const expandedList = await fetch(`${runtime.url}/api/runs?includeEmbeddings=1`, { headers: auth });
    expect(expandedList.status).toBe(200);
    expect(listInputs.at(-1)).toEqual({ includeEmbeddings: true });
  });
});

function testConfig(): AppConfig {
  const config = loadConfig();
  return {
    ...config,
    internalApi: { host: "127.0.0.1", port: 0 },
    controlUi: { authPassword: "secret", publicUrl: null },
    execution: { ...config.execution, taskSigningSecret: "task-secret" }
  };
}

function fakeRepo(options: { onListProcessRuns?: (input: { includeEmbeddings?: boolean }) => void } = {}) {
  const run: ProcessRunRecord = {
    runId: "run-1",
    traceId: "trace-1",
    kind: "prompt",
    status: "succeeded",
    title: "Prompt run",
    summary: "done",
    guildId: null,
    channelId: null,
    userId: null,
    messageId: null,
    requester: "test",
    source: "test",
    metadata: {},
    links: {},
    startedAt: new Date("2026-06-30T12:00:00Z"),
    completedAt: new Date("2026-06-30T12:00:01Z"),
    updatedAt: new Date("2026-06-30T12:00:01Z")
  };
  const event: ProcessRunEventRecord = {
    id: 1,
    runId: "run-1",
    traceId: "trace-1",
    level: "info",
    eventName: "model.complete",
    summary: "model finished",
    metadata: { model: "test/model" },
    durationMs: 1000,
    createdAt: new Date("2026-06-30T12:00:01Z")
  };
  const artifact: ProcessRunArtifactRecord = {
    artifactId: "artifact-1",
    runId: "run-1",
    kind: "prompt",
    name: "Prompt",
    contentType: "text/plain",
    sizeBytes: 13,
    preview: "artifact body",
    redacted: true,
    expiresAt: null,
    metadata: {},
    createdAt: new Date("2026-06-30T12:00:01Z")
  };
  const artifactContent: ProcessRunArtifactContent = {
    ...artifact,
    content: "artifact body"
  };

  return {
    listProcessRuns: async (input: { includeEmbeddings?: boolean }) => {
      options.onListProcessRuns?.(input);
      return [run];
    },
    listRecentAgentTasks: async () => [],
    getProcessRun: async (runId: string) => (runId === "run-1" ? run : undefined),
    getAgentTask: async () => undefined,
    getProcessRunSpans: async () => [],
    getProcessRunEvents: async () => [event],
    getProcessRunArtifacts: async () => [artifact],
    getProcessRunArtifact: async (input: { artifactId: string }) => (input.artifactId === "artifact-1" ? artifactContent : undefined),
    getTraceEventsForTrace: async () => [],
    getToolAuditLogsForTrace: async () => []
  } as unknown as DiscordAiAgentRepository;
}
