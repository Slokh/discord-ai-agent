import { describe, expect, it } from "vitest";
import {
  compactTimelineSteps,
  enrichModelRoundToolRequests,
  groupTimelineSteps,
  summedStepDuration,
  timelineStepSummaryText,
  timelineSummaryText,
  timelineTitleText,
  timelineToolRequests,
  type TimelineStep
} from "../../src/control/console/App.js";

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
