import { describe, expect, it } from "vitest";
import { buildReminderRecurrence, formatReminderRecurrence, nextReminderOccurrence } from "../../src/reminders/recurrence.js";

describe("reminder recurrence", () => {
  it("advances daily wall-clock time across daylight-saving changes", () => {
    const recurrence = buildReminderRecurrence(
      { frequency: "daily", localTime: "09:00" },
      "America/New_York",
      new Date("2026-03-07T14:00:00Z"),
    );

    expect(nextReminderOccurrence(recurrence, "America/New_York", new Date("2026-03-07T14:01:00Z"), new Date("2026-03-07T14:00:00Z")))
      .toEqual(new Date("2026-03-08T13:00:00Z"));
  });

  it("uses only the first matching instant during a repeated fall-back hour", () => {
    const recurrence = buildReminderRecurrence(
      { frequency: "daily", localTime: "01:30" },
      "America/New_York",
      new Date("2026-10-31T05:30:00Z"),
    );

    expect(nextReminderOccurrence(recurrence, "America/New_York", new Date("2026-10-31T05:31:00Z"), new Date("2026-10-31T05:30:00Z")))
      .toEqual(new Date("2026-11-01T05:30:00Z"));
  });

  it("moves a nonexistent spring-forward time to the first valid local minute", () => {
    const recurrence = buildReminderRecurrence(
      { frequency: "daily", localTime: "02:30" },
      "America/New_York",
      new Date("2026-03-07T07:30:00Z"),
    );

    expect(nextReminderOccurrence(recurrence, "America/New_York", new Date("2026-03-07T07:31:00Z"), new Date("2026-03-07T07:30:00Z")))
      .toEqual(new Date("2026-03-08T07:00:00Z"));
  });

  it("collapses missed weekly occurrences into one future occurrence", () => {
    const recurrence = buildReminderRecurrence(
      { frequency: "weekly", interval: 1, localTime: "09:00", weekdays: ["monday", "friday"] },
      "UTC",
      new Date("2026-08-07T09:00:00Z"),
    );

    expect(nextReminderOccurrence(recurrence, "UTC", new Date("2026-08-20T12:00:00Z"), new Date("2026-08-07T09:00:00Z")))
      .toEqual(new Date("2026-08-21T09:00:00Z"));
    expect(formatReminderRecurrence(recurrence)).toBe("weekly on Monday, Friday at 09:00");
  });

  it("skips months that do not contain the requested day", () => {
    const recurrence = buildReminderRecurrence(
      { frequency: "monthly", localTime: "10:00", dayOfMonth: 31 },
      "UTC",
      new Date("2026-01-31T10:00:00Z"),
    );

    expect(nextReminderOccurrence(recurrence, "UTC", new Date("2026-01-31T10:01:00Z"), new Date("2026-01-31T10:00:00Z")))
      .toEqual(new Date("2026-03-31T10:00:00Z"));
  });

  it("rejects a first occurrence that disagrees with its recurrence rule", () => {
    expect(() => buildReminderRecurrence(
      { frequency: "weekly", localTime: "09:00", weekdays: ["monday"] },
      "UTC",
      new Date("2026-08-07T09:00:00Z"),
    )).toThrow(/include the first occurrence/);
  });
});
