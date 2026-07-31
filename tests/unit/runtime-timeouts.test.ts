import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentRuntimeTimeoutError,
  isAgentRuntimeTimeoutError,
  withAgentRuntimeTimeouts,
} from "../../src/agent/runtimeTimeouts.js";

describe("agent runtime timeouts", () => {
  afterEach(() => vi.useRealTimers());

  it("returns successful work and recognizes only its timeout error type", async () => {
    await expect(withAgentRuntimeTimeouts({
      promiseFactory: async (_noteProgress, signal) => {
        expect(signal.aborted).toBe(false);
        return "done";
      },
      hardTimeoutMs: 1_000,
      label: "NanoCodex",
    })).resolves.toBe("done");

    expect(isAgentRuntimeTimeoutError(new AgentRuntimeTimeoutError("timeout"))).toBe(true);
    expect(isAgentRuntimeTimeoutError(new Error("timeout"))).toBe(false);
  });

  it("aborts work when the hard deadline expires", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = withAgentRuntimeTimeouts({
      promiseFactory: async (_noteProgress, currentSignal) => {
        signal = currentSignal;
        return new Promise<never>(() => undefined);
      },
      hardTimeoutMs: 50,
      label: "NanoCodex",
    });
    const rejection = expect(result).rejects.toThrow("NanoCodex timed out after 50ms.");

    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(isAgentRuntimeTimeoutError(signal?.reason)).toBe(true);
  });

  it("resets the silence deadline when progress arrives", async () => {
    vi.useFakeTimers();
    let noteProgress: (() => void) | undefined;
    const result = withAgentRuntimeTimeouts({
      promiseFactory: async (note) => {
        noteProgress = note;
        return new Promise<never>(() => undefined);
      },
      hardTimeoutMs: 1_000,
      silenceTimeoutMs: 40,
      label: "NanoCodex",
    });
    const rejection = expect(result).rejects.toThrow("NanoCodex was silent for 40ms.");

    await vi.advanceTimersByTimeAsync(30);
    noteProgress?.();
    await vi.advanceTimersByTimeAsync(39);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
  });
});
