export type CodegenAttemptSummaryForDiagnosis = {
  attempt: number;
  command: "nanocodex-run";
  exitCode: number;
  durationMs: number;
  producedDiff: boolean;
  finalResponse?: string;
  stdoutTail: string;
  stderrTail: string;
};

export type TaskTimingsForDiagnosis = Record<string, number>;

export type CodegenFailureCategory =
  | "no_diff"
  | "harness_startup"
  | "release_scan"
  | "git_push"
  | "github_pr"
  | "dependency_install"
  | "verification"
  | "command_failed"
  | "unknown";

export class CodegenTaskError extends Error {
  constructor(
    readonly category: CodegenFailureCategory,
    readonly phase: string | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodegenTaskError";
  }
}

export type CodegenFailureDiagnosis = {
  category: CodegenFailureCategory;
  status: "failed" | "no_changes";
  summary: string;
  nextAction: string;
  error: string;
  finalResponse?: string;
  failedPhase: string | null;
  slowestPhase: { name: string; durationMs: number } | null;
  timingsMs: TaskTimingsForDiagnosis;
  attempts?: Array<Pick<CodegenAttemptSummaryForDiagnosis, "attempt" | "command" | "exitCode" | "durationMs" | "producedDiff" | "finalResponse">>;
};

export function diagnoseCodegenFailure(input: { error: unknown; timings: TaskTimingsForDiagnosis }): CodegenFailureDiagnosis {
  const error = input.error instanceof Error ? input.error : new Error(String(input.error));
  const message = error.message;
  const attempts = codegenAttemptsFromError(error);
  const failedPhase = error instanceof CodegenTaskError ? error.phase : inferFailedCodegenPhase(input.timings);
  const slowestPhase = slowestCodegenPhase(input.timings);
  const category = classifyCodegenFailure(error, failedPhase);
  const status = category === "no_diff" ? "no_changes" : "failed";
  const summary = codegenFailureSummary(category);
  const finalResponse = finalResponseFromAttempts(attempts);
  return {
    category,
    status,
    summary,
    nextAction: codegenFailureNextAction(category, failedPhase),
    error: message,
    ...(finalResponse ? { finalResponse } : {}),
    failedPhase,
    slowestPhase,
    timingsMs: { ...input.timings },
    attempts: attempts.length
      ? attempts.map((attempt) => ({
          attempt: attempt.attempt,
          command: attempt.command,
          exitCode: attempt.exitCode,
          durationMs: attempt.durationMs,
          producedDiff: attempt.producedDiff,
          ...(attempt.finalResponse ? { finalResponse: attempt.finalResponse } : {})
        }))
      : undefined
  };
}

export function renderCodegenFailureDiagnosis(diagnosis: CodegenFailureDiagnosis) {
  const lines = [
    "# Codegen Failure Diagnosis",
    "",
    `Category: ${diagnosis.category}`,
    `Status: ${diagnosis.status}`,
    `Summary: ${diagnosis.summary}`,
    `Next action: ${diagnosis.nextAction}`,
    `Failed phase: ${diagnosis.failedPhase ?? "unknown"}`,
    `Slowest phase: ${diagnosis.slowestPhase ? `${diagnosis.slowestPhase.name} (${formatDuration(diagnosis.slowestPhase.durationMs)})` : "unknown"}`,
    "",
    "## Error",
    "",
    diagnosis.error,
    "",
    ...(diagnosis.finalResponse
      ? ["## Harness Final Answer", "", diagnosis.finalResponse, ""]
      : []),
    ...(diagnosis.attempts?.length
      ? [
          "## Attempts",
          "",
          ...diagnosis.attempts.map(
            (attempt) =>
              `- attempt ${attempt.attempt}: command=${attempt.command}, exit=${attempt.exitCode}, duration=${formatDuration(attempt.durationMs)}, producedDiff=${attempt.producedDiff}`
          ),
          ""
        ]
      : []),
    "## Timings",
    ""
  ];
  const timings = Object.entries(diagnosis.timingsMs).filter(([, value]) => Number.isFinite(value));
  if (timings.length === 0) {
    lines.push("- none recorded");
  } else {
    for (const [phase, durationMs] of timings) lines.push(`- ${phase}: ${formatDuration(durationMs)}`);
  }
  return lines.join("\n");
}

function codegenAttemptsFromError(error: Error): CodegenAttemptSummaryForDiagnosis[] {
  const value = (error as { attempts?: unknown }).attempts;
  if (!Array.isArray(value)) return [];
  return value.filter(isCodegenAttemptSummary);
}

function isCodegenAttemptSummary(value: unknown): value is CodegenAttemptSummaryForDiagnosis {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<CodegenAttemptSummaryForDiagnosis>;
  return (
    typeof attempt.attempt === "number" &&
    attempt.command === "nanocodex-run" &&
    typeof attempt.exitCode === "number" &&
    typeof attempt.durationMs === "number" &&
    typeof attempt.producedDiff === "boolean" &&
    (attempt.finalResponse == null || typeof attempt.finalResponse === "string") &&
    typeof attempt.stdoutTail === "string" &&
    typeof attempt.stderrTail === "string"
  );
}

function finalResponseFromAttempts(attempts: CodegenAttemptSummaryForDiagnosis[]) {
  for (const attempt of attempts.slice().reverse()) {
    const finalResponse = attempt.finalResponse?.trim();
    if (finalResponse) return finalResponse;
  }
  return "";
}

function classifyCodegenFailure(
  error: Error,
  failedPhase: string | null,
): CodegenFailureCategory {
  if (error instanceof CodegenTaskError) return error.category;
  if (error.name === "CodegenNoDiffError") return "no_diff";
  return categoryForCodegenPhase(failedPhase);
}

function inferFailedCodegenPhase(timings: TaskTimingsForDiagnosis) {
  const phases = Object.entries(timings).filter(([phase, durationMs]) => phase !== "total" && Number.isFinite(durationMs));
  return phases.at(-1)?.[0] ?? null;
}

export function categoryForCodegenPhase(phase: string | null): CodegenFailureCategory {
  if (phase === "scan") return "release_scan";
  if (phase === "typecheck" || phase === "verify") return "verification";
  if (phase === "push") return "git_push";
  if (phase === "pr" || phase === "prMetadata") return "github_pr";
  if (phase?.toLowerCase().includes("dependencies")) return "dependency_install";
  if (phase === "nanocodex") return "command_failed";
  return "unknown";
}

function slowestCodegenPhase(timings: TaskTimingsForDiagnosis) {
  const phases = Object.entries(timings)
    .filter(([phase, durationMs]) => phase !== "total" && Number.isFinite(durationMs))
    .map(([name, durationMs]) => ({ name, durationMs }));
  if (phases.length === 0) return null;
  return phases.reduce((slowest, phase) => (phase.durationMs > slowest.durationMs ? phase : slowest), phases[0]!);
}

function codegenFailureSummary(category: CodegenFailureCategory) {
  const harnessName = "NanoCodex";
  switch (category) {
    case "no_diff":
      return `${harnessName} finished but left the repository with no code diff, so no PR was opened.`;
    case "harness_startup":
      return `${harnessName} failed before a usable model turn started.`;
    case "release_scan":
      return "The agent produced changes, but the release scan failed before the branch was pushed.";
    case "git_push":
      return "The agent produced changes, but pushing the generated branch to GitHub failed.";
    case "github_pr":
      return "The agent produced changes, but opening or updating the GitHub pull request failed.";
    case "dependency_install":
      return "Dependency preparation failed before the coding harness could complete.";
    case "verification":
      return "The agent produced changes, but required TypeScript verification failed before publication.";
    case "command_failed":
      return `${harnessName} or one of its sandbox commands failed.`;
    case "unknown":
      return "The code-update task failed without a recognized failure category.";
  }
}

function codegenFailureNextAction(category: CodegenFailureCategory, failedPhase: string | null) {
  switch (category) {
    case "no_diff":
      return "Inspect the harness transcript and repository navigation context; improve repo ownership docs or the coding prompt if the task should have produced a change.";
    case "harness_startup":
      return "Inspect harness startup logs, model/provider configuration, and sandbox tool availability.";
    case "release_scan":
      return "Inspect the release scan command log and either fix the generated change or the scan false positive.";
    case "git_push":
      return "Inspect git authentication, branch naming, remote configuration, and repository permissions.";
    case "github_pr":
      return "Inspect GitHub API errors, base branch configuration, and pull request permissions.";
    case "dependency_install":
      return "Inspect dependency command logs and cache state; verify the sandbox includes dev dependencies.";
    case "verification":
      return "Inspect the typecheck command log, fix the reported contract errors or sandbox resource limit, and rerun before publishing.";
    case "command_failed":
      return `Inspect the ${failedPhase ?? "latest"} command log and harness transcript for the first non-zero exit or thrown error.`;
    case "unknown":
      return "Inspect the terminal command log and failure artifact, then add a classifier if this is a recurring failure mode.";
  }
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
