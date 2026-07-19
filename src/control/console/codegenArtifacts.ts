import {
  durationStartedAtForCompletedStep,
  type TimelineStep,
} from "./timelineModel.js";
import {
  normalizedTimelineName,
  numericMetadata,
  stringMetadata,
  timelineEventTitle,
} from "./timelineCore.js";
import { formatOffset } from "./consoleFormat.js";
import type { RunArtifact, RunEvent } from "./types.js";

export function isRepositorySetupArtifact(artifact: RunArtifact) {
  if (artifact.kind !== "command_log") return false;
  const step = stringMetadata(artifact.metadata.step);
  return step === "repo_seed" || step === "repo_checkout" || step === "branch";
}

export function isCodegenAttemptArtifact(
  artifact: RunArtifact,
  attempt: number,
) {
  const metadataAttempt = numericMetadata(artifact.metadata.attempt);
  if (metadataAttempt === attempt) return true;
  const step = normalizedTimelineName(
    stringMetadata(artifact.metadata.step) ?? "",
  );
  if (
    step === `opencode attempt ${attempt}` ||
    step === `codex attempt ${attempt}` ||
    step === `codex app server attempt ${attempt}`
  )
    return true;
  const name = normalizedTimelineName(artifact.name);
  return (
    name.includes(`attempt ${attempt} transcript`) ||
    name.includes(`opencode attempt ${attempt} command log`)
  );
}

export function isCodegenFailureDiagnosisArtifact(artifact: RunArtifact) {
  return (
    artifact.kind === "diagnostic" &&
    /codegen failure diagnosis/i.test(artifact.name)
  );
}

export function timelineStepFromCodegenEvent(
  event: RunEvent,
  startedAt: string,
  overrides: Partial<
    Pick<TimelineStep, "title" | "summary" | "kind" | "durationMs">
  > = {},
): TimelineStep {
  return {
    id: `codegen-event-${event.id}`,
    kind: event.level === "error" ? "error" : "event",
    title: timelineEventTitle(event.name),
    summary: event.summary ?? "",
    createdAt: event.createdAt,
    durationMs: event.durationMs,
    durationStartedAt: durationStartedAtForCompletedStep(
      event.createdAt,
      event.durationMs,
    ),
    gapMs: null,
    offset: formatOffset(startedAt, event.createdAt),
    source: event.source,
    status: null,
    level: event.level,
    metadata: event.metadata,
    ...overrides,
  };
}

export function timelineStepFromCodegenArtifact(
  artifact: RunArtifact,
  startedAt: string,
): TimelineStep {
  return {
    id: `codegen-artifact-${artifact.artifactId}`,
    kind: "artifact",
    title: timelineArtifactTitle(artifact),
    summary: artifact.preview,
    createdAt: artifact.createdAt,
    durationMs: null,
    durationStartedAt: null,
    gapMs: null,
    offset: formatOffset(startedAt, artifact.createdAt),
    source: "artifact",
    status: null,
    level: null,
    metadata: artifact.metadata,
    artifact,
  };
}

export function timelineArtifactTitle(artifact: RunArtifact) {
  if (isOpenCodeTranscriptArtifact(artifact)) return "OpenCode activity";
  if (isCodexTranscriptArtifact(artifact)) return artifact.name;
  if (artifact.kind === "command_log") {
    const match = artifact.name.match(/^(.+?) command log$/i);
    if (match?.[1]) return `Command: ${match[1]}`;
  }
  return artifact.name;
}

export function isCodexTranscriptArtifact(artifact: RunArtifact) {
  return (
    artifact.kind === "command_log" &&
    /\bcodex\b.+\btranscript\b/i.test(artifact.name)
  );
}

export function isOpenCodeTranscriptArtifact(artifact: RunArtifact) {
  if (artifact.kind !== "command_log") return false;
  const step = normalizedTimelineName(
    stringMetadata(artifact.metadata.step) ?? artifact.name,
  );
  return /\bopencode attempt \d+\b/.test(step);
}
