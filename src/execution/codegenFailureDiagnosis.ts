type CodegenHarness = "codex" | "opencode";
export type CodegenAttemptSummaryForDiagnosis = {
  attempt: number;
  command: "app-server" | "exec" | "resume" | "opencode-run";
  exitCode: number;
  durationMs: number;
  producedDiff: boolean;
  stdoutTail: string;
  stderrTail: string;
};

export type TaskTimingsForDiagnosis = Record<string, number>;

type CodegenFailureCategory =
  | "no_first_edit"
  | "no_diff"
  | "harness_startup"
  | "release_scan"
  | "git_push"
  | "github_pr"
  | "dependency_install"
  | "command_failed"
  | "unknown";

export type CodegenFailureDiagnosis = {
  category: CodegenFailureCategory;
  status: "failed" | "no_changes";
  summary: string;
  nextAction: string;
  error: string;
  failedPhase: string | null;
  slowestPhase: { name: string; durationMs: number } | null;
  timingsMs: TaskTimingsForDiagnosis;
  attempts?: Array<Pick<CodegenAttemptSummaryForDiagnosis, "attempt" | "command" | "exitCode" | "durationMs" | "producedDiff">>;
};

export function diagnoseCodegenFailure(input: { error: unknown; timings: TaskTimingsForDiagnosis; harness?: CodegenHarness }): CodegenFailureDiagnosis {
  const error = input.error instanceof Error ? input.error : new Error(String(input.error));
  const message = error.message;
  const attempts = codegenAttemptsFromError(error);
  const failedPhase = inferFailedCodegenPhase(message, input.timings, input.harness);
  const slowestPhase = slowestCodegenPhase(input.timings);
  const category = classifyCodegenFailure(message, error.name, failedPhase, input.harness, attempts);
  const status = category === "no_diff" || category === "no_first_edit" ? "no_changes" : "failed";
  const summary = codegenFailureSummary(category, input.harness);
  return {
    category,
    status,
    summary,
    nextAction: codegenFailureNextAction(category, failedPhase),
    error: message,
    failedPhase,
    slowestPhase,
    timingsMs: { ...input.timings },
    attempts: attempts.length
      ? attempts.map((attempt) => ({
          attempt: attempt.attempt,
          command: attempt.command,
          exitCode: attempt.exitCode,
          durationMs: attempt.durationMs,
          producedDiff: attempt.producedDiff
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
    ["app-server", "exec", "resume", "opencode-run"].includes(String(attempt.command)) &&
    typeof attempt.exitCode === "number" &&
    typeof attempt.durationMs === "number" &&
    typeof attempt.producedDiff === "boolean" &&
    typeof attempt.stdoutTail === "string" &&
    typeof attempt.stderrTail === "string"
  );
}

function classifyCodegenFailure(
  message: string,
  errorName: string,
  failedPhase: string | null,
  harness: CodegenHarness | undefined,
  attempts: CodegenAttemptSummaryForDiagnosis[] = []
): CodegenFailureCategory {
  const text = message.toLowerCase();
  if (errorName === "CodegenNoDiffError" || text.includes("produced no diff")) {
    return attempts.length > 0 && !attempts.some((attempt) => attemptProducedEditSignal(attempt)) ? "no_first_edit" : "no_diff";
  }
  if (errorName === "CodexAppServerStartupError" || text.includes("failed before starting a usable model turn") || text.includes("health probe timed out")) {
    return "harness_startup";
  }
  if (text.includes("release scan failed") || failedPhase === "scan") return "release_scan";
  if (text.includes("git push") || failedPhase === "push") return "git_push";
  if (text.includes("pull request") || text.includes("pulls.create") || failedPhase === "pr") return "github_pr";
  if (text.includes("npm ci") || text.includes("npm install") || failedPhase === "dependencies") return "dependency_install";
  if (text.includes("codex") || text.includes("opencode") || harness) return "command_failed";
  return "unknown";
}

function attemptProducedEditSignal(attempt: CodegenAttemptSummaryForDiagnosis) {
  if (attempt.producedDiff) return true;
  const text = `${attempt.stdoutTail}\n${attempt.stderrTail}`.toLowerCase();
  return /(?:\bfirst[_ -]?edit\b|\bfirst[_ -]?diff\b|\bapply_patch\b|\bedit_file\b|\bfile_edit\b|\btool_use\b.*\bedit\b|"name"\s*:\s*"edit"|"tool"\s*:\s*"edit")/.test(text);
}

function inferFailedCodegenPhase(message: string, timings: TaskTimingsForDiagnosis, harness: CodegenHarness | undefined) {
  const text = message.toLowerCase();
  if (text.includes("release scan")) return "scan";
  if (text.includes("git push")) return "push";
  if (text.includes("pull request")) return "pr";
  if (text.includes("npm ci") || text.includes("npm install")) return "dependencies";
  if (text.includes("opencode")) return "opencode";
  if (text.includes("codex")) return harness === "opencode" ? "opencode" : "codex";
  const phases = Object.entries(timings).filter(([phase, durationMs]) => phase !== "total" && Number.isFinite(durationMs));
  return phases.at(-1)?.[0] ?? null;
}

function slowestCodegenPhase(timings: TaskTimingsForDiagnosis) {
  const phases = Object.entries(timings)
    .filter(([phase, durationMs]) => phase !== "total" && Number.isFinite(durationMs))
    .map(([name, durationMs]) => ({ name, durationMs }));
  if (phases.length === 0) return null;
  return phases.reduce((slowest, phase) => (phase.durationMs > slowest.durationMs ? phase : slowest), phases[0]!);
}

function codegenFailureSummary(category: CodegenFailureCategory, harness: CodegenHarness | undefined) {
  const harnessName = harness ? codegenHarnessDisplayName(harness) : "The coding harness";
  switch (category) {
    case "no_first_edit":
      return `${harnessName} finished without making a code edit, so no PR was opened.`;
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
    case "command_failed":
      return `${harnessName} or one of its sandbox commands failed.`;
    case "unknown":
      return "The code-update task failed without a recognized failure category.";
  }
}

function codegenFailureNextAction(category: CodegenFailureCategory, failedPhase: string | null) {
  switch (category) {
    case "no_first_edit":
      return "Inspect the harness transcript, prompt, and repository navigation context; improve repo ownership docs or task instructions so the agent makes an early focused edit.";
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
    case "command_failed":
      return `Inspect the ${failedPhase ?? "latest"} command log and harness transcript for the first non-zero exit or thrown error.`;
    case "unknown":
      return "Inspect the terminal command log and failure artifact, then add a classifier if this is a recurring failure mode.";
  }
}

function codegenHarnessDisplayName(harness: CodegenHarness) {
  return harness === "opencode" ? "OpenCode" : "Codex";
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
