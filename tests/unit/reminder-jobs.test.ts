import { describe, expect, it, vi } from "vitest";
import {
  enqueueReminderDelivery,
  registerReminderWorkers,
  REMINDER_DELIVERY_JOB,
  REMINDER_RECONCILIATION_JOB,
} from "../../src/jobs/reminderJobs.js";

describe("reminder jobs", () => {
  it("keys each series occurrence by reminder and scheduled instant", async () => {
    const send = vi.fn(async () => "job");
    const scheduledFor = new Date("2026-08-06T09:00:00Z");

    await enqueueReminderDelivery({ send } as never, "r_1", scheduledFor);

    expect(send).toHaveBeenCalledWith(REMINDER_DELIVERY_JOB, { reminderId: "r_1" }, expect.objectContaining({
      singletonKey: "r_1:2026-08-06T09:00:00.000Z",
      startAfter: scheduledFor,
    }));
  });

  it("enqueues the next occurrence returned by successful delivery", async () => {
    const workers = new Map<string, (jobs: Array<{ data: { reminderId: string } }>) => Promise<void>>();
    const send = vi.fn(async () => "job");
    const boss = {
      work: vi.fn(async (name: string, _options: unknown, worker: (jobs: Array<{ data: { reminderId: string } }>) => Promise<void>) => {
        workers.set(name, worker);
      }),
      schedule: vi.fn(async () => undefined),
      send,
    };
    const next = { reminderId: "r_1", scheduledFor: new Date("2026-08-07T09:00:00Z"), occurrenceSequence: 4 };
    const runner = {
      deliver: vi.fn(async () => next),
      listDueReminderWakeups: vi.fn(async () => []),
    };
    await registerReminderWorkers(boss as never, runner);

    await workers.get(REMINDER_DELIVERY_JOB)!([{ data: { reminderId: "r_1" } }]);

    expect(runner.deliver).toHaveBeenCalledWith("r_1");
    expect(send).toHaveBeenCalledWith(REMINDER_DELIVERY_JOB, { reminderId: "r_1" }, expect.objectContaining({
      singletonKey: "r_1:2026-08-07T09:00:00.000Z",
      startAfter: next.scheduledFor,
    }));
    expect(send).toHaveBeenCalledWith(REMINDER_RECONCILIATION_JOB, {});
  });
});
