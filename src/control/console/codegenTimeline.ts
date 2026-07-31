import {
  isCodegenAttemptArtifact,
  isCodegenFailureDiagnosisArtifact,
  isRepositorySetupArtifact,
  timelineStepFromCodegenArtifact,
  timelineStepFromCodegenEvent,
} from "./codegenArtifacts.js";
import {
  normalizedTimelineName,
  numericMetadata,
  sortTimelineSteps,
  stringMetadata,
  timelineEventTitle,
  timelineStepFromSpan,
  type TimelineTrace,
} from "./timelineCore.js";
import {
  summedStepDuration,
  timelineStepStartMs,
  type TimelineStep,
  type TimelineStepGroup,
  type TimelineStepKind,
} from "./timelineModel.js";
import { stringArrayMetadata, timelineTitleText } from "./timelineText.js";
import type { RunArtifact, RunEvent, RunSnapshot, RunSpan } from "./types.js";

export function codegenTimelineTrace(
  snapshot: RunSnapshot,
  {
    events,
    spans,
    startedAt,
  }: { events: RunEvent[]; spans: RunSpan[]; startedAt: string },
): TimelineTrace | null {
  if (snapshot.run.kind !== "codegen") return null;
  const groups: TimelineStepGroup[] = [];
  const addGroup = (parent: TimelineStep, children: TimelineStep[] = []) => {
    groups.push({
      id: parent.id,
      parent,
      children: sortTimelineSteps(children),
    });
  };
  const event = (predicate: (event: RunEvent) => boolean) =>
    preferredTimelineEvent(events.filter(predicate));
  const progress = (step: string) =>
    event(
      (candidate) =>
        candidate.name === "task.progress" && candidate.metadata.step === step,
    );
  const span = (name: string) =>
    preferredTimelineSpan(
      spans.filter(
        (candidate) =>
          normalizedTimelineName(candidate.name) ===
          normalizedTimelineName(name),
      ),
    );
  const artifacts = (predicate: (artifact: RunArtifact) => boolean) =>
    snapshot.artifacts
      .filter(predicate)
      .map((artifact) => timelineStepFromCodegenArtifact(artifact, startedAt));

  const mention = event(
    (candidate) => candidate.name === "discord.mention.received",
  );
  if (mention) {
    addGroup(
      timelineStepFromCodegenEvent(mention, startedAt, {
        title: "User prompt received",
        kind: "input",
      }),
    );
  }

  const modelSelection = event(
    (candidate) =>
      candidate.name === "agent.model.call.completed" &&
      stringArrayMetadata(candidate.metadata.requestedToolCalls).some(
        isCodegenToolName,
      ),
  );
  if (modelSelection) {
    addGroup(
      timelineStepFromCodegenEvent(modelSelection, startedAt, {
        title: "Model chose code update",
        kind: "model",
        summary: "The model selected the coding-agent tool.",
      }),
    );
  }

  const codegenTool = event(
    (candidate) =>
      candidate.name === "agent.tool.complete" &&
      isCodegenToolName(candidate.metadata.toolName),
  );
  if (codegenTool) {
    addGroup(
      timelineStepFromCodegenEvent(codegenTool, startedAt, {
        title: "Codegen task queued",
        kind: "tool",
        summary: codegenQueuedSummary(events),
      }),
    );
  }

  const sandboxStarted = progress("sandbox_acquired");
  if (sandboxStarted) {
    addGroup(
      timelineStepFromCodegenEvent(sandboxStarted, startedAt, {
        title: "Sandbox process started",
        durationMs: sandboxStarted.durationMs,
      }),
    );
  }

  const phaseRows = [
    {
      name: "repo",
      title: "Repository prepared",
      artifacts: artifacts(isRepositorySetupArtifact),
    },
    {
      name: "dependencies",
      title: "Dependencies installed",
      artifacts: artifacts(
        (artifact) => artifact.metadata.step === "dependencies",
      ),
    },
    { name: "toolShims", title: "Helper tools installed", artifacts: [] },
    {
      name: "context",
      title: "Codegen context built",
      artifacts: artifacts(
        (artifact) =>
          artifact.kind === "diagnostic" &&
          /codegen request context/i.test(artifact.name),
      ),
    },
  ];
  for (const phase of phaseRows) {
    const phaseSpan = span(phase.name);
    if (phaseSpan)
      addGroup(
        timelineStepFromCodegenSpan(phaseSpan, startedAt, {
          title: phase.title,
        }),
        phase.artifacts,
      );
  }

  for (const attempt of codegenAttemptTimelineSpans(
    events,
    spans,
    snapshot.generatedAt,
  )) {
    const attemptNumber = codegenAttemptNumber(attempt.name);
    if (attemptNumber == null) continue;
    const firstEdit = event((candidate) => {
      const step = String(candidate.metadata.step ?? "");
      return (
        candidate.name === "task.progress" &&
        step === "nanocodex_first_edit" &&
        candidate.metadata.attempt === attemptNumber
      );
    });
    const noDiff = event(
      (candidate) =>
        candidate.name === "task.progress" &&
        String(candidate.metadata.step ?? "") ===
          `nanocodex_attempt_${attemptNumber}_no_diff` &&
        candidate.metadata.attempt === attemptNumber,
    );
    const attemptArtifacts = artifacts((artifact) =>
      isCodegenAttemptArtifact(artifact, attemptNumber),
    );
    const attemptProgress = events
      .filter((candidate) => {
        if (
          candidate.name !== "task.progress" ||
          candidate.metadata.attempt !== attemptNumber
        )
          return false;
        const step = String(candidate.metadata.step ?? "");
        if (!step.startsWith("nanocodex_")) return false;
        if (step === `nanocodex_attempt_${attemptNumber}`) return false;
        if (step.endsWith("_activity")) return false;
        if (step === `nanocodex_attempt_${attemptNumber}_no_diff`) return false;
        return step !== "nanocodex_first_edit";
      })
      .map((candidate) =>
        timelineStepFromCodegenEvent(candidate, startedAt, {
          title: codegenProgressEventTitle(candidate),
          kind: codegenProgressEventKind(candidate),
          durationMs: candidate.durationMs,
        }),
      );
    const children = [
      ...attemptArtifacts,
      ...attemptProgress,
      firstEdit
        ? timelineStepFromCodegenEvent(firstEdit, startedAt, {
            title: "First code edit made",
            kind: "event",
            durationMs: null,
          })
        : null,
      noDiff
        ? timelineStepFromCodegenEvent(noDiff, startedAt, {
            title: "Attempt ended with no diff",
            kind: "error",
            durationMs: null,
            summary: codegenAttemptNoDiffSummary(noDiff),
          })
        : null,
    ].filter((step): step is TimelineStep => step != null);

    addGroup(
      timelineStepFromCodegenSpan(attempt, startedAt, {
        title: `NanoCodex attempt ${attemptNumber}`,
        kind: attempt.status === "failed" ? "error" : "model",
        summary: codegenAttemptSummary(attempt, noDiff),
      }),
      children,
    );
  }

  const cleanup = progress("cleanup");
  if (cleanup)
    addGroup(
      timelineStepFromCodegenEvent(cleanup, startedAt, {
        title: "Cleanup started",
      }),
    );

  const completed = event((candidate) => candidate.name === "task.completed");
  if (completed) {
    addGroup(
      timelineStepFromCodegenEvent(completed, startedAt, {
        title:
          snapshot.run.status === "no_changes"
            ? "No PR opened"
            : "Run completed",
        kind: completed.level === "error" ? "error" : "response",
        summary: completed.summary ?? snapshot.run.summary ?? "",
      }),
      artifacts(isCodegenFailureDiagnosisArtifact),
    );
  }

  if (groups.length === 0) return null;
  const sortedGroups = groups.sort(
    (left, right) =>
      timelineStepStartMs(left.parent) - timelineStepStartMs(right.parent),
  );
  const steps = sortTimelineSteps(
    sortedGroups.flatMap((group) => [group.parent, ...group.children]),
  );
  const durations = sortedGroups
    .map((group) => ({
      name: timelineTitleText(group.parent),
      durationMs: group.parent.durationMs ?? 0,
    }))
    .filter((item) => item.durationMs > 0);
  return {
    steps,
    groups: sortedGroups,
    durationMs: summedStepDuration(sortedGroups.map((group) => group.parent)),
    status: snapshot.run.status,
    slowest:
      durations.length > 0
        ? durations.reduce(
            (current, item) =>
              item.durationMs > current.durationMs ? item : current,
            durations[0]!,
          )
        : null,
  };
}

export function timelineStepFromCodegenSpan(
  span: RunSpan,
  startedAt: string,
  overrides: Partial<
    Pick<TimelineStep, "title" | "summary" | "kind" | "durationMs">
  > = {},
): TimelineStep {
  return {
    ...timelineStepFromSpan(span, startedAt),
    ...overrides,
    id: `codegen-${span.id}`,
  };
}

export function preferredTimelineEvent(events: RunEvent[]) {
  const preference = ["task", "trace", "process", "command", "tool"];
  return (
    [...events].sort(
      (left, right) =>
        preference.indexOf(left.source) - preference.indexOf(right.source),
    )[0] ?? null
  );
}

export function preferredTimelineSpan(spans: RunSpan[]) {
  const preference = ["task", "command", "process", "sandbox"];
  return (
    [...spans].sort(
      (left, right) =>
        preference.indexOf(left.source) - preference.indexOf(right.source),
    )[0] ?? null
  );
}

export function codegenAttemptSpans(spans: RunSpan[]) {
  return spans
    .filter((span) => codegenAttemptNumber(span.name) != null)
    .sort((left, right) => {
      const leftAttempt = codegenAttemptNumber(left.name) ?? 0;
      const rightAttempt = codegenAttemptNumber(right.name) ?? 0;
      return leftAttempt - rightAttempt;
    });
}

export function codegenAttemptTimelineSpans(
  events: RunEvent[],
  spans: RunSpan[],
  generatedAt: string,
) {
  const existing = codegenAttemptSpans(spans);
  const existingKeys = new Set(
    existing
      .map((span) => codegenAttemptKey(span.name))
      .filter((key): key is string => key != null),
  );
  const generatedAtMs = new Date(generatedAt).getTime();
  const activeAttempts = new Map<string, RunSpan>();
  for (const event of events) {
    if (event.name !== "task.progress") continue;
    const step = stringMetadata(event.metadata.step);
    const key = step ? codegenAttemptStartKey(step) : null;
    if (!step || !key || existingKeys.has(key) || activeAttempts.has(key))
      continue;
    const startedAtMs = new Date(event.createdAt).getTime();
    activeAttempts.set(key, {
      id: `active-attempt-${event.id}`,
      source: "task",
      name: step,
      status: "running",
      startedAt: event.createdAt,
      completedAt: null,
      durationMs:
        Number.isFinite(startedAtMs) &&
        Number.isFinite(generatedAtMs) &&
        generatedAtMs >= startedAtMs
          ? generatedAtMs - startedAtMs
          : null,
      metadata: event.metadata,
    });
  }
  return codegenAttemptSpans([...existing, ...activeAttempts.values()]);
}

export function codegenAttemptKey(value: string) {
  const attempt = codegenAttemptNumber(value);
  if (attempt == null) return null;
  return `${codegenAttemptHarnessName(value).toLowerCase()}:${attempt}`;
}

export function codegenAttemptStartKey(value: string) {
  return /^nanocodex_attempt_\d+$/.test(value)
    ? codegenAttemptKey(value)
    : null;
}

export function codegenAttemptNumber(value: string) {
  const match = value.match(/nanocodex_attempt_(\d+)/);
  if (!match?.[1]) return null;
  const attempt = Number(match[1]);
  return Number.isFinite(attempt) ? attempt : null;
}

export function codegenAttemptHarnessName(_value: string) {
  return "NanoCodex";
}

export function isCodegenToolName(value: unknown) {
  return value === "runCodingAgent" || value === "openGithubPullRequest";
}

export function codegenProgressEventTitle(event: RunEvent) {
  const step = stringMetadata(event.metadata.step) ?? event.name;
  if (step.startsWith("nanocodex_tool_")) {
    const tool =
      stringMetadata(event.metadata.tool) ??
      step.replace(/^nanocodex_tool_/, "").replace(/_/g, " ");
    return `Tool: ${tool}`;
  }
  if (step === "nanocodex_assistant_message") return "NanoCodex assistant message";
  if (step === "nanocodex_run_error") return "NanoCodex error";
  return timelineEventTitle(step);
}

export function codegenProgressEventKind(event: RunEvent): TimelineStepKind {
  if (event.level === "error") return "error";
  const step = stringMetadata(event.metadata.step) ?? event.name;
  if (step.includes("_tool_") || stringMetadata(event.metadata.tool))
    return "tool";
  if (/nanocodex|model/i.test(step)) return "model";
  return "event";
}

export function codegenQueuedSummary(events: RunEvent[]) {
  const queued = preferredTimelineEvent(
    events.filter(
      (event) =>
        isCodegenToolName(event.name) ||
        isCodegenToolName(event.metadata.toolName),
    ),
  );
  if (!queued?.summary)
    return "The model handed this request to the codegen worker.";
  try {
    const parsed = JSON.parse(queued.summary);
    if (parsed && typeof parsed === "object") {
      const taskId =
        typeof (parsed as Record<string, unknown>).taskId === "string"
          ? (parsed as Record<string, unknown>).taskId
          : null;
      if (taskId) return `Queued codegen task ${taskId}.`;
    }
  } catch {
    // Fall through to the plain summary.
  }
  return queued.summary;
}

export function codegenAttemptSummary(
  attempt: RunSpan,
  outcome: RunEvent | null,
) {
  const parts = [`Ran ${String(attempt.metadata.command ?? attempt.name)}.`];
  const exitCode = numericMetadata(
    attempt.metadata.exitCode ?? outcome?.metadata.exitCode,
  );
  const gitStatus = stringMetadata(outcome?.metadata.gitStatus);
  if (exitCode != null) parts.push(`Exit ${exitCode}.`);
  if (gitStatus === "") parts.push("Git status was clean.");
  return parts.join(" ");
}

export function codegenAttemptNoDiffSummary(event: RunEvent) {
  const pieces = ["No code diff was produced."];
  const exitCode = numericMetadata(event.metadata.exitCode);
  if (exitCode != null) pieces.push(`Exit ${exitCode}.`);
  return pieces.join(" ");
}
