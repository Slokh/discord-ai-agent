import { describe, expect, it } from "vitest";
import { KeyedSerialQueue } from "../../src/jobs/queue.js";

describe("keyed prompt concurrency", () => {
  it("serializes one Discord thread while allowing different threads to overlap", async () => {
    const queue = new KeyedSerialQueue();
    const active = new Set<string>();
    let sameKeyOverlap = false;
    let crossKeyOverlap = false;
    const run = (key: string) => queue.run(key, async () => {
      if (active.has(key)) sameKeyOverlap = true;
      if ([...active].some((activeKey) => activeKey !== key)) crossKeyOverlap = true;
      active.add(key);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active.delete(key);
    });
    await Promise.all([run("thread-a"), run("thread-a"), run("thread-b")]);
    expect(sameKeyOverlap).toBe(false);
    expect(crossKeyOverlap).toBe(true);
  });
});
