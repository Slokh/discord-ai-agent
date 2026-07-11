import {
  isModelRoundTimelineStep,
  timelineToolRequests,
  toolRequestArgumentsText,
  type TimelineToolRequest
} from "./timelineText.js";
import type { EventLevel, RunArtifact, RunStatus } from "./types.js";

export type FlowItemKind = "input" | "model" | "tool" | "artifact" | "response" | "error";
export type TimelineStepKind = FlowItemKind | "span" | "event" | "run";
export type TimelineStep = {
  id: string;
  kind: TimelineStepKind;
  title: string;
  summary: string;
  createdAt: string;
  durationMs: number | null;
  durationStartedAt: string | null;
  gapMs: number | null;
  offset: string;
  source: string;
  status: RunStatus | null;
  level: EventLevel | null;
  metadata: Record<string, unknown>;
  artifact?: RunArtifact;
};

export type TimelineStepGroup = {
  id: string;
  parent: TimelineStep;
  children: TimelineStep[];
};

export function withStepGaps(steps: TimelineStep[]) {
  const sortedSteps = [...steps].sort((left, right) => {
    const timeDelta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
    return timelineStepOrder(left.kind) - timelineStepOrder(right.kind);
  });
  return compactTimelineSteps(enrichModelRoundToolRequests(sortedSteps)).map((step, index, compacted) => {
    const previous = index > 0 ? compacted[index - 1] : null;
    const gapMs = previous ? new Date(step.createdAt).getTime() - new Date(previous.createdAt).getTime() : null;
    return { ...step, gapMs: gapMs != null && Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : null };
  });
}

export function enrichModelRoundToolRequests(steps: TimelineStep[]) {
  const modelSteps = steps.filter(isModelRoundTimelineStep);
  if (modelSteps.length === 0) return steps;
  return steps.map((step) => {
    if (!isModelRoundTimelineStep(step) || timelineToolRequests(step).some((request) => request.argumentsText?.trim())) return step;
    const toolRequests = toolStartRequestsForModelRound(step, steps, modelSteps);
    return toolRequests.length === 0 ? step : { ...step, metadata: { ...step.metadata, timelineToolRequests: toolRequests } };
  });
}

function toolStartRequestsForModelRound(modelStep: TimelineStep, steps: TimelineStep[], modelSteps: TimelineStep[]) {
  const modelCompletedAt = new Date(modelStep.createdAt).getTime();
  if (!Number.isFinite(modelCompletedAt)) return [];
  const nextModel = modelSteps.find((candidate) => candidate.id !== modelStep.id && timelineStepStartMs(candidate) > modelCompletedAt);
  const nextModelStartedAt = nextModel ? timelineStepStartMs(nextModel) : Number.POSITIVE_INFINITY;
  return steps
    .filter((step) => {
      if (!/\bagent tool started\b/.test(normalizedTimelineName(step.title))) return false;
      const startedAt = new Date(step.createdAt).getTime();
      return Number.isFinite(startedAt) && startedAt >= modelCompletedAt && startedAt < nextModelStartedAt;
    })
    .map(toolRequestFromStartedStep)
    .filter((request): request is TimelineToolRequest => request != null);
}

function toolRequestFromStartedStep(step: TimelineStep): TimelineToolRequest | null {
  const metadataName = typeof step.metadata.toolName === "string" ? step.metadata.toolName.trim() : "";
  const name = metadataName || step.summary.trim();
  if (!name) return null;
  return {
    name,
    argumentsText: typeof step.metadata.argumentsPreview === "string" ? step.metadata.argumentsPreview : toolRequestArgumentsText(step.metadata)
  };
}

export function compactTimelineSteps(steps: TimelineStep[]) {
  return steps.filter((step) => {
    if (isEnvelopeTimelineStep(step) || isRedundantTimelineStep(step, steps) || isDuplicateTimedStep(step, steps)) return false;
    if (step.kind !== "span" || step.source !== "command") return true;
    const stepName = normalizedTimelineName(step.title);
    const stepStartedAt = new Date(step.createdAt).getTime();
    return !steps.some((candidate) => {
      if (candidate.id === step.id || candidate.kind !== "span" || candidate.source !== "task") return false;
      if (normalizedTimelineName(candidate.title) !== stepName) return false;
      const candidateStartedAt = new Date(candidate.createdAt).getTime();
      return Number.isFinite(stepStartedAt) && Number.isFinite(candidateStartedAt) && Math.abs(candidateStartedAt - stepStartedAt) <= 1_500 &&
        (candidate.durationMs ?? 0) >= (step.durationMs ?? 0);
    });
  });
}

function isRedundantTimelineStep(step: TimelineStep, steps: TimelineStep[]) {
  if (step.level === "error") return false;
  const text = normalizedTimelineName(`${step.title} ${step.source}`);
  if (isPromptArtifactDuplicate(step, steps) || isFinalResponseDuplicate(step, steps)) return true;
  if (/\bagent request started\b/.test(text) && hasModelRoundStep(steps)) return true;
  if (/\bagent response ready\b/.test(text) && hasFinalResponseStep(steps)) return true;
  if (/\bagent final synthesis started\b/.test(text) && hasFinalResponseStep(steps)) return true;
  if (/\bagent model call started\b/.test(text) && hasObservedModelCallStep(steps)) return true;
  if (/\bagent model call completed\b/.test(text) && hasMatchingModelCallSpan(step, steps)) return true;
  if (/\bagent model round complete\b/.test(text) && hasObservedModelCallStep(steps)) return true;
  if (/\bllm round\b/.test(text) && hasObservedModelCallStep(steps)) return true;
  if (/\bmodel tool router\b/.test(text) && hasModelRoundStep(steps)) return true;
  return /\bagent tool started\b/.test(text) && hasCompletedToolStep(step, steps);
}

function hasMatchingModelCallSpan(step: TimelineStep, steps: TimelineStep[]) {
  const callId = stringMetadata(step.metadata.callId);
  return Boolean(callId && steps.some((candidate) => candidate.kind === "span" && stringMetadata(candidate.metadata.callId) === callId));
}

function hasObservedModelCallStep(steps: TimelineStep[]) {
  return steps.some((step) => /\bagent model call completed\b/.test(normalizedTimelineName(step.title)));
}

function isPromptArtifactDuplicate(step: TimelineStep, steps: TimelineStep[]) {
  const text = normalizedTimelineName(`${step.title} ${step.source}`);
  if (step.kind !== "artifact" || !/\b(discord user prompt|user prompt)\b/.test(text)) return false;
  const summary = normalizedTimelineName(step.summary);
  return steps.some((candidate) => candidate.id !== step.id && /\b(discord mention received|user prompt|message received)\b/.test(normalizedTimelineName(candidate.title)) && summariesMatch(summary, normalizedTimelineName(candidate.summary)));
}

function isFinalResponseDuplicate(step: TimelineStep, steps: TimelineStep[]) {
  const text = normalizedTimelineName(`${step.title} ${step.source}`);
  if (!/\bchat\b/.test(text)) return false;
  const summary = normalizedTimelineName(step.summary);
  return steps.some((candidate) => candidate.id !== step.id && /\b(discord final response|final response)\b/.test(normalizedTimelineName(candidate.title)) && summariesMatch(summary, normalizedTimelineName(candidate.summary)));
}

function hasFinalResponseStep(steps: TimelineStep[]) {
  return steps.some((step) => /\b(discord final response|final response)\b/.test(normalizedTimelineName(step.title)));
}

function hasModelRoundStep(steps: TimelineStep[]) {
  return steps.some((step) => /\bagent model round complete\b/.test(normalizedTimelineName(step.title)) && (step.durationMs ?? 0) > 0);
}

function hasCompletedToolStep(step: TimelineStep, steps: TimelineStep[]) {
  const toolName = normalizedTimelineName(step.summary);
  return steps.some((candidate) => candidate.id !== step.id && (candidate.durationMs ?? 0) > 0 && /\bagent tool complete\b/.test(normalizedTimelineName(candidate.title)) && (!toolName || normalizedTimelineName(candidate.summary).includes(toolName)));
}

function summariesMatch(left: string, right: string) {
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

export function groupTimelineSteps(steps: TimelineStep[]): TimelineStepGroup[] {
  const parentSteps = steps.filter((step) => (step.durationMs ?? 0) > 0);
  const childrenByParent = new Map<string, TimelineStep[]>();
  const assignedChildren = new Set<string>();
  for (const child of steps) {
    if ((child.durationMs ?? 0) > 0) continue;
    const parent = bestTimelineParent(child, parentSteps);
    if (!parent) continue;
    assignedChildren.add(child.id);
    childrenByParent.set(parent.id, [...(childrenByParent.get(parent.id) ?? []), child]);
  }
  const groups = parentSteps.map((parent) => ({ id: parent.id, parent, children: childrenByParent.get(parent.id) ?? [] }));
  for (const step of steps) {
    if (!assignedChildren.has(step.id) && !parentSteps.some((parent) => parent.id === step.id)) groups.push({ id: step.id, parent: step, children: [] });
  }
  return groups.sort((left, right) => timelineStepStartMs(left.parent) - timelineStepStartMs(right.parent));
}

function bestTimelineParent(child: TimelineStep, parents: TimelineStep[]) {
  const childAt = new Date(child.createdAt).getTime();
  if (!Number.isFinite(childAt)) return null;
  return parents
    .map((parent) => {
      if (!shouldNestTimelineChild(child, parent)) return null;
      const interval = stepTimingInterval(parent);
      if (!interval) return null;
      const exact = childAt >= interval.startedAt && childAt <= interval.endedAt;
      const nearby = childAt >= interval.startedAt - 1_000 && childAt <= interval.endedAt + 1_000;
      return exact || nearby ? { parent, exact, durationMs: interval.endedAt - interval.startedAt, distanceMs: exact ? 0 : Math.min(Math.abs(childAt - interval.startedAt), Math.abs(childAt - interval.endedAt)) } : null;
    })
    .filter((candidate): candidate is { parent: TimelineStep; exact: boolean; durationMs: number; distanceMs: number } => candidate != null)
    .sort((left, right) => left.exact !== right.exact ? (left.exact ? -1 : 1) : left.durationMs - right.durationMs || left.distanceMs - right.distanceMs)[0]?.parent ?? null;
}

function shouldNestTimelineChild(child: TimelineStep, parent: TimelineStep) {
  if (/\b(discord mention received|discord user prompt|discord thinking sent|agent request started|agent response ready|discord final response|final response|response ready)\b/.test(normalizedTimelineName(child.title))) return false;
  if (["input", "response", "artifact", "run"].includes(child.kind)) return false;
  const childText = normalizedTimelineName(`${child.title} ${child.source}`);
  const parentText = normalizedTimelineName(`${parent.title} ${parent.source}`);
  const parentIsTool = /\btool\b/.test(parentText);
  const parentIsModel = /\b(model|chat|completion|synthesis)\b/.test(parentText);
  if (child.kind === "tool") return parentIsTool;
  if (child.kind === "model") return parentIsModel;
  if (/\b(model|chat|completion|synthesis)\b/.test(childText)) return parentIsModel;
  if (/\btool\b/.test(childText)) return parentIsTool;
  return child.source === parent.source || (/\b(context|permission|resolve|reply)\b/.test(childText) && /\b(context|permission|resolve|reply)\b/.test(parentText));
}

export function timelineStepStartMs(step: TimelineStep) {
  const interval = stepTimingInterval(step);
  const createdAt = new Date(step.createdAt).getTime();
  return interval?.startedAt ?? (Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER);
}

function isEnvelopeTimelineStep(step: TimelineStep) {
  if (step.level === "error") return false;
  const text = normalizedTimelineName(`${step.title} ${step.source} ${String(step.metadata.spanId ?? "")}`);
  if (step.kind === "span" && /\b(run model led agent|agent request|sandbox command|run total|task total|sandbox lifetime)\b/.test(text)) return true;
  return (step.durationMs ?? 0) > 0 && /\b(agent request complete|discord mention handled)\b/.test(text);
}

function isDuplicateTimedStep(step: TimelineStep, steps: TimelineStep[]) {
  if (step.kind === "span" || step.level === "error" || (step.durationMs ?? 0) <= 0) return false;
  const stepInterval = stepTimingInterval(step);
  if (!stepInterval) return false;
  return steps.some((candidate) => {
    if (candidate.id === step.id || candidate.kind !== "span" || candidate.source !== "process" || (candidate.durationMs ?? 0) <= 0) return false;
    const candidateInterval = stepTimingInterval(candidate);
    if (!candidateInterval) return false;
    const overlap = Math.max(0, Math.min(stepInterval.endedAt, candidateInterval.endedAt) - Math.max(stepInterval.startedAt, candidateInterval.startedAt));
    const shorterDuration = Math.min(stepInterval.endedAt - stepInterval.startedAt, candidateInterval.endedAt - candidateInterval.startedAt);
    return shorterDuration > 0 && overlap / shorterDuration >= 0.8 && Math.abs((step.durationMs ?? 0) - (candidate.durationMs ?? 0)) < 1_000;
  });
}

export function timelineStepOrder(kind: TimelineStepKind) {
  return ({ input: 0, event: 1, model: 2, tool: 3, span: 4, run: 5, artifact: 6, response: 7, error: 8 } satisfies Record<TimelineStepKind, number>)[kind];
}

export function phaseStatus(steps: TimelineStep[]): RunStatus {
  if (steps.some((step) => step.status === "failed" || step.status === "cancelled" || step.level === "error" || step.kind === "error")) return "failed";
  if (steps.some((step) => step.status === "running")) return "running";
  if (steps.some((step) => step.status === "queued")) return "queued";
  if (steps.some((step) => step.status === "no_changes")) return "no_changes";
  return "succeeded";
}

export function summedStepDuration(steps: Array<{ durationMs: number | null | undefined }>) {
  return steps.reduce((total, step) => total + Math.max(0, step.durationMs ?? 0), 0);
}

export function durationStartedAtForCompletedStep(createdAt: string, durationMs: number | null | undefined) {
  const completedAt = new Date(createdAt).getTime();
  return !Number.isFinite(completedAt) || durationMs == null || durationMs <= 0 ? null : new Date(completedAt - durationMs).toISOString();
}

function stepTimingInterval(step: { createdAt: string; durationMs: number | null | undefined; durationStartedAt?: string | null }) {
  const startedAt = new Date(step.durationStartedAt ?? step.createdAt).getTime();
  const durationMs = step.durationMs ?? 0;
  return !Number.isFinite(startedAt) || !Number.isFinite(durationMs) || durationMs <= 0 ? null : { startedAt, endedAt: startedAt + durationMs };
}

function normalizedTimelineName(value: string) {
  return value.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function stringMetadata(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
