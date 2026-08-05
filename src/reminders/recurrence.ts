export const REMINDER_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export type ReminderWeekday = (typeof REMINDER_WEEKDAYS)[number];
export type ReminderRecurrenceFrequency = "daily" | "weekly" | "monthly";

export type ReminderRecurrence = {
  frequency: ReminderRecurrenceFrequency;
  interval: number;
  localTime: string;
  anchorDate: string;
  weekdays?: number[];
  dayOfMonth?: number;
};

export type ReminderRecurrenceInput = {
  frequency?: string;
  interval?: number;
  localTime?: string;
  weekdays?: string[];
  dayOfMonth?: number;
};

export class ReminderRecurrenceValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function buildReminderRecurrence(
  input: ReminderRecurrenceInput,
  timezone: string,
  scheduledFor: Date,
): ReminderRecurrence {
  const frequency = normalizeFrequency(input.frequency);
  const interval = input.interval ?? 1;
  const localTime = input.localTime?.trim();
  if (!frequency) throw invalid("reminder_recurrence_frequency_invalid", "Use daily, weekly, or monthly recurrence.");
  if (!Number.isInteger(interval) || interval < 1 || interval > 366) {
    throw invalid("reminder_recurrence_interval_invalid", "The recurrence interval must be a whole number from 1 to 366.");
  }
  if (!localTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    throw invalid("reminder_recurrence_time_invalid", "Recurring reminders need a local time in HH:mm format.");
  }

  const first = zonedDateTimeParts(scheduledFor, timezone);
  if (`${pad(first.hour)}:${pad(first.minute)}` !== localTime || first.second !== 0) {
    throw invalid("reminder_recurrence_first_time_mismatch", "The first occurrence must match the recurrence’s local wall-clock time.");
  }
  const anchorDate = dateKey(first);
  if (frequency === "daily") {
    if (input.weekdays?.length || input.dayOfMonth != null) {
      throw invalid("reminder_recurrence_fields_invalid", "Daily recurrence does not use weekdays or a day of month.");
    }
    return { frequency, interval, localTime, anchorDate };
  }

  if (frequency === "weekly") {
    if (input.dayOfMonth != null) throw invalid("reminder_recurrence_fields_invalid", "Weekly recurrence does not use a day of month.");
    const weekdays = normalizeWeekdays(input.weekdays);
    if (weekdays.length === 0 || !weekdays.includes(weekdayForDate(first))) {
      throw invalid("reminder_recurrence_weekdays_invalid", "Weekly recurrence needs weekdays that include the first occurrence.");
    }
    return { frequency, interval, localTime, anchorDate, weekdays };
  }

  if (input.weekdays?.length) throw invalid("reminder_recurrence_fields_invalid", "Monthly recurrence does not use weekdays.");
  const dayOfMonth = input.dayOfMonth;
  if (!Number.isInteger(dayOfMonth) || dayOfMonth! < 1 || dayOfMonth! > 31 || first.day !== dayOfMonth) {
    throw invalid("reminder_recurrence_day_invalid", "Monthly recurrence needs a day from 1 to 31 matching the first occurrence.");
  }
  return { frequency, interval, localTime, anchorDate, dayOfMonth };
}

export function parseReminderRecurrence(value: unknown): ReminderRecurrence | null {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored reminder recurrence is invalid.");
  const source = value as Record<string, unknown>;
  const frequency = normalizeFrequency(typeof source.frequency === "string" ? source.frequency : undefined);
  const interval = Number(source.interval);
  const localTime = typeof source.localTime === "string" ? source.localTime : "";
  const anchorDate = typeof source.anchorDate === "string" ? source.anchorDate : "";
  const weekdays = Array.isArray(source.weekdays) ? source.weekdays.map(Number) : undefined;
  const dayOfMonth = source.dayOfMonth == null ? undefined : Number(source.dayOfMonth);
  if (!frequency || !Number.isInteger(interval) || interval < 1 || interval > 366 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime) || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) {
    throw new Error("Stored reminder recurrence is invalid.");
  }
  if (frequency === "weekly" && (!weekdays?.length || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) {
    throw new Error("Stored weekly reminder recurrence is invalid.");
  }
  if (frequency === "monthly" && (!Number.isInteger(dayOfMonth) || dayOfMonth! < 1 || dayOfMonth! > 31)) {
    throw new Error("Stored monthly reminder recurrence is invalid.");
  }
  return {
    frequency,
    interval,
    localTime,
    anchorDate,
    ...(frequency === "weekly" ? { weekdays: [...new Set(weekdays)].sort((a, b) => a - b) } : {}),
    ...(frequency === "monthly" ? { dayOfMonth } : {}),
  };
}

/** Returns one future wall-clock occurrence, collapsing all missed intervals. */
export function nextReminderOccurrence(
  recurrence: ReminderRecurrence,
  timezone: string,
  after: Date,
  previousScheduledFor?: Date,
): Date {
  const afterLocal = zonedDateTimeParts(after, timezone);
  let date = calendarDate(afterLocal);
  if (previousScheduledFor) {
    const previous = calendarDate(zonedDateTimeParts(previousScheduledFor, timezone));
    if (compareDates(date, previous) <= 0) date = addDays(previous, 1);
  }
  for (let offset = 0; offset < 366 * 25; offset += 1) {
    const candidateDate = addDays(date, offset);
    if (!dateMatchesRecurrence(candidateDate, recurrence)) continue;
    const candidate = resolveZonedLocalTime(candidateDate, recurrence.localTime, timezone);
    if (candidate && candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error("Could not resolve a future reminder occurrence.");
}

export function formatReminderRecurrence(recurrence: ReminderRecurrence) {
  const interval = recurrence.interval;
  if (recurrence.frequency === "daily") {
    return interval === 1 ? `daily at ${recurrence.localTime}` : `every ${interval} days at ${recurrence.localTime}`;
  }
  if (recurrence.frequency === "weekly") {
    const days = recurrence.weekdays!.map((day) => capitalize(REMINDER_WEEKDAYS[day]!)).join(", ");
    return interval === 1 ? `weekly on ${days} at ${recurrence.localTime}` : `every ${interval} weeks on ${days} at ${recurrence.localTime}`;
  }
  return interval === 1
    ? `monthly on day ${recurrence.dayOfMonth} at ${recurrence.localTime}`
    : `every ${interval} months on day ${recurrence.dayOfMonth} at ${recurrence.localTime}`;
}

type CalendarDate = { year: number; month: number; day: number };
type ZonedParts = CalendarDate & { hour: number; minute: number; second: number };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedDateTimeParts(date: Date, timezone: string): ZonedParts {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function resolveZonedLocalTime(date: CalendarDate, localTime: string, timezone: string): Date | null {
  const [hour, minute] = localTime.split(":").map(Number);
  const approximate = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let exact: Date | null = null;
  let firstAfterGap: { instant: Date; localMinute: number } | null = null;
  for (let delta = -18 * 60; delta <= 18 * 60; delta += 1) {
    const instant = new Date(approximate + delta * 60_000);
    const local = zonedDateTimeParts(instant, timezone);
    if (compareDates(local, date) !== 0) continue;
    const localMinute = local.hour * 60 + local.minute;
    const targetMinute = hour * 60 + minute;
    if (localMinute === targetMinute && local.second === 0) {
      if (!exact || instant < exact) exact = instant;
    } else if (localMinute > targetMinute && (!firstAfterGap || localMinute < firstAfterGap.localMinute || (localMinute === firstAfterGap.localMinute && instant < firstAfterGap.instant))) {
      firstAfterGap = { instant, localMinute };
    }
  }
  return exact ?? firstAfterGap?.instant ?? null;
}

function dateMatchesRecurrence(date: CalendarDate, recurrence: ReminderRecurrence) {
  const anchor = parseDateKey(recurrence.anchorDate);
  if (compareDates(date, anchor) < 0) return false;
  if (recurrence.frequency === "daily") return daysBetween(anchor, date) % recurrence.interval === 0;
  if (recurrence.frequency === "weekly") {
    return weeksBetween(anchor, date) % recurrence.interval === 0 && recurrence.weekdays!.includes(weekdayForDate(date));
  }
  return monthsBetween(anchor, date) % recurrence.interval === 0 && date.day === recurrence.dayOfMonth;
}

function normalizeFrequency(value: string | undefined): ReminderRecurrenceFrequency | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "daily" || normalized === "weekly" || normalized === "monthly" ? normalized : null;
}

function normalizeWeekdays(values: string[] | undefined) {
  const days = (values ?? []).map((value) => REMINDER_WEEKDAYS.indexOf(value.trim().toLowerCase() as ReminderWeekday));
  if (days.some((day) => day < 0)) throw invalid("reminder_recurrence_weekdays_invalid", "Use full weekday names such as monday or friday.");
  return [...new Set(days)].sort((a, b) => a - b);
}

function calendarDate(value: CalendarDate): CalendarDate {
  return { year: value.year, month: value.month, day: value.day };
}

function parseDateKey(value: string): CalendarDate {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function dateKey(value: CalendarDate) {
  return `${value.year}-${pad(value.month)}-${pad(value.day)}`;
}

function addDays(value: CalendarDate, days: number): CalendarDate {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function daysBetween(left: CalendarDate, right: CalendarDate) {
  return Math.round((Date.UTC(right.year, right.month - 1, right.day) - Date.UTC(left.year, left.month - 1, left.day)) / 86_400_000);
}

function weeksBetween(anchor: CalendarDate, value: CalendarDate) {
  return Math.floor(daysBetween(startOfWeek(anchor), startOfWeek(value)) / 7);
}

function startOfWeek(value: CalendarDate) {
  return addDays(value, -weekdayForDate(value));
}

function monthsBetween(left: CalendarDate, right: CalendarDate) {
  return (right.year - left.year) * 12 + right.month - left.month;
}

function weekdayForDate(value: CalendarDate) {
  return new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDay();
}

function compareDates(left: CalendarDate, right: CalendarDate) {
  return Date.UTC(left.year, left.month - 1, left.day) - Date.UTC(right.year, right.month - 1, right.day);
}

function invalid(code: string, message: string) {
  return new ReminderRecurrenceValidationError(code, message);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function capitalize(value: string) {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
