import type { RunEvent, RunSnapshot } from "./types.js";

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
};

export type PromptSectionView = {
  name: string;
  bytes: number;
  characters: number;
  messageCount: number;
  estimatedTokens: number;
  roles: string[];
};

export type ToolSchemaView = {
  name: string;
  type: string;
  bytes: number;
};

export type ModelCallView = {
  id: string;
  callId: string;
  round: number | null;
  appRevision: string;
  purpose: string;
  model: string;
  status: "succeeded" | "failed";
  durationMs: number | null;
  promptBytes: number;
  toolSchemaBytes: number;
  toolCount: number;
  outputChars: number;
  finishReason: string;
  costUsd: number;
  usage: ModelUsage;
  requestedTools: string[];
  offeredTools: string[];
  promptSections: PromptSectionView[];
  toolSchemas: ToolSchemaView[];
  promptArtifactId: string | null;
  responseArtifactId: string | null;
  error: string | null;
};

export function modelCallsFromSnapshot(snapshot: Pick<RunSnapshot, "events">): ModelCallView[] {
  const observed = snapshot.events.filter((event) => event.name === "agent.model.call.completed" || event.name === "agent.model.call.failed");
  const events = observed.length > 0 ? observed : snapshot.events.filter((event) => event.name === "agent.model.round.complete");
  return events.map(modelCallFromEvent);
}

function modelCallFromEvent(event: RunEvent): ModelCallView {
  const metadata = event.metadata;
  const usage = record(metadata.usage);
  return {
    id: event.id,
    callId: stringValue(metadata.callId) ?? event.id,
    round: nullableNumber(metadata.round),
    appRevision: stringValue(metadata.appRevision) ?? "unknown",
    purpose: stringValue(metadata.purpose) ?? (metadata.round ? `tool_selection_round_${metadata.round}` : "model_call"),
    model: stringValue(metadata.model) ?? stringValue(metadata.requestedModel) ?? "unknown",
    status: event.name.endsWith("failed") || event.level === "error" ? "failed" : "succeeded",
    durationMs: event.durationMs,
    promptBytes: numberValue(metadata.promptBytes),
    toolSchemaBytes: numberValue(metadata.toolSchemaBytes),
    toolCount: numberValue(metadata.toolCount),
    outputChars: numberValue(metadata.outputChars),
    finishReason: stringValue(metadata.finishReason) ?? "unknown",
    costUsd: numberValue(metadata.estimatedCostUsd),
    usage: {
      inputTokens: numberValue(usage.inputTokens),
      outputTokens: numberValue(usage.outputTokens),
      totalTokens: numberValue(usage.totalTokens),
      reasoningTokens: numberValue(usage.reasoningTokens),
      cachedInputTokens: numberValue(usage.cachedInputTokens),
    },
    requestedTools: stringArray(metadata.requestedToolCalls),
    offeredTools: stringArray(metadata.offeredTools),
    promptSections: promptSections(metadata.promptSections),
    toolSchemas: toolSchemas(metadata.toolSchemas),
    promptArtifactId: stringValue(metadata.promptArtifactId),
    responseArtifactId: stringValue(metadata.responseArtifactId),
    error: stringValue(metadata.error),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function promptSections(value: unknown): PromptSectionView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const data = record(item);
    const name = stringValue(data.name);
    if (!name) return [];
    return [{
      name,
      bytes: numberValue(data.bytes),
      characters: numberValue(data.characters),
      messageCount: numberValue(data.messageCount),
      estimatedTokens: numberValue(data.estimatedTokens),
      roles: stringArray(data.roles),
    }];
  });
}

function toolSchemas(value: unknown): ToolSchemaView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const data = record(item);
    const name = stringValue(data.name);
    if (!name) return [];
    return [{ name, type: stringValue(data.type) ?? "unknown", bytes: numberValue(data.bytes) }];
  });
}
