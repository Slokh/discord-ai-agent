import type { RunEvent } from "./types.js";

export function titleCase(value: string) {
  return value.replace(/^\w/, (letter) => letter.toUpperCase());
}

export function metadataValue(value: unknown) {
  if (value == null) return "null";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  return JSON.stringify(value);
}

export function formatCountName(value: string) {
  return value.replaceAll("_", " ");
}

export function shortId(value: string) {
  return value.length > 14
    ? `${value.slice(0, 6)}...${value.slice(-6)}`
    : value;
}

export function formatDuration(value: number | null | undefined) {
  if (value == null) return "live";
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatRelative(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 60_000) return "now";
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}h`;
  return `${Math.floor(ms / (24 * 60 * 60_000))}d`;
}

export function eventsWithTiming(events: RunEvent[], startedAt: string) {
  return events.map((event, index) => {
    const previous = index > 0 ? events[index - 1] : null;
    const gapMs = previous
      ? new Date(event.createdAt).getTime() -
        new Date(previous.createdAt).getTime()
      : null;
    return {
      event,
      gapMs:
        gapMs != null && Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : null,
      offset: formatOffset(startedAt, event.createdAt),
    };
  });
}

export function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

export function formatOffset(startedAt: string, eventAt: string) {
  const offset = new Date(eventAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(offset)) return "unknown";
  if (offset < 0) return "+0.000s";
  return `+${formatDuration(offset)}`;
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
