export type OpenRouterReasoningEffort =
  | "max"
  | "xhigh"
  | "high"
  | "medium"
  | "low"
  | "minimal"
  | "none";

export function openRouterReasoning(
  effort: OpenRouterReasoningEffort | undefined,
) {
  return effort ? { effort, exclude: true } : undefined;
}

export function openRouterTemperature(
  effort: OpenRouterReasoningEffort | undefined,
  temperature: number | undefined,
) {
  return effort && effort !== "none" ? undefined : (temperature ?? 0.3);
}
