import { describe, expect, it } from "vitest";
import { formatRunArtifacts, formatRunInspection, formatRunSummaryList, formatRunTriage, formatSeconds, selectArtifacts } from "../../src/observability/runInspector.js";
import type { RunSnapshot, RunSummary } from "../../src/observability/runTypes.js";

describe("run inspector formatting", () => {
  it("formats a compact debugger report for a run snapshot", () => {
    const snapshot = snapshotFixture();

    const report = formatRunInspection(snapshot, { includeMetadata: true, includeTerminal: true });

    expect(report).toContain("codegen run task-1");
    expect(report).toContain("no_changes: replace-thinking");
    expect(report).toContain("Duration: 16m 43s");
    expect(report).toContain("Bottleneck: nanocodex (16m 1s)");
    expect(report).toContain("Model usage:");
    expect(report).toContain("- Token usage: input=100 output=25 total=125 cached_input=40 across 1 LLM call (z-ai/glm-5.2)");
    expect(report).toContain("- Estimated audited cost: $0.004200 across 1 model/tool audit");
    expect(report).toContain("Agent transcript (2 messages):");
    expect(report).toContain("assistant (agent.router | round 1): requested runCodingAgent");
    expect(report).toContain("tool (agent.runtime.tool): runCodingAgent task-1 queued");
    expect(report).toContain("Related runs:");
    expect(report).toContain("- 1234567890123450000 | discord | succeeded | 1.234s | User asked for a code update");
    expect(report).toContain("trace=1234567890123450000 | message=1234567890123450000");
    expect(report).toContain("- task-retry | codegen | running | unknown | Retry code update");
    expect(report).toContain("step=nanocodex_attempt_1");
    expect(report).toContain("Slowest spans:");
    expect(report).toContain("- 16m 1s nanocodex (task, failed)");
    expect(report).toContain("Timeline");
    expect(report).toContain("runtime info agent.model.call.completed (23.373s)");
    expect(report).toContain("Artifacts:");
    expect(report).toContain("artifact-prompt | prompt | NanoCodex prompt");
    expect(report).toContain("Terminal tail");
    expect(report).toContain("nanocodex run");
  });

  it("selects artifacts by id, kind, name, or all", () => {
    const artifacts = snapshotFixture().artifacts;

    expect(selectArtifacts(artifacts, "artifact-prompt")).toHaveLength(1);
    expect(selectArtifacts(artifacts, "prompt")).toHaveLength(1);
    expect(selectArtifacts(artifacts, "NanoCodex")).toHaveLength(1);
    expect(selectArtifacts(artifacts, "all")).toHaveLength(artifacts.length);
  });

  it("formats artifact contents", () => {
    expect(
      formatRunArtifacts([
        {
          ...snapshotFixture().artifacts[0]!,
          content: "full prompt body\n"
        }
      ])
    ).toContain("full prompt body");
  });

  it("formats durations as seconds instead of milliseconds", () => {
    expect(formatSeconds(42)).toBe("0.042s");
    expect(formatSeconds(1234)).toBe("1.234s");
    expect(formatSeconds(63_000)).toBe("1m 3s");
  });

  it("clusters production signals without including private prompt text", () => {
    const warned = snapshotFixture();
    warned.run.runId = "run-warned";
    warned.run.status = "succeeded";
    warned.events.push({
      id: "empty", source: "runtime", level: "info", name: "agent.tool.complete", summary: null,
      createdAt: new Date(), durationMs: 4, metadata: { toolName: "web__run", status: "error", outputChars: 0 },
    });
    warned.events.push({
      id: "warning", source: "runtime", level: "warn", name: "agent.provider.warning", summary: "bounded warning",
      createdAt: new Date(), durationMs: null, metadata: {},
    });
    const report = formatRunTriage([warned]);
    expect(report).toContain("tool.error:web__run");
    expect(report).toContain("tool.empty:web__run");
    expect(report).toContain("agent.provider.warning");
    expect(report).not.toContain(warned.run.title);
  });

  it("formats filtered run summary lists for aggregate debugging", () => {
    const runs: RunSummary[] = [
      runSummary({ runId: "run-fast", kind: "discord", status: "succeeded", durationMs: 1200, title: "hello" }),
      runSummary({
        runId: "run-slow",
        kind: "codegen",
        status: "no_changes",
        durationMs: 900_000,
        title: "replace thinking",
        summary: "Agent task produced no diff.",
        bottleneck: { name: "nanocodex_attempt_1", durationMs: 870_000 },
        links: { pullRequest: "https://github.com/example/repo/pull/1" },
        metadata: {
          failureDiagnosis: {
            category: "no_diff",
            summary: "The coding agent completed but did not leave a repository diff.",
            nextAction: "Inspect the transcript and clarify the requested file or expected behavior."
          }
        }
      }),
      runSummary({ runId: "run-failed", kind: "codegen", status: "failed", durationMs: 300_000, title: "fix codegen" })
    ];

    const report = formatRunSummaryList(runs, { kind: "codegen", sort: "slowest", limit: 2 });

    expect(report).toContain("Runs (2 of 3)");
    expect(report).toContain("Sort: slowest | Kind: codegen");
    expect(report).toContain("Statuses: failed=1, no_changes=1");
    expect(report).toContain("Codegen diagnoses: no_diff=1");
    expect(report.indexOf("run-slow")).toBeLessThan(report.indexOf("run-failed"));
    expect(report).toContain("bottleneck=nanocodex_attempt_1 14m 30s");
    expect(report).toContain("pr=https://github.com/example/repo/pull/1");
    expect(report).toContain("diagnosis=no_diff | The coding agent completed but did not leave a repository diff.");
    expect(report).toContain("next=Inspect the transcript and clarify the requested file or expected behavior.");
    expect(report).not.toContain("run-fast");
  });
});

function runSummary(overrides: Partial<RunSummary>): RunSummary {
  const now = new Date("2026-07-01T17:40:21.000Z");
  return {
    runId: "run-1",
    traceId: "trace-1",
    kind: "discord",
    status: "succeeded",
    title: "test run",
    summary: null,
    requester: "kartik",
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    messageId: "message",
    source: "process_run",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    durationMs: 1000,
    currentStep: null,
    bottleneck: null,
    links: {},
    metadata: {},
    ...overrides
  };
}

function snapshotFixture(): RunSnapshot {
  const startedAt = new Date("2026-07-01T17:40:21.000Z");
  return {
    run: {
      runId: "task-1",
      traceId: "trace-1",
      kind: "codegen",
      status: "no_changes",
      title: "replace-thinking",
      summary: "Agent task produced no diff after NanoCodex attempt.",
      requester: "kartik",
      guildId: "guild",
      channelId: "channel",
      userId: "user",
      messageId: "message",
      source: "task",
      startedAt,
      completedAt: new Date("2026-07-01T17:57:04.000Z"),
      updatedAt: new Date("2026-07-01T17:57:04.000Z"),
      durationMs: 1_003_000,
      currentStep: null,
      bottleneck: { name: "nanocodex", durationMs: 961_000 },
      links: { run: "https://tasks.example/runs/task-1" },
      metadata: {}
    },
    spans: [
      {
        id: "nanocodex",
        source: "task",
        name: "nanocodex",
        status: "failed",
        startedAt: new Date("2026-07-01T17:41:27.000Z"),
        completedAt: new Date("2026-07-01T17:57:28.000Z"),
        durationMs: 961_000,
        metadata: {}
      },
      {
        id: "attempt-1",
        source: "command",
        name: "nanocodex_attempt_1",
        status: "succeeded",
        startedAt: new Date("2026-07-01T17:41:27.000Z"),
        completedAt: new Date("2026-07-01T17:49:27.000Z"),
        durationMs: 480_000,
        metadata: { command: "nanocodex run" }
      },
      {
        id: "llm-round-1",
        source: "process",
        name: "LLM round 1",
        status: "succeeded",
        startedAt: new Date("2026-07-01T17:40:21.000Z"),
        completedAt: new Date("2026-07-01T17:40:44.000Z"),
        durationMs: 23_000,
        metadata: {
          model: "z-ai/glm-5.2",
          usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125, cachedInputTokens: 40 }
        }
      }
    ],
    events: [
      {
        id: "prompt",
        source: "trace",
        level: "info",
        name: "User prompt",
        summary: "open a PR for this",
        createdAt: startedAt,
        durationMs: null,
        metadata: {}
      },
      {
        id: "llm",
        source: "runtime",
        level: "info",
        name: "agent.model.call.completed",
        summary: "tool_selection_round_1",
        createdAt: new Date("2026-07-01T17:40:45.000Z"),
        durationMs: 23_373,
        metadata: {
          callId: "call-1",
          purpose: "tool_selection_round_1",
          model: "z-ai/glm-5.2",
          requestedToolCalls: ["runCodingAgent"],
          usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125, cachedInputTokens: 40 }
        }
      },
      {
        id: "tool-chat",
        source: "tool",
        level: "info",
        name: "chat",
        summary: "final answer",
        createdAt: new Date("2026-07-01T17:40:46.000Z"),
        durationMs: null,
        metadata: { model: "z-ai/glm-5.2", estimatedCostUsd: 0.0042 }
      }
    ],
    artifacts: [
      {
        artifactId: "artifact-prompt",
        runId: "task-1",
        kind: "prompt",
        name: "NanoCodex prompt",
        contentType: "text/plain",
        sizeBytes: 8123,
        preview: "Requested update: Replace Thinking with a reaction",
        redacted: true,
        expiresAt: null,
        metadata: {},
        createdAt: new Date("2026-07-01T17:41:27.000Z")
      }
    ],
    terminal: {
      lineCount: 1,
      content: "nanocodex run",
      entries: [
        {
          id: "terminal-1",
          source: "command",
          stream: "command",
          step: "nanocodex_attempt_1",
          command: "nanocodex run",
          createdAt: new Date("2026-07-01T17:41:27.000Z"),
          content: "nanocodex run"
        }
      ]
    },
    diagnostics: ["nanocodex was the bottleneck"],
    raw: { sandboxRuns: [] },
    agentTranscript: [
      {
        id: "agent-transcript-message-assistant-round-1",
        sessionId: "agent-session-1",
        clientMessageId: "message:transcript:assistant-round-1",
        role: "assistant",
        parts: [
          {
            type: "assistant_tool_calls",
            toolCalls: [{ id: "call-1", name: "runCodingAgent", arguments: { request: "replace Thinking" } }]
          }
        ],
        metadata: { source: "agent.router", round: 1 },
        createdAt: new Date("2026-07-01T17:40:45.000Z")
      },
      {
        id: "agent-task-message-task-1",
        sessionId: "agent-session-1",
        clientMessageId: "task-1",
        role: "tool",
        parts: [
          {
            type: "tool_result",
            toolName: "runCodingAgent",
            taskId: "task-1",
            status: "queued"
          }
        ],
        metadata: { source: "agent.runtime.tool" },
        createdAt: new Date("2026-07-01T17:40:46.000Z")
      }
    ],
    relatedRuns: [
      runSummary({
        runId: "1234567890123450000",
        traceId: "1234567890123450000",
        kind: "discord",
        status: "succeeded",
        title: "User asked for a code update",
        messageId: "1234567890123450000",
        durationMs: 1234
      }),
      runSummary({
        runId: "task-retry",
        traceId: "trace-retry",
        kind: "codegen",
        status: "running",
        title: "Retry code update",
        durationMs: null,
        currentStep: "nanocodex_attempt_1"
      })
    ],
    generatedAt: new Date("2026-07-01T17:57:29.000Z")
  };
}
