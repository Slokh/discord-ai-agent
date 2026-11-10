import { describe, expect, it } from "vitest";
import { deriveOperatorActivity, eventLabel } from "../../src/console/activity.js";

describe("operator activity story projection", () => {
  it("pins active conversations and background work as distinct stories", () => {
    const result = deriveOperatorActivity({
      executions: [{
        executionId: "execution-prompt", title: "Answer a member", status: "running",
        authorLabel: "Member A",
        requestPreview: "What changed?", latestEvent: "agent.model.call.started", hasParent: true,
        startedAt: "2026-08-06T12:00:00.000Z", updatedAt: "2026-08-06T12:02:00.000Z",
      }, {
        executionId: "execution-crawl", title: "Discord crawl", status: "running", rollupKey: "discord_crawl",
        authorLabel: "Ignored author",
        latestEvent: "background.job.started", startedAt: "2026-08-06T12:01:00.000Z", updatedAt: "2026-08-06T12:03:00.000Z",
      }],
      activity: [], deployments: [],
    });

    expect(result.active).toHaveLength(2);
    expect(result.active[0]).toMatchObject({
      id: "execution-execution-crawl", kind: "system", category: "system", title: "Discord crawl",
      tone: "active", workState: "active", authorLabel: null,
    });
    expect(result.active[0]?.technicalEvents[0]).toMatchObject({ label: "Background job started" });
    expect(result.active[1]).toMatchObject({
      id: "execution-execution-prompt", kind: "conversation", summary: "What changed?", tone: "active", hasParent: true,
      authorLabel: "Member A",
    });
  });

  it("uses the final outcome for story tone even when an intermediate event was an error", () => {
    const result = deriveOperatorActivity({
      executions: [], deployments: [],
      activity: [{
        id: "runtime-session-a", kind: "runtime", title: "Recovered conversation", status: "succeeded",
        authorLabel: "Member B",
        occurredAt: "2026-08-06T12:05:00.000Z", startedAt: "2026-08-06T12:00:00.000Z",
        durationMs: 300_000, attempts: 2, deliveryState: "delivered",
        events: [
          { id: "2", name: "agent.nanocodex.complete", level: "info", createdAt: "2026-08-06T12:05:00.000Z" },
          { id: "1", name: "agent.model.call.failed", level: "error", createdAt: "2026-08-06T12:01:00.000Z" },
        ],
      }],
    });

    expect(result.recent[0]).toMatchObject({
      kind: "conversation", category: "product", tone: "success", summary: "Reply delivered",
      latencyTone: "very_slow", authorLabel: "Member B",
    });
    expect(result.recent[0]?.technicalEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "error", label: "Model call failed" }),
    ]));
  });

  it("separates generation from authoritative Discord delivery outcomes", () => {
    const activity = [
      { id: "delivered", deliveryState: "delivered", hasParent: true },
      { id: "pending", deliveryState: "pending" },
      { id: "abandoned", deliveryState: "abandoned" },
      { id: "unobserved" },
      { id: "partial", deliveryState: "delivered", responseStatus: "partial" },
      { id: "failed", deliveryState: "delivered" },
    ].map((item, index) => ({
      ...item, kind: "runtime", title: item.id, status: item.id === "failed" ? "failed" : "succeeded",
      occurredAt: `2026-08-06T12:0${index}:00.000Z`, events: [],
    }));

    const result = deriveOperatorActivity({ executions: [], deployments: [], activity });
    const byId = new Map(result.recent.map((story) => [story.id, story]));

    expect(byId.get("delivered")).toMatchObject({ summary: "Reply delivered", tone: "success", hasParent: true });
    expect(byId.get("pending")).toMatchObject({ hasParent: false });
    expect(byId.get("pending")).toMatchObject({ summary: "Reply ready · delivery pending", tone: "warning", status: "delivery_pending" });
    expect(byId.get("abandoned")).toMatchObject({ summary: "Reply generated · delivery failed", tone: "danger", status: "delivery_failed" });
    expect(byId.get("unobserved")).toMatchObject({ summary: "Reply generated", tone: "success" });
    expect(byId.get("partial")).toMatchObject({ summary: "Partial reply delivered", tone: "warning", status: "partial" });
    expect(byId.get("failed")).toMatchObject({ summary: "Prompt failed · error delivered", tone: "danger" });
  });

  it("classifies successful background work as system activity and adds releases", () => {
    const result = deriveOperatorActivity({
      executions: [],
      activity: [{
        id: "runtime-background", kind: "runtime", title: "Embedding batch", status: "succeeded",
        occurredAt: "2026-08-06T12:02:00.000Z", events: [
          { id: "1", name: "background.job.started", level: "info", createdAt: "2026-08-06T12:00:00.000Z" },
        ],
      }],
      deployments: [{ deploymentId: "deploy-a", revision: "abcdef123456", verifiedAt: "2026-08-06T12:03:00.000Z" }],
    });

    expect(result.recent[0]).toMatchObject({ kind: "release", title: "Release abcdef1234", tone: "success" });
    expect(result.recent[1]).toMatchObject({ kind: "system", category: "system", summary: "Background work completed" });
  });

  it("keeps every release supplied by the three-day repository window", () => {
    const deployments = Array.from({ length: 5 }, (_, index) => ({
      deploymentId: `deploy-${index}`,
      revision: `revision-${index}`,
      verifiedAt: `2026-08-0${index + 1}T12:00:00.000Z`,
    }));

    const result = deriveOperatorActivity({ executions: [], activity: [], deployments });

    expect(result.recent.filter((story) => story.kind === "release")).toHaveLength(5);
  });

  it("replaces embedding job rollups with every concrete recent message", () => {
    const result = deriveOperatorActivity({
      executions: [], deployments: [],
      messages: [
        {
          id: "message-b", preview: "Newest retained Discord message", embedded: true,
          createdAt: "2026-08-06T12:05:00.000Z",
          sourceUrl: "https://discord.com/channels/guild/channel/message-b",
        },
        {
          id: "message-a", preview: "Another retained Discord message", embedded: false,
          createdAt: "2026-08-06T12:04:00.000Z",
          sourceUrl: "https://discord.com/channels/guild/channel/message-a",
        },
        {
          id: "message-skipped", preview: "A bot-directed message", embedded: false,
          embeddingSkipReason: "agent_interaction", createdAt: "2026-08-06T12:03:30.000Z",
        },
      ],
      activity: [
        { id: "embed-1", kind: "system", title: "Embedding batch", rollupKey: "embedding", status: "succeeded", durationMs: 10_000, occurredAt: "2026-08-06T12:03:00.000Z", events: [] },
        { id: "embed-2", kind: "system", title: "Embedding batch", rollupKey: "embedding", status: "succeeded", durationMs: 30_000, occurredAt: "2026-08-06T12:02:00.000Z", events: [] },
        { id: "embed-failed", kind: "system", title: "Embedding batch", rollupKey: "embedding", status: "failed", durationMs: 5_000, occurredAt: "2026-08-06T12:01:00.000Z", events: [] },
      ],
    });

    expect(result.recent).toHaveLength(3);
    expect(result.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "message-message-b", kind: "message", title: "Newest retained Discord message",
        status: "embedded", tone: "success", workState: "terminal",
      }),
      expect.objectContaining({
        id: "message-message-a", kind: "message", title: "Another retained Discord message",
        status: "embedding_pending", tone: "warning", workState: "waiting",
      }),
      expect.objectContaining({
        id: "message-message-skipped", status: "embedding_skipped", tone: "neutral",
        workState: "terminal", summary: "Agent interaction · embedding not needed",
      }),
    ]));
    expect(JSON.stringify(result)).not.toContain("Embedding jobs");
  });

  it("keeps every eligible story instead of applying a final category ceiling", () => {
    const conversations = Array.from({ length: 55 }, (_, index) => ({
      id: `conversation-${index}`, kind: "runtime", title: `Prompt ${index}`, status: "succeeded",
      occurredAt: new Date(Date.UTC(2026, 7, 6, 12, index)).toISOString(), events: [],
    }));
    const system = Array.from({ length: 25 }, (_, index) => ({
      id: `system-${index}`, kind: "system", title: `System job ${index}`, status: "succeeded",
      rollupKey: `job-${index}`, occurredAt: new Date(Date.UTC(2026, 7, 6, 11, index)).toISOString(), events: [],
    }));

    const result = deriveOperatorActivity({ executions: [], deployments: [], activity: [...conversations, ...system] });

    expect(result.recent).toHaveLength(80);
    expect(result.recent.filter((story) => story.kind === "conversation")).toHaveLength(55);
    expect(result.recent.filter((story) => story.kind === "system")).toHaveLength(25);
  });

  it("turns implementation event names into operator language", () => {
    expect(eventLabel("discord.delivery.intent_stored")).toBe("Delivery queued");
    expect(eventLabel("background.job.failed")).toBe("Background job failed");
  });
});
