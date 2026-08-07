import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config/env.js";
import type { ServiceHeartbeatRepository } from "../../src/db/serviceHeartbeatRepository.js";
import { startServiceHeartbeat } from "../../src/runtime/serviceHeartbeat.js";

describe("startServiceHeartbeat", () => {
  it("does not delay service startup while the initial heartbeat is pending", async () => {
    let releasePulse!: () => void;
    const pendingPulse = new Promise<void>((resolve) => {
      releasePulse = resolve;
    });
    const repository = {
      pulse: vi.fn(() => pendingPulse),
      remove: vi.fn(async () => undefined),
    } as unknown as ServiceHeartbeatRepository;

    const started = startServiceHeartbeat({
      components: ["console"],
      config: { appRevision: "revision" } as AppConfig,
      repository,
    });

    const heartbeat = await Promise.race([
      started,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("startup waited for heartbeat")), 50)),
    ]);
    expect(repository.pulse).toHaveBeenCalledOnce();

    releasePulse();
    await heartbeat.stop();
    expect(repository.remove).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight pulse before removing the heartbeat", async () => {
    let releasePulse!: () => void;
    const pendingPulse = new Promise<void>((resolve) => {
      releasePulse = resolve;
    });
    const calls: string[] = [];
    const repository = {
      pulse: vi.fn(async () => {
        await pendingPulse;
        calls.push("pulse");
      }),
      remove: vi.fn(async () => {
        calls.push("remove");
      }),
    } as unknown as ServiceHeartbeatRepository;
    const heartbeat = await startServiceHeartbeat({
      components: ["api"],
      config: { appRevision: "revision" } as AppConfig,
      repository,
    });

    const stopped = heartbeat.stop();
    await Promise.resolve();
    expect(calls).toEqual([]);
    releasePulse();
    await stopped;

    expect(calls).toEqual(["pulse", "remove"]);
  });
});
