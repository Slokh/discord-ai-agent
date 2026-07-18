import { describe, expect, it, vi } from "vitest";
import { DiscordTaskSupervisor } from "../../src/discord/taskSupervisor.js";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

describe("DiscordTaskSupervisor", () => {
  it("drains request and maintenance work through one lifecycle", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const supervisor = new DiscordTaskSupervisor(testLogger);
    const request = supervisor.run({ kind: "request", label: "request", task: () => blocked });
    const maintenance = supervisor.run({ kind: "maintenance", label: "maintenance", task: async () => undefined });
    expect(supervisor.snapshot()).toMatchObject({ active: 2, activeByKind: { request: 1, maintenance: 1 } });
    const draining = supervisor.drain(1_000);
    release();
    await Promise.all([request, maintenance, draining]);
    expect(supervisor.snapshot()).toMatchObject({ accepting: false, active: 0 });
  });

  it("rejects every new task once draining starts", async () => {
    const supervisor = new DiscordTaskSupervisor(testLogger);
    await supervisor.drain();
    const task = vi.fn(async () => undefined);
    const rejected = vi.fn(async () => undefined);
    await supervisor.run({ kind: "request", label: "late", task, onRejected: rejected });
    expect(task).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledOnce();
  });

  it("isolates handler failures so EventEmitter listeners cannot reject globally", async () => {
    const supervisor = new DiscordTaskSupervisor(testLogger);
    await expect(supervisor.run({ kind: "request", label: "broken", task: async () => { throw new Error("boom"); } })).resolves.toBeUndefined();
    expect(supervisor.snapshot().active).toBe(0);
  });
});
