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

  it("preserves per-thread order across a burst of concurrent turns", async () => {
    const queue = new KeyedSerialQueue();
    const completed = new Map<string, number[]>();
    const tasks = Array.from({ length: 200 }, (_, index) => {
      const key = `thread-${index % 20}`;
      const sequence = Math.floor(index / 20);
      return queue.run(key, async () => {
        await Promise.resolve();
        const values = completed.get(key) ?? [];
        values.push(sequence);
        completed.set(key, values);
      });
    });
    await Promise.all(tasks);
    for (const values of completed.values()) expect(values).toEqual(Array.from({ length: 10 }, (_, index) => index));
  });
});
