import { describe, expect, it, vi } from "vitest";
import { appendTempoTransactionFooter, paymentRecorder } from "../../src/tools/paymentToolContext.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("payment tool context", () => {
  it.each([
    ["mainnet", "https://explore.tempo.xyz"],
    ["moderato", "https://explore.testnet.tempo.xyz"]
  ] as const)("adds a network-aware transaction footer for %s", async (network, explorer) => {
    const transactionHash = `0x${"a".repeat(64)}`;
    const recordTraceEvent = vi.fn(async () => undefined);
    const ctx = context(network, recordTraceEvent);
    const record = paymentRecorder(ctx);

    await record({
      eventName: "wallet.transfer.confirmed",
      summary: "Confirmed game settlement transfer",
      metadata: { transactionHash }
    });
    await record({
      eventName: "wallet.transfer.confirmed",
      summary: "Repeated event",
      metadata: { transactionHash }
    });

    expect(ctx.footerLines).toEqual([
      `💸 [transaction 0xaaaaaa…aaaaaa](${explorer}/tx/${transactionHash})`
    ]);
    expect(recordTraceEvent).toHaveBeenCalledTimes(2);
  });

  it("ignores metadata that is not a complete Tempo transaction hash", () => {
    const ctx = context("mainnet", vi.fn(async () => undefined));

    appendTempoTransactionFooter(ctx, "0xabc");
    appendTempoTransactionFooter(ctx, undefined);

    expect(ctx.footerLines).toEqual([]);
  });
});

function context(network: "mainnet" | "moderato", recordTraceEvent: ReturnType<typeof vi.fn>): ToolContext {
  return {
    config: { payments: { tempoNetwork: network } },
    repo: { recordTraceEvent },
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: ["channel"],
    requestId: "request",
    requestMessageId: "message",
    footerLines: []
  } as unknown as ToolContext;
}
