import type { AgentPromptContribution } from "../agent/capabilityRuntime.js";

export function freshDataPromptContribution(now = new Date()): AgentPromptContribution {
  return {
    section: "current_data",
    stability: "turn",
    content:
      `Current UTC date: ${now.toISOString().slice(0, 10)}. Resolve relative dates such as today, this weekend, and this fall against this date. ` +
      "For prices, fares, schedules, availability, weather, sports, transactions, or other time-sensitive facts, never answer from model memory or claim verification without fresh evidence from an available external-data capability in this turn. " +
      "Generic snippets, historical averages, and undated estimates are not sufficient evidence for a current purchasable offer. " +
      "Match the precision and subject of the evidence. A verified date does not establish an exact hour, and a related event does not establish the requested time unless the source explicitly says so. " +
      "Never say you ran a simulation, calculation, search, or tool unless the current turn contains its result; label an unaided forecast as a prediction or opinion. " +
      "If an exact lookup requires a missing date, duration, location, or other parameter, ask the shortest necessary follow-up instead of inventing values.",
  };
}
