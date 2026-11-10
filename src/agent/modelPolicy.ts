/**
 * Reasoning effort per workload. Chat turns get room to plan tool use;
 * bounded helper calls (summaries, image inspection, validation, compaction)
 * answer one narrow question and do not need deep reasoning. Change these with
 * eval evidence (npm run eval), not by feel.
 */
export const PRIMARY_AGENT_REASONING = "high" as const;
export const UTILITY_REASONING = "low" as const;
