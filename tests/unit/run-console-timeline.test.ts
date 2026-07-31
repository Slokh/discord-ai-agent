import { describe, expect, it } from "vitest";
import {
  agentTranscriptFlowItems,
  relatedRunTimelineSteps,
} from "../../src/control/console/timelineCore.js";
import { codegenTimelineTrace } from "../../src/control/console/codegenTimeline.js";
import {
  compactTimelineSteps,
  enrichModelRoundToolRequests,
  groupTimelineSteps,
  summedStepDuration,
  type TimelineStep
} from "../../src/control/console/timelineModel.js";
import {
  timelineStepSummaryText,
  timelineSummaryText,
  timelineTitleText,
  timelineToolRequests
} from "../../src/control/console/timelineText.js";
import type { RunArtifact, RunEvent, RunSnapshot, RunSpan } from "../../src/control/console/types.js";

describe("run console timeline", () => {
  it("sums counted step durations instead of first-to-last wall-clock range", () => {
    expect(
      summedStepDuration([
        { durationMs: 8 },
        { durationMs: 411 },
        { durationMs: null }
      ])
    ).toBe(419);
  });

  it("treats overlapping visible rows as separate counted parts", () => {
    expect(
      summedStepDuration([
        { durationMs: 1000 },
        { durationMs: 1000 }
      ])
    ).toBe(2000);
  });

  it("hides duration-only and placeholder summaries in the timeline", () => {
    expect(timelineSummaryText("Process work took 0.411s.")).toBe("");
    expect(timelineSummaryText("Tool work took 11m 30s.")).toBe("");
    expect(timelineSummaryText("No summary recorded.")).toBe("");
    expect(timelineSummaryText("Sent Thinking reply")).toBe("");
    expect(timelineSummaryText("Thinking...")).toBe("");
    expect(timelineSummaryText("Round 1: getDiscordStats")).toBe("Round 1: getDiscordStats");
  });

  it("uses friendly display names for implementation-shaped timeline rows", () => {
    expect(timelineTitleText(timelineStep({ id: "prompt", kind: "input", title: "Discord mention received", summary: "hello", createdAt: atMs(0), durationMs: null }))).toBe("User prompt");
    expect(timelineTitleText(timelineStep({ id: "ack", kind: "response", title: "Thinking reply sent", summary: "", createdAt: atMs(0), durationMs: null }))).toBe("Acknowledgement sent");
    expect(timelineTitleText(timelineStep({ id: "memory", kind: "span", title: "Load channel memory", summary: "", createdAt: atMs(0), durationMs: 8 }))).toBe("Load conversation memory");
    expect(timelineTitleText(timelineStep({ id: "permissions", kind: "span", title: "Resolve Discord permissions", summary: "", createdAt: atMs(0), durationMs: 411 }))).toBe("Check user access");
    expect(timelineTitleText(timelineStep({ id: "model", kind: "model", title: "Agent model round complete", summary: "Round 2: no local tools", createdAt: atMs(0), durationMs: 100 }))).toBe("LLM call 2");
    expect(timelineTitleText(timelineStep({ id: "tool", kind: "tool", title: "Agent tool complete", summary: "getDiscordStats: 500 chars", createdAt: atMs(0), durationMs: 100 }))).toBe("Tool call: getDiscordStats");
    expect(timelineTitleText(timelineStep({ id: "final", kind: "response", title: "Discord final response", summary: "done", createdAt: atMs(0), durationMs: null }))).toBe("Final answer sent");
  });

  it("describes model rounds by what the LLM returned", () => {
    expect(
      timelineStepSummaryText(
        timelineStep({
          id: "model-tools",
          kind: "model",
          title: "Agent model round complete",
          summary: "Round 1: getDiscordChannelTopics, getDiscordStats, getDiscordStats",
          createdAt: atMs(0),
          durationMs: 100,
          metadata: {
            finishReason: "tool_calls",
            outputChars: 118,
            requestedToolCalls: ["getDiscordChannelTopics", "getDiscordStats", "getDiscordStats"],
            selectedLocalTools: ["getDiscordChannelTopics", "getDiscordStats", "getDiscordStats"]
          }
        })
      )
    ).toBe("Requested tools: getDiscordChannelTopics, getDiscordStats x2");
    expect(
      timelineStepSummaryText(
        timelineStep({
          id: "model-text",
          kind: "model",
          title: "Agent model round complete",
          summary: "Round 2: no local tools",
          createdAt: atMs(0),
          durationMs: 100,
          metadata: { outputChars: 248, requestedToolCalls: [], selectedLocalTools: [] }
        })
      )
    ).toBe("Returned text: 248 chars");
    expect(
      timelineStepSummaryText(
        timelineStep({
          id: "model-empty",
          kind: "model",
          title: "Agent model round complete",
          summary: "Round 2: no local tools",
          createdAt: atMs(0),
          durationMs: 100,
          metadata: { outputChars: 0, requestedToolCalls: [], selectedLocalTools: [] }
        })
      )
    ).toBe("No tool calls or text returned");
  });

  it("reads structured requested tool metadata with arguments", () => {
    const requests = timelineToolRequests(
      timelineStep({
        id: "model-tools",
        kind: "model",
        title: "Agent model round complete",
        summary: "Round 1: getDiscordStats",
        createdAt: atMs(0),
        durationMs: 100,
        metadata: {
          selectedLocalToolRequests: [
            {
              id: "call_1",
              name: "getDiscordStats",
              argumentsText: "{\"groupBy\":\"user\",\"limit\":15,\"metric\":\"messages\"}"
            }
          ],
          selectedLocalTools: ["getDiscordStats"]
        }
      })
    );

    expect(requests).toEqual([
      {
        id: "call_1",
        name: "getDiscordStats",
        argumentsText: "{\"groupBy\":\"user\",\"limit\":15,\"metric\":\"messages\"}"
      }
    ]);
  });

  it("keeps transparent server tools alongside structured local tool requests", () => {
    const requests = timelineToolRequests(
      timelineStep({
        id: "mixed-model-tools",
        kind: "model",
        title: "Agent model round complete",
        summary: "Round 1",
        createdAt: atMs(0),
        durationMs: 100,
        metadata: {
          selectedLocalToolRequests: [{ id: "call_1", name: "getDiscordStats", argumentsText: "{}" }],
          requestedToolCalls: ["getDiscordStats", "openrouter:web_search"],
        },
      }),
    );

    expect(requests).toEqual([
      { id: "call_1", name: "getDiscordStats", argumentsText: "{}" },
      { name: "openrouter:web_search" },
    ]);
  });

  it("promotes related child runs as visible timeline rows", () => {
    const steps = relatedRunTimelineSteps(
      [
        {
          runId: "task-1",
          traceId: "trace-1",
          kind: "codegen",
          status: "running",
          title: "Fix notification wording",
          summary: null,
          requester: "kartik",
          guildId: "guild-1",
          channelId: "channel-1",
          userId: "user-1",
          messageId: null,
          source: "agent_task",
          startedAt: atMs(2_000),
          completedAt: null,
          updatedAt: atMs(4_000),
          durationMs: null,
          currentStep: "codex_app_server_attempt_1",
          bottleneck: null,
          links: {},
          metadata: {}
        }
      ],
      { startedAt: atMs(0), generatedAt: atMs(7_000) }
    );

    expect(steps).toEqual([
      expect.objectContaining({
        id: "related-run-task-1",
        kind: "run",
        title: "Codegen task running",
        source: "related run",
        status: "running",
        durationMs: 5_000,
        summary: expect.stringContaining("Current step: codex_app_server_attempt_1.")
      })
    ]);
  });

  it("converts durable agent transcript messages into timeline flow rows", () => {
    const rows = agentTranscriptFlowItems({
      agentTranscript: [
        {
          id: "agent-transcript-message-1-assistant-round-1",
          sessionId: "agent-session-1",
          clientMessageId: "message-1:transcript:assistant-round-1",
          role: "assistant",
          parts: [
            {
              type: "assistant_tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "getDiscordStats",
                  arguments: { groupBy: "channel" }
                }
              ]
            }
          ],
          metadata: { source: "agent.router", round: 1 },
          createdAt: atMs(100)
        },
        {
          id: "agent-transcript-message-1-tool-call-1",
          sessionId: "agent-session-1",
          clientMessageId: "message-1:transcript:tool-call-1",
          role: "tool",
          parts: [
            {
              type: "tool_result",
              toolCallId: "call-1",
              toolName: "getDiscordStats",
              content: "top channel: alpha"
            }
          ],
          metadata: { source: "agent.router", round: 1, durationMs: 42 },
          createdAt: atMs(142)
        }
      ]
    });

    expect(rows).toEqual([
      expect.objectContaining({
        id: "agent-transcript-agent-transcript-message-1-assistant-round-1",
        kind: "model",
        title: "Assistant requested tools",
        source: "agent session",
        summary: "Requested tools: getDiscordStats",
        metadata: expect.objectContaining({
          agentTranscript: true,
          timelineToolRequests: [
            {
              id: "call-1",
              name: "getDiscordStats",
              argumentsText: "{\"groupBy\":\"channel\"}"
            }
          ]
        })
      }),
      expect.objectContaining({
        id: "agent-transcript-agent-transcript-message-1-tool-call-1",
        kind: "tool",
        title: "Tool result: getDiscordStats",
        source: "agent session",
        summary: "getDiscordStats: top channel: alpha",
        durationMs: 42
      })
    ]);
  });

  it("enriches old model rounds with requested tool args from hidden tool-start rows", () => {
    const enriched = enrichModelRoundToolRequests([
      timelineStep({
        id: "model",
        kind: "model",
        title: "Agent model round complete",
        summary: "Round 1: getDiscordChannelTopics, getDiscordStats",
        createdAt: atMs(100),
        durationStartedAt: atMs(0),
        durationMs: 100,
        source: "trace",
        metadata: {
          requestedToolCalls: ["getDiscordChannelTopics", "getDiscordStats"],
          selectedLocalTools: ["getDiscordChannelTopics", "getDiscordStats"]
        }
      }),
      timelineStep({
        id: "tool-start-1",
        kind: "tool",
        title: "Agent tool started",
        summary: "getDiscordChannelTopics",
        createdAt: atMs(101),
        durationMs: null,
        source: "trace",
        metadata: {
          toolName: "getDiscordChannelTopics",
          argumentsPreview: "{\"channelLimit\":10,\"topicsPerChannel\":3}"
        }
      }),
      timelineStep({
        id: "tool-start-2",
        kind: "tool",
        title: "Agent tool started",
        summary: "getDiscordStats",
        createdAt: atMs(102),
        durationMs: null,
        source: "trace",
        metadata: {
          toolName: "getDiscordStats",
          argumentsPreview: "{\"groupBy\":\"user\",\"limit\":15,\"metric\":\"messages\"}"
        }
      }),
      timelineStep({
        id: "tool-done-1",
        kind: "tool",
        title: "Agent tool complete",
        summary: "getDiscordChannelTopics: 500 chars",
        createdAt: atMs(300),
        durationStartedAt: atMs(101),
        durationMs: 199,
        source: "trace"
      }),
      timelineStep({
        id: "tool-done-2",
        kind: "tool",
        title: "Agent tool complete",
        summary: "getDiscordStats: 500 chars",
        createdAt: atMs(500),
        durationStartedAt: atMs(101),
        durationMs: 399,
        source: "trace"
      })
    ]);

    expect(timelineToolRequests(enriched[0]!)).toEqual([
      {
        name: "getDiscordChannelTopics",
        argumentsText: "{\"channelLimit\":10,\"topicsPerChannel\":3}"
      },
      {
        name: "getDiscordStats",
        argumentsText: "{\"groupBy\":\"user\",\"limit\":15,\"metric\":\"messages\"}"
      }
    ]);
    expect(compactTimelineSteps(enriched).map((step) => step.id)).toEqual(["model", "tool-done-1", "tool-done-2"]);
  });

  it("nests markers under the exact containing timed span instead of a nearby previous span", () => {
    const groups = groupTimelineSteps([
      timelineStep({ id: "memory", title: "Load channel memory", createdAt: atMs(0), durationStartedAt: atMs(0), durationMs: 8 }),
      timelineStep({ id: "permissions", title: "Resolve Discord permissions", createdAt: atMs(9), durationStartedAt: atMs(9), durationMs: 411 }),
      timelineStep({ id: "reply-context", title: "Discord reply context resolved", createdAt: atMs(9), durationMs: null })
    ]);

    expect(groups.find((group) => group.parent.id === "memory")?.children.map((step) => step.id)).toEqual([]);
    expect(groups.find((group) => group.parent.id === "permissions")?.children.map((step) => step.id)).toEqual(["reply-context"]);
  });

  it("keeps uncontained markers as standalone timeline groups", () => {
    const groups = groupTimelineSteps([
      timelineStep({ id: "model", title: "Agent model round complete", createdAt: atMs(1_000), durationStartedAt: atMs(1_000), durationMs: 500 }),
      timelineStep({ id: "chat", title: "Chat", createdAt: atMs(5_000), durationMs: null })
    ]);

    expect(groups.map((group) => ({ parent: group.parent.id, children: group.children.map((step) => step.id) }))).toEqual([
      { parent: "model", children: [] },
      { parent: "chat", children: [] }
    ]);
  });

  it("keeps conversation milestones top-level even when their timestamps overlap short spans", () => {
    const groups = groupTimelineSteps([
      timelineStep({ id: "memory", title: "Load channel memory", createdAt: atMs(0), durationStartedAt: atMs(0), durationMs: 8, source: "process" }),
      timelineStep({ id: "mention", kind: "input", title: "Discord mention received", createdAt: atMs(0), durationMs: null, source: "trace" }),
      timelineStep({ id: "request", title: "Agent request started", createdAt: atMs(4), durationMs: null, source: "trace" })
    ]);

    expect(groups.map((group) => ({ parent: group.parent.id, children: group.children.map((step) => step.id) }))).toEqual([
      { parent: "memory", children: [] },
      { parent: "mention", children: [] },
      { parent: "request", children: [] }
    ]);
  });

  it("removes request-start once model work gives the stronger execution marker", () => {
    const steps = compactTimelineSteps([
      timelineStep({ id: "request", title: "Agent request started", summary: "what happened here?", createdAt: atMs(0), durationMs: null, source: "trace" }),
      timelineStep({ id: "model", kind: "model", title: "Agent model round complete", summary: "Round 1: no tools", createdAt: atMs(500), durationStartedAt: atMs(0), durationMs: 500, source: "trace" })
    ]);

    expect(steps.map((step) => step.id)).toEqual(["model"]);
  });

  it("does not nest model breadcrumbs under tool spans just because the trace source matches", () => {
    const groups = groupTimelineSteps([
      timelineStep({ id: "model", title: "Agent model round complete", createdAt: atMs(0), durationStartedAt: atMs(0), durationMs: 500, source: "trace" }),
      timelineStep({ id: "tool", title: "Agent tool complete", createdAt: atMs(400), durationStartedAt: atMs(400), durationMs: 2_000, source: "trace" }),
      timelineStep({ id: "router", kind: "model", title: "Model Tool Router", createdAt: atMs(450), durationMs: null, source: "trace" })
    ]);

    expect(groups.find((group) => group.parent.id === "model")?.children.map((step) => step.id)).toEqual(["router"]);
    expect(groups.find((group) => group.parent.id === "tool")?.children.map((step) => step.id)).toEqual([]);
  });

  it("removes duplicate prompt artifacts when the mention event already shows the prompt", () => {
    const steps = compactTimelineSteps([
      timelineStep({ id: "mention", kind: "input", title: "Discord mention received", summary: "what happened here?", createdAt: atMs(0), durationMs: null, source: "trace" }),
      timelineStep({ id: "prompt", kind: "artifact", title: "Discord user prompt", summary: "what happened here?", createdAt: atMs(1), durationMs: null, source: "artifact" })
    ]);

    expect(steps.map((step) => step.id)).toEqual(["mention"]);
  });

  it("keeps the final response and removes weaker duplicate response markers", () => {
    const steps = compactTimelineSteps([
      timelineStep({ id: "synthesis", kind: "response", title: "Agent final synthesis started", summary: "empty model response after tool evidence", createdAt: atMs(0), durationMs: null, source: "trace" }),
      timelineStep({ id: "chat", kind: "tool", title: "Chat", summary: "final answer text", createdAt: atMs(1), durationMs: null, source: "tool" }),
      timelineStep({ id: "ready", kind: "response", title: "Agent response ready", summary: "Agent returned 17 chars", createdAt: atMs(2), durationMs: null, source: "trace" }),
      timelineStep({ id: "final", kind: "response", title: "Discord final response", summary: "final answer text", createdAt: atMs(3), durationMs: null, source: "artifact" })
    ]);

    expect(steps.map((step) => step.id)).toEqual(["final"]);
  });

  it("removes low-leverage model router and tool-start rows when stronger timed rows exist", () => {
    const steps = compactTimelineSteps([
      timelineStep({ id: "model", kind: "model", title: "Agent model round complete", summary: "Round 1: getDiscordStats", createdAt: atMs(0), durationStartedAt: atMs(0), durationMs: 100, source: "trace" }),
      timelineStep({ id: "router", kind: "tool", title: "Model Tool Router", summary: "getDiscordStats", createdAt: atMs(100), durationMs: null, source: "tool" }),
      timelineStep({ id: "tool-start", kind: "tool", title: "Agent tool started", summary: "getDiscordStats", createdAt: atMs(101), durationMs: null, source: "trace" }),
      timelineStep({ id: "tool-done", kind: "tool", title: "Agent tool complete", summary: "getDiscordStats: 500 chars", createdAt: atMs(500), durationStartedAt: atMs(101), durationMs: 399, source: "trace" })
    ]);

    expect(steps.map((step) => step.id)).toEqual(["model", "tool-done"]);
  });

  it("projects NanoCodex attempts and JSONL progress into the codegen timeline", () => {
    const events: RunEvent[] = [
      runEvent({ id: "tool", source: "task", name: "task.progress", summary: "NanoCodex is using apply_patch.", createdAt: atMs(2_000), metadata: { step: "nanocodex_tool_apply_patch", attempt: 1, tool: "apply_patch" } }),
      runEvent({ id: "edit", source: "task", name: "task.progress", summary: "NanoCodex made its first code edit.", createdAt: atMs(2_100), metadata: { step: "nanocodex_first_edit", attempt: 1, tool: "apply_patch" } }),
      runEvent({ id: "message", source: "task", name: "task.progress", summary: "NanoCodex said: Done.", createdAt: atMs(4_000), metadata: { step: "nanocodex_assistant_message", attempt: 1 } }),
    ];
    const spans: RunSpan[] = [
      runSpan({ id: "attempt", source: "command", name: "nanocodex_attempt_1", startedAt: atMs(1_000), completedAt: atMs(5_000), durationMs: 4_000, metadata: { command: "nanocodex run [prompt]", exitCode: 0 } }),
    ];
    const artifacts: RunArtifact[] = [
      runArtifact({ artifactId: "prompt", kind: "prompt", name: "NanoCodex prompt", createdAt: atMs(900), metadata: { attempt: 1 } }),
      runArtifact({ artifactId: "log", kind: "command_log", name: "nanocodex_attempt_1 command log", createdAt: atMs(5_000), metadata: { step: "nanocodex_attempt_1" } }),
    ];

    const trace = codegenTimelineTrace(codegenSnapshot({ events, spans, artifacts }), { events, spans, startedAt: atMs(0) });

    expect(trace?.groups.map((group) => timelineTitleText(group.parent))).toEqual(["NanoCodex attempt 1"]);
    expect(trace?.groups[0]?.children.map((child) => timelineTitleText(child))).toEqual([
      "NanoCodex prompt",
      "Tool: apply_patch",
      "First code edit made",
      "NanoCodex assistant message",
      "Command: nanocodex_attempt_1",
    ]);
  });

  it("creates a live NanoCodex attempt before its command span arrives", () => {
    const events: RunEvent[] = [
      runEvent({ id: "start", source: "task", name: "task.progress", summary: "Starting NanoCodex attempt 1/1.", createdAt: atMs(1_000), metadata: { step: "nanocodex_attempt_1", attempt: 1, command: "nanocodex-run" } }),
      runEvent({ id: "tool", source: "task", name: "task.progress", summary: "NanoCodex is using read_file.", createdAt: atMs(2_000), metadata: { step: "nanocodex_tool_read_file", attempt: 1, tool: "read_file" } }),
    ];

    const trace = codegenTimelineTrace(codegenSnapshot({ events, spans: [], generatedAt: atMs(8_000) }), { events, spans: [], startedAt: atMs(0) });

    expect(trace?.groups.map((group) => timelineTitleText(group.parent))).toEqual(["NanoCodex attempt 1"]);
    expect(trace?.groups[0]?.parent.status).toBe("running");
    expect(trace?.groups[0]?.parent.durationMs).toBe(7_000);
    expect(trace?.groups[0]?.children.map((child) => timelineTitleText(child))).toEqual(["Tool: read_file"]);
  });

});

function atMs(offsetMs: number) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, offsetMs)).toISOString();
}

function timelineStep(input: Pick<TimelineStep, "id" | "title" | "createdAt" | "durationMs"> & Partial<TimelineStep>): TimelineStep {
  return {
    kind: "event",
    summary: "",
    durationStartedAt: null,
    gapMs: null,
    offset: "+0.000s",
    source: "trace",
    status: null,
    level: null,
    metadata: {},
    ...input
  };
}

function codegenSnapshot({
  events,
  spans,
  artifacts = [],
  generatedAt = atMs(183_700)
}: {
  events: RunEvent[];
  spans: RunSpan[];
  artifacts?: RunArtifact[];
  generatedAt?: string;
}): RunSnapshot {
  return {
    run: {
      runId: "task-1",
      traceId: "trace-1",
      kind: "codegen",
      status: "no_changes",
      title: "test task",
      summary: "Agent task produced no diff.",
      requester: "kartik",
      guildId: null,
      channelId: null,
      userId: null,
      messageId: null,
      source: "agent_task",
      startedAt: atMs(24_500),
      completedAt: atMs(183_600),
      updatedAt: atMs(183_600),
      durationMs: 159_100,
      currentStep: "cleanup",
      bottleneck: null,
      links: {},
      metadata: {}
    },
    spans,
    events,
    artifacts,
    terminal: { lineCount: 0, content: "", entries: [] },
    diagnostics: [],
    raw: {},
    relatedRuns: [],
    generatedAt
  };
}

function runArtifact(input: Partial<RunArtifact> & Pick<RunArtifact, "artifactId" | "kind" | "name" | "createdAt">): RunArtifact {
  return {
    runId: "task-1",
    contentType: "text/plain",
    sizeBytes: 100,
    preview: "artifact preview",
    redacted: false,
    expiresAt: null,
    metadata: {},
    ...input
  };
}

function runEvent(input: Partial<RunEvent> & Pick<RunEvent, "id" | "name" | "summary" | "createdAt">): RunEvent {
  return {
    source: "trace",
    level: "info",
    durationMs: null,
    metadata: {},
    ...input
  };
}

function runSpan(input: Partial<RunSpan> & Pick<RunSpan, "id" | "name" | "startedAt" | "completedAt" | "durationMs">): RunSpan {
  return {
    source: "task",
    status: "succeeded",
    metadata: {},
    ...input
  };
}
