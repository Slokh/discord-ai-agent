import { describe, expect, it } from "vitest";
import {
  agentTranscriptFlowItems,
  codegenTimelineTrace,
  compactTimelineSteps,
  enrichModelRoundToolRequests,
  groupTimelineSteps,
  relatedRunTimelineSteps,
  summedStepDuration,
  timelineStepSummaryText,
  timelineSummaryText,
  timelineTitleText,
  timelineToolRequests,
  type TimelineStep
} from "../../src/control/console/App.js";
import { parseCodexTranscript } from "../../src/control/console/codexTranscript.js";
import type { RunArtifact, RunEvent, RunSnapshot, RunSpan } from "../../src/control/console/types.js";
import { parseOpenCodeTranscript } from "../../src/observability/openCodeTranscript.js";

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

  it("turns codegen no-diff runs into a concise human timeline", () => {
    const events: RunEvent[] = [
      runEvent({ id: "mention", name: "discord.mention.received", summary: "please open a PR", createdAt: atMs(0) }),
      runEvent({
        id: "model",
        name: "agent.model.round.complete",
        summary: "Round 1: runCodingAgent",
        createdAt: atMs(24_380),
        durationMs: 24_380,
        metadata: { selectedLocalTools: ["runCodingAgent"] }
      }),
      runEvent({
        id: "tool",
        name: "agent.tool.complete",
        summary: "runCodingAgent: 203 chars",
        createdAt: atMs(24_929),
        durationMs: 549,
        metadata: { toolName: "runCodingAgent" }
      }),
      runEvent({
        id: "tool-result",
        source: "tool",
        name: "runCodingAgent",
        summary: "{\"taskId\":\"task-1\",\"jobId\":\"job-1\"}",
        createdAt: atMs(24_927)
      }),
      runEvent({ id: "sandbox", source: "task", name: "task.progress", summary: "Sandbox process started.", createdAt: atMs(28_460), durationMs: 1063, metadata: { step: "sandbox_acquired" } }),
      runEvent({ id: "reasoning-1", source: "task", name: "task.progress", summary: "Codex started reasoning.", createdAt: atMs(72_000), metadata: { step: "codex_app_server_item_started", attempt: 1 } }),
      runEvent({
        id: "no-diff-1",
        source: "task",
        name: "task.progress",
        summary: "Codex app-server attempt 1 finished without a code diff.",
        createdAt: atMs(152_101),
        durationMs: 90_101,
        metadata: { step: "codex_app_server_attempt_1_no_diff", attempt: 1, exitCode: 143, gitStatus: "", notificationCount: 135 }
      }),
      runEvent({
        id: "no-diff-2",
        source: "task",
        name: "task.progress",
        summary: "Codex app-server attempt 2 finished without a code diff.",
        createdAt: atMs(212_280),
        durationMs: 60_080,
        metadata: { step: "codex_app_server_attempt_2_no_diff", attempt: 2, exitCode: 143, gitStatus: "", notificationCount: 530 }
      }),
      runEvent({ id: "cleanup", source: "task", name: "task.progress", summary: "Cleaning up the ephemeral sandbox checkout.", createdAt: atMs(212_300), metadata: { step: "cleanup" } }),
      runEvent({
        id: "completed",
        source: "task",
        level: "error",
        name: "task.completed",
        summary: "Agent task produced no diff after Codex app-server recovery attempts; no PR will be opened.",
        createdAt: atMs(213_600)
      })
    ];
    const spans: RunSpan[] = [
      runSpan({ id: "repo", name: "repo", startedAt: atMs(29_000), completedAt: atMs(29_474), durationMs: 474 }),
      runSpan({ id: "dependencies", name: "dependencies", startedAt: atMs(29_500), completedAt: atMs(61_340), durationMs: 31_840 }),
      runSpan({ id: "toolShims", name: "toolShims", startedAt: atMs(61_350), completedAt: atMs(61_362), durationMs: 12 }),
      runSpan({ id: "context", name: "context", startedAt: atMs(61_400), completedAt: atMs(61_519), durationMs: 119 }),
      runSpan({ id: "attempt-1", source: "command", name: "codex_app_server_attempt_1", status: "failed", startedAt: atMs(62_000), completedAt: atMs(152_101), durationMs: 90_101, metadata: { command: "codex app-server --listen stdio://", exitCode: 143 } }),
      runSpan({ id: "attempt-2", source: "command", name: "codex_app_server_attempt_2", status: "failed", startedAt: atMs(152_200), completedAt: atMs(212_280), durationMs: 60_080, metadata: { command: "codex app-server --listen stdio://", exitCode: 143 } })
    ];
    const artifacts: RunArtifact[] = [
      runArtifact({ artifactId: "repo-log", kind: "command_log", name: "repo_seed command log", createdAt: atMs(29_474), metadata: { step: "repo_seed" } }),
      runArtifact({ artifactId: "dependency-log", kind: "command_log", name: "dependencies command log", createdAt: atMs(61_340), metadata: { step: "dependencies" } }),
      runArtifact({ artifactId: "context", kind: "diagnostic", name: "Codegen request context", createdAt: atMs(61_520), preview: "Concrete request anchors..." }),
      runArtifact({ artifactId: "prompt-1", kind: "prompt", name: "Codex app-server prompt", createdAt: atMs(61_990), metadata: { attempt: 1 } }),
      runArtifact({ artifactId: "transcript-1", kind: "command_log", name: "Codex app-server attempt 1 transcript", createdAt: atMs(152_120) }),
      runArtifact({ artifactId: "prompt-2", kind: "prompt", name: "Codex app-server recovery prompt 2", createdAt: atMs(152_190), metadata: { attempt: 2 } }),
      runArtifact({ artifactId: "transcript-2", kind: "command_log", name: "Codex app-server attempt 2 transcript", createdAt: atMs(212_300) }),
      runArtifact({ artifactId: "diagnosis", kind: "diagnostic", name: "Codegen failure diagnosis", createdAt: atMs(213_590), preview: "Codex finished but left the repository with no code diff." })
    ];

    const trace = codegenTimelineTrace(codegenSnapshot({ events, spans, artifacts }), { events, spans, startedAt: atMs(0) });

    expect(trace?.groups.map((group) => timelineTitleText(group.parent))).toEqual([
      "User prompt",
      "Model chose code update",
      "Codegen task queued",
      "Sandbox process started",
      "Repository prepared",
      "Dependencies installed",
      "Helper tools installed",
      "Codegen context built",
      "Codex attempt 1",
      "Codex attempt 2",
      "Cleanup started",
      "No PR opened"
    ]);
    expect(trace?.groups.find((group) => timelineTitleText(group.parent) === "Repository prepared")?.children.map((child) => timelineTitleText(child))).toEqual([
      "Command: repo_seed"
    ]);
    expect(trace?.groups.find((group) => timelineTitleText(group.parent) === "Dependencies installed")?.children.map((child) => timelineTitleText(child))).toEqual([
      "Command: dependencies"
    ]);
    expect(trace?.groups.find((group) => timelineTitleText(group.parent) === "Codegen context built")?.children.map((child) => timelineTitleText(child))).toEqual([
      "Codegen request context"
    ]);
    expect(trace?.groups.find((group) => timelineTitleText(group.parent) === "Codex attempt 1")?.children.map((child) => timelineTitleText(child))).toEqual([
      "Codex app-server prompt",
      "Model started reasoning",
      "Attempt ended with no diff",
      "Codex app-server attempt 1 transcript"
    ]);
    expect(trace?.groups.find((group) => timelineTitleText(group.parent) === "No PR opened")?.children.map((child) => timelineTitleText(child))).toEqual([
      "Codegen failure diagnosis"
    ]);
    expect(trace?.durationMs).toBe(208_618);
    expect(trace?.slowest).toEqual({ name: "Codex attempt 1", durationMs: 90_101 });
  });

  it("keeps OpenCode attempt timelines focused on activity instead of lifecycle noise", () => {
    const events: RunEvent[] = [
      runEvent({ id: "round", source: "task", name: "task.progress", summary: "OpenCode started round 1.", createdAt: atMs(2_000), metadata: { step: "opencode_round_started", attempt: 1, round: 1 } }),
      runEvent({ id: "tool", source: "task", name: "task.progress", summary: "OpenCode is reading src/discord/client.ts.", createdAt: atMs(3_000), metadata: { step: "opencode_tool_read", attempt: 1, tool: "read", title: "src/discord/client.ts" } }),
      runEvent({ id: "round-finished", source: "task", name: "task.progress", summary: "OpenCode finished round 1 after read.", createdAt: atMs(5_000), metadata: { step: "opencode_round_finished", attempt: 1, round: 1, tools: ["read"] } }),
      runEvent({
        id: "no-diff",
        source: "task",
        name: "task.progress",
        summary: "OpenCode attempt 1 finished without a code diff.",
        createdAt: atMs(11_000),
        metadata: { step: "opencode_attempt_1_no_diff", attempt: 1, exitCode: 0, gitStatus: "" }
      })
    ];
    const spans: RunSpan[] = [
      runSpan({
        id: "attempt",
        source: "command",
        name: "opencode_attempt_1",
        status: "failed",
        startedAt: atMs(1_000),
        completedAt: atMs(11_000),
        durationMs: 10_000,
        metadata: { command: "opencode run --attach http://127.0.0.1:4123 [prompt]", exitCode: 0 }
      })
    ];

    const artifacts: RunArtifact[] = [
      runArtifact({
        artifactId: "opencode-log",
        kind: "command_log",
        name: "opencode_attempt_1 command log",
        createdAt: atMs(12_000),
        metadata: { step: "opencode_attempt_1" }
      })
    ];

    const trace = codegenTimelineTrace(codegenSnapshot({ events, spans, artifacts }), { events, spans, startedAt: atMs(0) });

    expect(trace?.groups.map((group) => timelineTitleText(group.parent))).toEqual(["OpenCode attempt 1"]);
    expect(trace?.groups[0]?.children.map((child) => timelineTitleText(child))).toEqual([
      "Attempt ended with no diff",
      "OpenCode activity"
    ]);
    expect(trace?.slowest).toEqual({ name: "OpenCode attempt 1", durationMs: 10_000 });
  });

  it("keeps live OpenCode tool progress visible until the activity artifact exists", () => {
    const events: RunEvent[] = [
      runEvent({ id: "round", source: "task", name: "task.progress", summary: "OpenCode started round 1.", createdAt: atMs(2_000), metadata: { step: "opencode_round_started", attempt: 1, round: 1 } }),
      runEvent({ id: "tool", source: "task", name: "task.progress", summary: "OpenCode is reading src/discord/client.ts.", createdAt: atMs(3_000), metadata: { step: "opencode_tool_read", attempt: 1, tool: "read", title: "src/discord/client.ts" } }),
      runEvent({ id: "round-finished", source: "task", name: "task.progress", summary: "OpenCode finished round 1 after read.", createdAt: atMs(5_000), metadata: { step: "opencode_round_finished", attempt: 1, round: 1, tools: ["read"] } })
    ];
    const spans: RunSpan[] = [
      runSpan({
        id: "attempt",
        source: "command",
        name: "opencode_attempt_1",
        status: "running",
        startedAt: atMs(1_000),
        completedAt: null,
        durationMs: 10_000,
        metadata: { command: "opencode run --attach http://127.0.0.1:4123 [prompt]" }
      })
    ];

    const trace = codegenTimelineTrace(codegenSnapshot({ events, spans, artifacts: [] }), { events, spans, startedAt: atMs(0) });

    expect(trace?.groups[0]?.children.map((child) => timelineTitleText(child))).toEqual(["Round 1: read"]);
  });

  it("creates a live OpenCode attempt from start progress before the command span exists", () => {
    const events: RunEvent[] = [
      runEvent({
        id: "attempt-start",
        source: "task",
        name: "task.progress",
        summary: "Starting OpenCode server attempt 1/1.",
        createdAt: atMs(1_000),
        metadata: { step: "opencode_attempt_1", attempt: 1, command: "opencode-run", harness: "opencode-server" }
      }),
      runEvent({
        id: "attempt-start-duplicate",
        source: "trace",
        name: "task.progress",
        summary: "Starting OpenCode server attempt 1/1.",
        createdAt: atMs(1_005),
        metadata: { step: "opencode_attempt_1", attempt: 1, command: "opencode-run", harness: "opencode-server" }
      }),
      runEvent({ id: "round", source: "task", name: "task.progress", summary: "OpenCode started round 1.", createdAt: atMs(2_000), metadata: { step: "opencode_round_started", attempt: 1, round: 1 } }),
      runEvent({ id: "tool", source: "task", name: "task.progress", summary: "OpenCode is reading src/discord/client.ts.", createdAt: atMs(3_000), metadata: { step: "opencode_tool_read", attempt: 1, tool: "read", title: "src/discord/client.ts" } }),
      runEvent({
        id: "attempt-activity",
        source: "process",
        name: "task.progress",
        summary: "opencode_attempt_1 is still running after 30s.",
        createdAt: atMs(31_000),
        metadata: { step: "opencode_attempt_1_activity", attempt: 1, durationMs: 30_000 }
      })
    ];

    const trace = codegenTimelineTrace(codegenSnapshot({ events, spans: [], artifacts: [], generatedAt: atMs(8_000) }), { events, spans: [], startedAt: atMs(0) });

    expect(trace?.groups.map((group) => timelineTitleText(group.parent))).toEqual(["OpenCode attempt 1"]);
    expect(trace?.groups[0]?.parent.status).toBe("running");
    expect(trace?.groups[0]?.parent.durationMs).toBe(7_000);
    expect(trace?.groups[0]?.children.map((child) => timelineTitleText(child))).toEqual(["Round 1: read"]);
    expect(trace?.groups[0]?.children[0]?.status).toBe("running");
    expect(trace?.groups[0]?.children[0]?.durationMs).toBe(6_000);
  });

  it("formats OpenCode command logs into model-round breakdowns", () => {
    const transcript = parseOpenCodeTranscript(
      [
        "$ opencode run --attach http://127.0.0.1:4123 --model openrouter/z-ai/glm-5.2 [prompt]",
        JSON.stringify({ type: "step_start", timestamp: Date.parse(atMs(0)), part: {} }),
        JSON.stringify({
          type: "tool_use",
          timestamp: Date.parse(atMs(5_000)),
          part: {
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/repo/src/discord/client.ts" },
              output: "file content",
              time: { start: Date.parse(atMs(5_000)), end: Date.parse(atMs(5_025)) }
            }
          }
        }),
        JSON.stringify({
          type: "step_finish",
          timestamp: Date.parse(atMs(10_000)),
          part: { reason: "tool-calls", tokens: { total: 100, input: 80, reasoning: 10, cache: { read: 0 } } }
        }),
        JSON.stringify({ type: "step_start", timestamp: Date.parse(atMs(12_000)), part: {} }),
        JSON.stringify({
          type: "text",
          timestamp: Date.parse(atMs(13_000)),
          part: { text: "I have enough context. Making the edit." }
        }),
        JSON.stringify({
          type: "tool_use",
          timestamp: Date.parse(atMs(14_000)),
          part: {
            tool: "edit",
            state: {
              status: "completed",
              input: { filePath: "/repo/src/discord/client.ts" },
              output: "Edit applied successfully.",
              time: { start: Date.parse(atMs(14_000)), end: Date.parse(atMs(14_011)) }
            }
          }
        }),
        JSON.stringify({
          type: "step_finish",
          timestamp: Date.parse(atMs(20_000)),
          part: { reason: "tool-calls", tokens: { total: 220, input: 90, reasoning: 20, cache: { read: 50 } } }
        })
      ].join("\n")
    );

    expect(transcript.isTranscript).toBe(true);
    expect(transcript.rounds).toBe(2);
    expect(transcript.toolCalls).toBe(2);
    expect(transcript.totalDurationMs).toBe(20_000);
    expect(transcript.toolDurationMs).toBe(36);
    expect(transcript.modelWaitMs).toBe(17_964);
    expect(transcript.roundDurationMs).toBe(18_000);
    expect(transcript.interRoundGapMs).toBe(2_000);
    expect(transcript.outsideRoundMs).toBe(0);
    expect(transcript.slowestGaps).toEqual([{ afterRound: 1, beforeRound: 2, durationMs: 2_000 }]);
    expect(transcript.failedTools).toBe(0);
    expect(transcript.repeatedReads).toEqual([]);
    expect(transcript.firstToolAtMs).toBe(5_000);
    expect(transcript.firstEditAtMs).toBe(14_000);
    expect(transcript.firstEditRound).toBe(2);
    expect(transcript.roundsBeforeFirstEdit).toBe(1);
    expect(transcript.tokenTotal).toBe(220);
    expect(transcript.slowestRound).toEqual({ round: 1, durationMs: 10_000, title: "Round 1: read" });
    expect(transcript.items.map((item) => item.title)).toEqual(["Round 1: read", "Round 2: edit", "Final token usage"]);
    expect(transcript.items[1]?.gapBeforeMs).toBe(2_000);
    expect(transcript.items[1]?.modelWaitMs).toBe(7_989);
    expect(transcript.items[1]?.toolDurationMs).toBe(11);
    expect(transcript.items[1]?.body).toContain("Making the edit");
    expect(transcript.items[1]?.body).not.toContain("Model wait:");
    expect(transcript.items[1]?.body).not.toContain("Tool time:");
  });

  it("keeps unfinished OpenCode rounds visible while the harness is still running", () => {
    const transcript = parseOpenCodeTranscript(
      [
        "$ opencode run --model openrouter/z-ai/glm-5.2 [prompt]",
        JSON.stringify({ type: "step_start", timestamp: Date.parse(atMs(0)), part: {} }),
        JSON.stringify({
          type: "tool_use",
          timestamp: Date.parse(atMs(5_000)),
          part: {
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/repo/src/execution/sandboxRunner.ts" },
              time: { start: Date.parse(atMs(5_000)), end: Date.parse(atMs(5_020)) }
            }
          }
        })
      ].join("\n")
    );

    expect(transcript.isTranscript).toBe(true);
    expect(transcript.rounds).toBe(1);
    expect(transcript.toolCalls).toBe(1);
    expect(transcript.totalDurationMs).toBe(5_000);
    expect(transcript.toolDurationMs).toBe(20);
    expect(transcript.modelWaitMs).toBe(4_980);
    expect(transcript.roundDurationMs).toBe(5_000);
    expect(transcript.outsideRoundMs).toBe(0);
    expect(transcript.firstToolAtMs).toBe(5_000);
    expect(transcript.activeRound).toEqual({
      round: 1,
      durationMs: 5_000,
      tools: ["read"],
      lastEventAt: atMs(5_000)
    });
    expect(transcript.items.some((item) => item.active)).toBe(true);
    const activeItem = transcript.items.find((item) => item.active);
    expect(activeItem?.title).toBe("Round 1: read");
    expect(activeItem?.durationMs).toBe(5_000);
    expect(activeItem?.modelWaitMs).toBe(4_980);
    expect(activeItem?.toolDurationMs).toBe(20);
    expect(activeItem?.tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("does not mark any opencode round active once the last round finished", () => {
    const transcript = parseOpenCodeTranscript(
      [
        "$ opencode run --model openrouter/z-ai/glm-5.2 [prompt]",
        JSON.stringify({ type: "step_start", timestamp: Date.parse(atMs(0)), part: {} }),
        JSON.stringify({
          type: "tool_use",
          timestamp: Date.parse(atMs(5_000)),
          part: {
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/repo/src/execution/sandboxRunner.ts" },
              time: { start: Date.parse(atMs(5_000)), end: Date.parse(atMs(5_020)) }
            }
          }
        }),
        JSON.stringify({ type: "step_finish", timestamp: Date.parse(atMs(9_000)), part: { reason: "tool-calls" } })
      ].join("\n")
    );

    expect(transcript.activeRound).toBeNull();
    expect(transcript.items.some((item) => item.active)).toBe(false);
  });

  it("formats Codex app-server transcripts into high-signal items", () => {
    const transcript = parseCodexTranscript(
      [
        "$ codex app-server --listen stdio://",
        JSON.stringify({
          timestamp: atMs(0),
          method: "thread/started",
          message: "Codex notification: thread/started.",
          metadata: { paramsPreview: JSON.stringify({ thread: { modelProvider: "openrouter", cwd: "/repo" } }) }
        }),
        JSON.stringify({
          timestamp: atMs(10),
          method: "warning",
          message: "Codex notification: warning.",
          metadata: { paramsPreview: JSON.stringify({ message: "Model metadata missing." }) }
        }),
        JSON.stringify({
          timestamp: atMs(20),
          method: "item/reasoning/textDelta",
          message: "Codex notification: item/reasoning/textDelta.",
          metadata: { paramsPreview: JSON.stringify({ delta: "thinking" }) }
        }),
        JSON.stringify({
          timestamp: atMs(30),
          method: "item/completed",
          message: "Codex completed agentMessage.",
          metadata: { itemType: "agentMessage", paramsPreview: JSON.stringify({ item: { type: "agentMessage", text: "I'll inspect the files." } }) }
        }),
        JSON.stringify({
          timestamp: atMs(35),
          method: "item/started",
          message: "Codex started commandExecution.",
          metadata: {
            itemType: "commandExecution",
            itemId: "call_1",
            paramsPreview: JSON.stringify({
              item: {
                type: "commandExecution",
                id: "call_1",
                command: "/bin/bash -lc \"rg Thinking src\"",
                status: "inProgress",
                commandActions: [{ type: "search", command: "rg Thinking src", name: "src" }]
              }
            })
          }
        }),
        JSON.stringify({
          timestamp: atMs(40),
          method: "item/completed",
          message: "Codex completed commandExecution.",
          metadata: {
            itemType: "commandExecution",
            itemId: "call_1",
            paramsPreview:
              '{"item":{"type":"commandExecution","id":"call_1","command":"/bin/bash -lc \\"rg Thinking src\\"","status":"completed","aggregatedOutput":"src/discord/client.ts:42: Thinking...'
          }
        }),
        JSON.stringify({
          timestamp: atMs(50),
          method: "thread/tokenUsage/updated",
          message: "Codex token usage updated.",
          metadata: { paramsPreview: JSON.stringify({ tokenUsage: { total: { totalTokens: 1000, cachedInputTokens: 100, outputTokens: 20 } } }) }
        }),
        "stderr:",
        "warning line",
        "error:",
        "Codex app-server exited before completing pending requests.",
        "[exit 143 in 90s]"
      ].join("\n")
    );

    expect(transcript.isTranscript).toBe(true);
    expect(transcript.agentMessages).toBe(1);
    expect(transcript.commands).toBe(1);
    expect(transcript.reasoningDeltaCount).toBe(1);
    expect(transcript.tokenTotal).toBe(1000);
    expect(transcript.items.map((item) => item.title)).toEqual([
      "App-server launched",
      "Thread started",
      "Warning",
      "Reasoning stream",
      "Assistant message 1",
      "Command 1",
      "Codex stderr",
      "App-server closed",
      "Final token usage"
    ]);
    const command = transcript.items.find((item) => item.title === "Command 1");
    expect(command?.body).toContain("Duration: 0.005s");
    expect(command?.body).toContain("search src");
    expect(command?.output).toContain("client.ts");
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
