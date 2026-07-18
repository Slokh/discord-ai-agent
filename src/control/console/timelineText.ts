export type TimelineToolRequest = {
  id?: string | null;
  name: string;
  argumentsText?: string | null;
};

type TimelineTextStep = {
  title: string;
  summary: string;
  metadata: Record<string, unknown>;
};

type TimelineTitleStep = {
  title: string;
  summary: string;
  kind: string;
  source: string;
};

export function timelineStepSummaryText(step: Pick<TimelineTextStep, "title" | "summary" | "metadata">) {
  const modelSummary = modelRoundSummaryText(step);
  if (modelSummary) return modelSummary;
  return timelineSummaryText(step.summary);
}

export function timelineSummaryText(summary: string) {
  const trimmed = summary.trim();
  if (!trimmed) return "";
  if (/^no summary(?: recorded)?\.?$/i.test(trimmed)) return "";
  if (/^sent thinking reply\.?$/i.test(trimmed)) return "";
  if (/^thinking\.\.\.$/i.test(trimmed)) return "";
  if (/^[\w -]+ work took \d+(?:\.\d+)?s\.?$/i.test(trimmed)) return "";
  if (/^[\w -]+ work took \d+m \d+s\.?$/i.test(trimmed)) return "";
  return trimmed;
}

function modelRoundSummaryText(step: Pick<TimelineTextStep, "title" | "summary" | "metadata">) {
  if (!isModelRoundTimelineStep(step)) return "";
  const usableTools = timelineToolRequests(step).map((request) => request.name);
  if (usableTools.length > 0) return `Requested tools: ${formatToolCallList(usableTools)}`;
  const outputChars = typeof step.metadata.outputChars === "number" ? step.metadata.outputChars : null;
  if (outputChars != null && outputChars > 0) return `Returned text: ${outputChars} chars`;
  if (outputChars === 0) return "No tool calls or text returned";
  const finishReason = typeof step.metadata.finishReason === "string" ? step.metadata.finishReason : "";
  if (finishReason) return `Finished: ${finishReason}`;
  return timelineSummaryText(step.summary);
}

export function stringArrayMetadata(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export function timelineToolRequests(step: Pick<TimelineTextStep, "title" | "metadata">): TimelineToolRequest[] {
  if (!isModelRoundTimelineStep(step)) return [];
  const structuredSelected = toolRequestArrayMetadata(step.metadata.selectedLocalToolRequests);
  const enrichedRequests = toolRequestArrayMetadata(step.metadata.timelineToolRequests);
  const structuredRequested = toolRequestArrayMetadata(step.metadata.requestedToolRequests);
  const selectedTools = stringArrayMetadata(step.metadata.selectedLocalTools).map((name) => ({ name }));
  const detailed = structuredSelected.length > 0
    ? structuredSelected
    : enrichedRequests.length > 0
      ? enrichedRequests
      : structuredRequested.length > 0
        ? structuredRequested
        : selectedTools;
  const observed = stringArrayMetadata(step.metadata.requestedToolCalls).map((name) => ({ name }));
  if (detailed.length === 0) return observed;

  // Structured requests only describe client-executed tools. Keep their arguments,
  // then append transparent provider tools (for example hosted web search) that are
  // only represented by name in requestedToolCalls.
  const represented = new Map<string, number>();
  for (const request of detailed) represented.set(request.name, (represented.get(request.name) ?? 0) + 1);
  const extra = observed.filter((request) => {
    const remaining = represented.get(request.name) ?? 0;
    if (remaining <= 0) return true;
    represented.set(request.name, remaining - 1);
    return false;
  });
  return [...detailed, ...extra];
}

function toolRequestArrayMetadata(value: unknown): TimelineToolRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TimelineToolRequest[] => {
    if (typeof item === "string" && item.trim()) return [{ name: item.trim() }];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) return [];
    const id = typeof record.id === "string" && record.id.trim() ? record.id : null;
    return [
      {
        ...(id ? { id } : {}),
        name,
        argumentsText: toolRequestArgumentsText(record)
      }
    ];
  });
}

export function toolRequestArgumentsText(record: Record<string, unknown>) {
  for (const key of ["argumentsText", "argumentsPreview", "argumentsSummary"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const value = record.arguments;
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatToolCallList(tools: string[]) {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return [...counts.entries()].map(([tool, count]) => (count > 1 ? `${tool} x${count}` : tool)).join(", ");
}

export function parseToolArgumentsText(argumentsText?: string | null): Record<string, unknown> | null {
  if (!argumentsText?.trim()) return null;
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

export function formatToolArgumentValue(value: unknown) {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function isModelRoundTimelineStep(step: Pick<TimelineTextStep, "title">) {
  return /\bagent model round complete\b/.test(normalizedTimelineName(step.title));
}

export function timelineTitleText(step: Pick<TimelineTitleStep, "title" | "summary" | "kind" | "source">) {
  const title = normalizedTimelineName(step.title);
  const toolName = toolNameFromSummary(step.summary);
  if (/\b(discord mention received|discord user prompt|user prompt)\b/.test(title)) return "User prompt";
  if (/\b(discord thinking sent|thinking reply sent)\b/.test(title)) return "Acknowledgement sent";
  if (/\b(load channel memory|load memory)\b/.test(title)) return "Load conversation memory";
  if (/\b(resolve discord permissions|permissions visibility resolved)\b/.test(title)) return "Check user access";
  if (/\b(discord reply context resolved|reply context resolved)\b/.test(title)) return "Load reply context";
  if (/\bagent model round complete\b/.test(title)) {
    const round = step.summary.match(/^Round\s+(\d+)/i)?.[1];
    return round ? `LLM call ${round}` : "LLM call";
  }
  if (/\bagent tool complete\b/.test(title)) return toolName ? `Tool call: ${toolName}` : "Tool call";
  if (/\bget discord channel topics\b/.test(title)) return "Channel topics query";
  if (/\bcompose channel topics\b/.test(title)) return "Topic summary composed";
  if (/\bget discord stats\b/.test(title)) return "Discord stats query";
  if (/\bmodel tool router\b/.test(title)) return "Tool selection";
  if (/\bagent tool started\b/.test(title)) return toolName ? `Start tool: ${toolName}` : "Start tool";
  if (/\bagent request started\b/.test(title)) return "Start agent run";
  if (/\bagent response ready\b/.test(title)) return "Answer ready";
  if (/\bagent final synthesis started\b/.test(title)) return "Compose final answer";
  if (/\b(discord final response|final response)\b/.test(title)) return "Final answer sent";
  if (/\bchat\b/.test(title) && step.source === "tool") return "LLM response";
  return step.title;
}

function toolNameFromSummary(summary: string) {
  const match = summary.match(/^([A-Za-z][\w.-]*)(?::|\b)/);
  return match?.[1] ?? "";
}

function normalizedTimelineName(value: string) {
  return value.toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}
