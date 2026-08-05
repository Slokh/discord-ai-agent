import type { AgentPromptContribution } from "../agent/capabilityRuntime.js";
import { DEFAULT_USER_TIMEZONE, formatTimezoneDateTime, normalizeIanaTimezone } from "../util/timezone.js";

export function freshDataPromptContribution(
  now = new Date(),
  input: { timezone?: string; hasOverride?: boolean } = {},
): AgentPromptContribution {
  const timezone = normalizeIanaTimezone(input.timezone) ?? DEFAULT_USER_TIMEZONE;
  const localDateTime = formatTimezoneDateTime(now, timezone);
  const utcDateTime = formatTimezoneDateTime(now, DEFAULT_USER_TIMEZONE);
  const source = input.hasOverride ? "stored user override" : "default";
  return {
    section: "current_data",
    stability: "turn",
    content:
      `Current requester timezone: ${timezone} (${source}). Current requester-local date/time: ${localDateTime}. Current UTC date/time: ${utcDateTime}. ` +
      "Resolve relative dates such as today, this weekend, and this fall against the requester-local date. For scheduled events and live sports, preserve an explicit event date from the conversation or fresh evidence and account for the event or venue timezone instead of replacing it with the UTC calendar date. " +
      "For prices, fares, schedules, availability, weather, sports, transactions, or other time-sensitive facts, never answer from model memory or claim verification without fresh evidence from an available external-data capability in this turn. " +
      "Generic snippets, historical averages, and undated estimates are not sufficient evidence for a current purchasable offer. " +
      "Match the precision and subject of the evidence. A verified date does not establish an exact hour, and a related event does not establish the requested time unless the source explicitly says so. " +
      "Never say you ran a simulation, calculation, search, or tool unless the current turn contains its result; label an unaided forecast as a prediction or opinion. " +
      "If an exact lookup requires a missing date, duration, location, or other parameter, ask the shortest necessary follow-up instead of inventing values.",
  };
}
