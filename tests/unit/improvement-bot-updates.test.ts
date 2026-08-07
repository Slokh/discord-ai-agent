import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import type { ImprovementBotUpdate } from "../../src/db/repositories.js";
import { renderImprovementBotUpdate, startImprovementBotUpdateNotifier } from "../../src/discord/improvementBotUpdates.js";

describe("improvement bot updates", () => {
  afterEach(() => vi.useRealTimers());

  it("renders one standalone automation incident through recovery", () => {
    expect(renderImprovementBotUpdate(update()).content).toContain("expected heartbeat is missing");
    expect(renderImprovementBotUpdate(update({ caseStatus: "in_progress" })).content).toContain("queued or in progress");
    expect(renderImprovementBotUpdate(update({
      producerTrigger: "improvement_watchdog",
      caseStatus: "verifying",
    })).content).toBe("The automated monitor for the improvement system was updated and is checking its recovery in production.");
    expect(renderImprovementBotUpdate(update({ caseStatus: "resolved" })).content).toContain("recovered");
  });

  it("posts the first alert as a standalone message in the configured bot channel", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ id: "alert-message", edit: vi.fn() }));
    const markImprovementBotUpdateRendered = vi.fn(async () => undefined);
    let reads = 0;
    const runtime = startImprovementBotUpdateNotifier({
      client: {
        isReady: () => true,
        channels: { fetch: vi.fn(async () => ({ send })) },
      } as never,
      repo: {
        listRenderableImprovementBotUpdates: vi.fn(async () => reads++ === 0 ? [update()] : []),
        markImprovementBotUpdateRendered,
        markImprovementBotUpdateDeliveryFailed: vi.fn(),
      } as never,
      config: {
        ...loadConfig(),
        discord: { ...loadConfig().discord, botChannelId: "bot-channel-test" },
      },
      pollMs: 1,
    });
    await vi.advanceTimersByTimeAsync(2);
    runtime.stop();

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("improvement reconciler"),
      allowedMentions: { parse: [] },
    }));
    expect(markImprovementBotUpdateRendered).toHaveBeenCalledWith(expect.objectContaining({
      deliveryChannelId: "bot-channel-test",
      deliveryMessageId: "alert-message",
    }));
  });
});

function update(overrides: Partial<ImprovementBotUpdate> = {}): ImprovementBotUpdate {
  return {
    updateId: "update-1",
    caseId: "case-1",
    sourceKey: "proof-producer:improvement_reconciliation:episode",
    producerTrigger: "improvement_reconciliation",
    livenessReason: "missed_sla",
    caseStatus: "open",
    caseResolution: null,
    deliveryChannelId: null,
    deliveryMessageId: null,
    lastRenderedSignature: null,
    ...overrides,
  };
}
