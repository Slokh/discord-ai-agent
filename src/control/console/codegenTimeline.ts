import {
  isCodegenAttemptArtifact,
  isCodegenFailureDiagnosisArtifact,
  isOpenCodeTranscriptArtifact,
  isRepositorySetupArtifact,
  timelineStepFromCodegenArtifact,
  timelineStepFromCodegenEvent,
} from "./codegenArtifacts.js";
import {
  normalizedTimelineName,
  numericMetadata,
  objectMetadata,
  sortTimelineSteps,
  stringMetadata,
  timelineEventTitle,
  timelineStepFromSpan,
  type TimelineTrace,
} from "./timelineCore.js";
import { formatOffset } from "./consoleFormat.js";
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
      candidate.name === "agent.model.round.complete" &&
      stringArrayMetadata(candidate.metadata.selectedLocalTools).some(
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
    const harnessName = codegenAttemptHarnessName(attempt.name);
    const reasoningStarted = event(
      (candidate) =>
        candidate.name === "task.progress" &&
        candidate.metadata.step === "codex_app_server_item_started" &&
        candidate.metadata.attempt === attemptNumber &&
        /\breasoning\b/i.test(candidate.summary ?? ""),
    );
    const firstDiff = event((candidate) => {
      const step = String(candidate.metadata.step ?? "");
      return (
        candidate.name === "task.progress" &&
        (step === "codex_first_diff" ||
          step === "codex_app_server_first_diff" ||
          step === "opencode_first_diff") &&
        candidate.metadata.attempt === attemptNumber
      );
    });
    const noDiff = event(
      (candidate) =>
        candidate.name === "task.progress" &&
        (String(candidate.metadata.step ?? "") ===
          `codex_app_server_attempt_${attemptNumber}_no_diff` ||
          String(candidate.metadata.step ?? "") ===
            `opencode_attempt_${attemptNumber}_no_diff`) &&
        candidate.metadata.attempt === attemptNumber,
    );
    const attemptArtifacts = artifacts((artifact) =>
      isCodegenAttemptArtifact(artifact, attemptNumber),
    );
    const hasOpenCodeActivityArtifact = attemptArtifacts.some(
      (step) => step.artifact && isOpenCodeTranscriptArtifact(step.artifact),
    );
    const liveOpenCodeRounds =
      harnessName === "OpenCode" && !hasOpenCodeActivityArtifact
        ? liveOpenCodeRoundSteps(events, {
            attemptNumber,
            startedAt,
            generatedAt: snapshot.generatedAt,
          })
        : [];
    const attemptProgress = events
      .filter((candidate) => {
        if (
          candidate.name !== "task.progress" ||
          candidate.metadata.attempt !== attemptNumber
        )
          return false;
        const step = String(candidate.metadata.step ?? "");
        if (!/^(opencode_|codex_app_server_)/.test(step)) return false;
        if (
          step === `codex_app_server_attempt_${attemptNumber}` ||
          step === `opencode_attempt_${attemptNumber}`
        )
          return false;
        if (step.startsWith("opencode_")) return false;
        if (
          step === "codex_app_server_item_started" &&
          /\breasoning\b/i.test(candidate.summary ?? "")
        )
          return false;
        if (step.endsWith("_activity")) return false;
        if (
          step === `codex_app_server_attempt_${attemptNumber}_no_diff` ||
          step === `opencode_attempt_${attemptNumber}_no_diff`
        )
          return false;
        if (
          step === "codex_app_server_thread" ||
          step === "opencode_server_ready"
        )
          return false;
        return (
          step !== "codex_app_server_first_diff" &&
          step !== "opencode_first_diff"
        );
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
      reasoningStarted
        ? timelineStepFromCodegenEvent(reasoningStarted, startedAt, {
            title: "Model started reasoning",
            kind: "model",
            durationMs: null,
          })
        : null,
      ...liveOpenCodeRounds,
      ...attemptProgress,
      firstDiff
        ? timelineStepFromCodegenEvent(firstDiff, startedAt, {
            title: "First code diff produced",
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
        title: `${harnessName} attempt ${attemptNumber}`,
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
  return /^(?:codex_(?:app_server_)?|opencode_)attempt_\d+$/.test(value)
    ? codegenAttemptKey(value)
    : null;
}

export function liveOpenCodeRoundSteps(
  events: RunEvent[],
  input: { attemptNumber: number; startedAt: string; generatedAt: string },
): TimelineStep[] {
  const rounds = new Map<
    number,
    {
      round: number;
      started: RunEvent | null;
      finished: RunEvent | null;
      tools: RunEvent[];
      messages: RunEvent[];
      firstEvent: RunEvent;
      lastEvent: RunEvent;
    }
  >();

  let activeRound: number | null = null;
  for (const event of dedupeOpenCodeProgressEvents(events).sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  )) {
    if (
      event.name !== "task.progress" ||
      event.metadata.attempt !== input.attemptNumber
    )
      continue;
    const step = stringMetadata(event.metadata.step);
    if (!step?.startsWith("opencode_")) continue;
    if (
      step === `opencode_attempt_${input.attemptNumber}` ||
      step.endsWith("_activity") ||
      step === "opencode" ||
      step === "opencode_server_ready" ||
      step === "opencode_server_start"
    )
      continue;
    if (
      step === "opencode_first_diff" ||
      step === `opencode_attempt_${input.attemptNumber}_no_diff`
    )
      continue;
    const explicitRound = numericMetadata(event.metadata.round);
    if (step === "opencode_round_started" && explicitRound != null)
      activeRound = explicitRound;
    const round = explicitRound ?? activeRound;
    if (round == null) continue;
    const current = rounds.get(round) ?? {
      round,
      started: null,
      finished: null,
      tools: [],
      messages: [],
      firstEvent: event,
      lastEvent: event,
    };
    if (
      new Date(event.createdAt).getTime() <
      new Date(current.firstEvent.createdAt).getTime()
    )
      current.firstEvent = event;
    if (
      new Date(event.createdAt).getTime() >=
      new Date(current.lastEvent.createdAt).getTime()
    )
      current.lastEvent = event;
    if (step === "opencode_round_started") current.started = event;
    else if (step === "opencode_round_finished") current.finished = event;
    else if (step.startsWith("opencode_tool_")) current.tools.push(event);
    else if (step === "opencode_assistant_message")
      current.messages.push(event);
    if (
      step === "opencode_round_finished" &&
      explicitRound != null &&
      activeRound === explicitRound
    )
      activeRound = null;
    rounds.set(round, current);
  }

  return [...rounds.values()]
    .sort((left, right) => left.round - right.round)
    .map((round) =>
      liveOpenCodeRoundStep(round, input.startedAt, input.generatedAt),
    );
}

export function liveOpenCodeRoundStep(
  round: {
    round: number;
    started: RunEvent | null;
    finished: RunEvent | null;
    tools: RunEvent[];
    messages: RunEvent[];
    firstEvent: RunEvent;
    lastEvent: RunEvent;
  },
  startedAt: string,
  generatedAt: string,
): TimelineStep {
  const createdAt = round.started?.createdAt ?? round.firstEvent.createdAt;
  const completedAt = round.finished?.createdAt ?? null;
  const createdAtMs = new Date(createdAt).getTime();
  const endAtMs = completedAt
    ? new Date(completedAt).getTime()
    : new Date(generatedAt).getTime();
  const durationMs =
    Number.isFinite(createdAtMs) &&
    Number.isFinite(endAtMs) &&
    endAtMs >= createdAtMs
      ? endAtMs - createdAtMs
      : null;
  const toolNames = openCodeRoundToolNames(round);
  const tokens = objectMetadata(round.finished?.metadata.tokens);
  const totalTokens = numericMetadata(tokens?.total);
  const reasoningTokens = numericMetadata(tokens?.reasoning);
  const reason = stringMetadata(round.finished?.metadata.reason);
  const body = [
    round.finished
      ? reason
        ? `Finished: ${reason}`
        : "Finished"
      : "In progress",
    totalTokens != null ? `Tokens: ${totalTokens.toLocaleString()}` : null,
    reasoningTokens != null
      ? `Reasoning: ${reasoningTokens.toLocaleString()}`
      : null,
    ...round.messages.map((message) => message.summary ?? "").filter(Boolean),
  ]
    .filter((item): item is string => Boolean(item))
    .join(" · ");
  return {
    id: `live-opencode-round-${round.round}-${createdAt}`,
    kind: round.tools.some((event) => event.level === "error")
      ? "error"
      : round.finished
        ? "model"
        : "model",
    title:
      toolNames.length > 0
        ? `Round ${round.round}: ${formatOpenCodeToolCallList(toolNames)}`
        : round.messages.length > 0
          ? `Round ${round.round}: assistant message`
          : `Round ${round.round}`,
    summary: body,
    createdAt,
    durationMs,
    durationStartedAt:
      durationMs != null && completedAt
        ? new Date(new Date(completedAt).getTime() - durationMs).toISOString()
        : null,
    gapMs: null,
    offset: formatOffset(startedAt, createdAt),
    source: "opencode",
    status: round.finished ? null : "running",
    level: null,
    metadata: {
      round: round.round,
      tools: toolNames,
      reason,
      tokens: tokens ?? null,
      live: true,
    },
  };
}

export function dedupeOpenCodeProgressEvents(events: RunEvent[]) {
  const grouped = new Map<string, RunEvent[]>();
  for (const event of events) {
    const step = stringMetadata(event.metadata.step);
    if (!step?.startsWith("opencode_")) continue;
    const key = [
      step,
      numericMetadata(event.metadata.attempt) ?? "",
      numericMetadata(event.metadata.round) ?? "",
      stringMetadata(event.metadata.tool) ?? "",
      stringMetadata(event.metadata.title) ?? "",
      event.summary ?? "",
    ].join(":");
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  return [...grouped.values()]
    .map(preferredTimelineEvent)
    .filter((event): event is RunEvent => event != null);
}

export function openCodeRoundToolNames(round: {
  finished: RunEvent | null;
  tools: RunEvent[];
}) {
  const finishedTools = stringArrayMetadata(round.finished?.metadata.tools);
  if (finishedTools.length > 0) return finishedTools;
  return round.tools
    .map(
      (event) =>
        stringMetadata(event.metadata.tool) ??
        String(event.metadata.step ?? "")
          .replace(/^opencode_tool_/, "")
          .replace(/_/g, " "),
    )
    .filter(Boolean);
}

export function formatOpenCodeToolCallList(tools: string[]) {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(", ");
}

export function codegenAttemptNumber(value: string) {
  const match = value.match(
    /(?:codex_(?:app_server_)?|opencode_)attempt_(\d+)/,
  );
  if (!match?.[1]) return null;
  const attempt = Number(match[1]);
  return Number.isFinite(attempt) ? attempt : null;
}

export function codegenAttemptHarnessName(value: string) {
  return value.includes("opencode") ? "OpenCode" : "Codex";
}

export function isCodegenToolName(value: unknown) {
  return value === "runCodingAgent" || value === "openGithubPullRequest";
}

export function codegenProgressEventTitle(event: RunEvent) {
  const step = stringMetadata(event.metadata.step) ?? event.name;
  if (step === "opencode_round_started")
    return `Round ${numericMetadata(event.metadata.round) ?? "?"} started`;
  if (step === "opencode_round_finished")
    return `Round ${numericMetadata(event.metadata.round) ?? "?"} finished`;
  if (step.startsWith("opencode_tool_")) {
    const tool =
      stringMetadata(event.metadata.tool) ??
      step.replace(/^opencode_tool_/, "").replace(/_/g, " ");
    return `Tool: ${tool}`;
  }
  if (step === "opencode_assistant_message")
    return "OpenCode assistant message";
  if (
    step === "codex_app_server_item_started" ||
    step === "codex_app_server_item_completed"
  ) {
    const itemType = stringMetadata(event.metadata.itemType);
    if (itemType === "commandExecution") return "Codex command";
    if (itemType === "agentMessage") return "Codex assistant message";
    if (itemType === "reasoning") return "Codex reasoning";
  }
  return timelineEventTitle(step);
}

export function codegenProgressEventKind(event: RunEvent): TimelineStepKind {
  if (event.level === "error") return "error";
  const step = stringMetadata(event.metadata.step) ?? event.name;
  if (step.includes("_tool_") || stringMetadata(event.metadata.tool))
    return "tool";
  if (/opencode|codex|model/i.test(step)) return "model";
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
  const notificationCount = numericMetadata(event.metadata.notificationCount);
  if (exitCode != null) pieces.push(`Exit ${exitCode}.`);
  if (notificationCount != null)
    pieces.push(
      `${notificationCount} ${stringMetadata(event.metadata.harness)?.includes("opencode") ? "OpenCode" : "Codex"} notifications.`,
    );
  return pieces.join(" ");
}
