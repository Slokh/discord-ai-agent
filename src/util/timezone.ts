export const DEFAULT_USER_TIMEZONE = "UTC";
export const USER_TIMEZONE_PREFERENCE_KEY = "timezone";

export function normalizeIanaTimezone(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 100) return null;
  try {
    const timezone = new Intl.DateTimeFormat("en-US", { timeZone: candidate })
      .resolvedOptions().timeZone;
    return timezone === "Etc/UTC" ? DEFAULT_USER_TIMEZONE : timezone;
  } catch {
    return null;
  }
}

export function formatTimezoneDateTime(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")} ${value("timeZoneName")}`.trim();
}
