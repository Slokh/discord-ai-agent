import { describe, expect, it } from "vitest";
import { formatRunArtifacts, formatRunInspection, formatSeconds, selectArtifacts } from "../../src/observability/runInspector.js";
import type { RunSnapshot } from "../../src/observability/runs.js";

describe("run inspector formatting", () => {
  it("formats a compact debugger report for a run snapshot", () => {
    const snapshot = snapshotFixture();

    const report = formatRunInspection(snapshot, { includeMetadata: true, includeTerminal: true });

    expect(report).toContain("codegen run task-1");
    expect(report).toContain("no_changes: replace-thinking");
    expect(report).toContain("Duration: 16m 43s");
    expect(report).toContain("Bottleneck: codex (16m 1s)");
    expect(report).toContain("Slowest spans:");
    expect(report).toContain("- 16m 1s codex (task, failed)");
    expect(report).toContain("Timeline");
    expect(report).toContain("trace info LLM call 1 (23.373s)");
    expect(report).toContain("Artifacts:");
    expect(report).toContain("artifact-prompt | prompt | Codex prompt");
    expect(report).toContain("Terminal tail");
    expect(report).toContain("codex exec");
  });

  it("selects artifacts by id, kind, name, or all", () => {
    const artifacts = snapshotFixture().artifacts;

    expect(selectArtifacts(artifacts, "artifact-prompt")).toHaveLength(1);
    expect(selectArtifacts(artifacts, "prompt")).toHaveLength(1);
    expect(selectArtifacts(artifacts, "Codex")).toHaveLength(1);
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
});

function snapshotFixture(): RunSnapshot {
  const startedAt = new Date("2026-07-01T17:40:21.000Z");
  return {
    run: {
      runId: "task-1",
      traceId: "trace-1",
      kind: "codegen",
      status: "no_changes",
      title: "replace-thinking",
      summary: "Agent task produced no diff after Codex recovery attempts.",
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
      bottleneck: { name: "codex", durationMs: 961_000 },
      links: { run: "https://tasks.example/runs/task-1" },
      metadata: {}
    },
    spans: [
      {
        id: "codex",
        source: "task",
        name: "codex",
        status: "failed",
        startedAt: new Date("2026-07-01T17:41:27.000Z"),
        completedAt: new Date("2026-07-01T17:57:28.000Z"),
        durationMs: 961_000,
        metadata: {}
      },
      {
        id: "attempt-1",
        source: "command",
        name: "codex_attempt_1",
        status: "succeeded",
        startedAt: new Date("2026-07-01T17:41:27.000Z"),
        completedAt: new Date("2026-07-01T17:49:27.000Z"),
        durationMs: 480_000,
        metadata: { command: "codex exec" }
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
        source: "trace",
        level: "info",
        name: "LLM call 1",
        summary: "Requested tool openGithubPullRequest",
        createdAt: new Date("2026-07-01T17:40:45.000Z"),
        durationMs: 23_373,
        metadata: { tools: ["openGithubPullRequest"] }
      }
    ],
    artifacts: [
      {
        artifactId: "artifact-prompt",
        runId: "task-1",
        kind: "prompt",
        name: "Codex prompt",
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
      content: "codex exec",
      entries: [
        {
          id: "terminal-1",
          source: "command",
          stream: "command",
          step: "codex_attempt_1",
          command: "codex exec",
          createdAt: new Date("2026-07-01T17:41:27.000Z"),
          content: "codex exec"
        }
      ]
    },
    diagnostics: ["codex was the bottleneck"],
    raw: { sandboxRuns: [] },
    relatedRuns: [],
    generatedAt: new Date("2026-07-01T17:57:29.000Z")
  };
}
