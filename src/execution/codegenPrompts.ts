const MAX_CONTEXT_TEXT = 16_000;

export type CodegenPromptContextPack = {
  repoGuidePath?: string;
  repoGuideExcerpt?: string;
  requestAnchors?: string[];
  anchorMatches?: Array<{ anchor: string; file: string; line: number; preview: string }>;
  anchorTargetFiles?: Array<{ path: string; reason: string }>;
  suggestedFiles?: Array<{ path: string; reason: string }>;
  suggestedCheckCommands?: Array<{ command: string; reason: string }>;
  sandboxContract: string[];
  firstMoveRules: string[];
  projectMap: Array<{
    area: string;
    purpose: string;
    files: string[];
    checks: string[];
  }>;
};

export type CodegenPromptEnv = {
  taskId: string;
  requestedBy: string;
  taskRequest: string;
};

export type CodegenRecoveryAttempt = {
  attempt?: number;
  command?: string;
  exitCode: number;
  durationMs: number;
  producedDiff?: boolean;
  stdoutTail: string;
  stderrTail: string;
};

export function renderCodegenContextPack(context: CodegenPromptContextPack) {
  const lines = [
    ...(context.requestAnchors?.length || context.anchorTargetFiles?.length
      ? [
          "Concrete request anchors:",
          ...(context.requestAnchors?.length ? context.requestAnchors.map((anchor) => `- ${anchor}`) : ["- none found"]),
          "",
          ...(context.anchorTargetFiles?.length
            ? [
                "Target files from exact request evidence:",
                ...context.anchorTargetFiles.map((file) => `- ${file.path}: ${file.reason}`),
                "",
                "Anchor guidance:",
                "- Concrete request anchors are narrow evidence, not lifecycle classification. Inspect these files first, then follow repository docs and source ownership if they prove unrelated.",
                ""
              ]
            : []),
          ...(context.anchorMatches?.length
            ? [
                "Anchor match samples:",
                ...context.anchorMatches.slice(0, 12).map((match) => `- ${match.file}:${match.line} (${match.anchor}): ${match.preview}`),
                ""
              ]
            : [])
        ]
      : []),
    ...(context.suggestedCheckCommands?.length
      ? [
          "Suggested anchor checks:",
          ...context.suggestedCheckCommands.map((check) => `- ${check.command}: ${check.reason}`),
          ""
        ]
      : []),
    "Repository guide:",
    context.repoGuidePath ? `- ${context.repoGuidePath}` : "- none found",
    ...(context.repoGuideExcerpt
      ? [
          "",
          "Repository guide excerpt:",
          ...context.repoGuideExcerpt.split("\n").map((line) => `> ${line}`)
        ]
      : []),
    "",
    "Sandbox contract:",
    ...context.sandboxContract.map((item) => `- ${item}`),
    "",
    "First move rules:",
    ...context.firstMoveRules.map((item) => `- ${item}`),
    "",
    "Project map:"
  ];
  for (const entry of context.projectMap) {
    lines.push(`- ${entry.area}: ${entry.purpose}`);
    if (entry.files.length) lines.push(`  Files: ${entry.files.join(", ")}`);
    if (entry.checks.length) lines.push(`  Checks: ${entry.checks.join(", ")}`);
  }
  return tail(lines.join("\n"), MAX_CONTEXT_TEXT);
}

export function codeUpdatePrompt(env: CodegenPromptEnv, contextPack?: CodegenPromptContextPack) {
  const contextText = contextPack ? renderCodegenContextPack(contextPack) : "";
  return [
    "You are implementing a Discord-requested update to this TypeScript Discord AI Agent repository.",
    "",
    "Execution contract:",
    "- If AGENTS.md exists, read it before editing and follow it.",
    "- Use repository guides, exact anchors, and the project map as navigation aids, not mandatory routing.",
    "- Batch initial reconnaissance: inspect the likely owner, nearest caller/helper, closest README/guide, and closest test in one targeted pass when possible.",
    "- Make the first focused code diff after that targeted pass. Do not keep alternating search/read/search/read once the owner is clear.",
    "- If exact request anchors or target files are present, inspect those first and patch the owning source file unless it is clearly unrelated.",
    "- Let repo docs, folder READMEs, source ownership, and tests determine the implementation path.",
    "- Add or update focused tests for the changed behavior.",
    "- Validation ladder: run the closest focused tests once, fix failures from their direct output, then run `npm run typecheck` only when TypeScript contracts changed.",
    "- Run suggested anchor checks or the closest checks from repo docs when they match your edit. Do not run `npm run verify` or broad test suites; CI runs full verification after the PR opens.",
    "- If a check fails, inspect only the failing test/output and the directly owned code before patching again.",
    "- Do not commit, push, open a PR, or edit GitHub state yourself.",
    "- Do not add request-only documentation artifacts; the PR body records the request.",
    "- Helper CLIs are available under `$AGENT_TOOL_SHIM_DIR`: `agent-task-context`, `agent-cache-info`, and `agent-progress <step> <message>`.",
    "- Use `$AGENT_TOOL_SHIM_DIR/agent-cache-info` if dependency/cache state matters; do not reinstall dependencies unless the task changed dependency manifests.",
    "- After the first meaningful edit, run `$AGENT_TOOL_SHIM_DIR/agent-progress first_edit \"Made the first focused code edit\"`.",
    "",
    `Task ID: ${env.taskId}`,
    `Requested by: ${env.requestedBy}`,
    contextText ? "" : undefined,
    contextText ? "Repository navigation context:" : undefined,
    contextText || undefined,
    "",
    "Requested update:",
    env.taskRequest.trim(),
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function codeUpdateRecoveryPrompt(
  env: CodegenPromptEnv,
  input: { attempt: number; totalAttempts: number; attempts: CodegenRecoveryAttempt[]; gitStatus: string; contextPack?: CodegenPromptContextPack }
) {
  const previous = input.attempts.at(-1);
  const anchorTargetText = recoveryAnchorTargetText(input.contextPack);
  return [
    "Continue the same code-update task in this existing sandbox checkout.",
    "",
    "The previous coding harness attempt did not leave a code diff. Do not restart broad analysis.",
    "You have enough context to act: make the smallest focused test or implementation edit now, then run the most relevant check.",
    "If you need one more file, inspect it briefly and edit immediately after. Do not run more than one read/search command before the first patch on this attempt.",
    "Use apply_patch for the recovery edit when available; otherwise use the smallest reliable edit command. A small first diff is better than more clean-checkout analysis.",
    anchorTargetText ? "Patch-first targets from the original request anchors:" : undefined,
    anchorTargetText || undefined,
    anchorTargetText
      ? "On this recovery attempt, edit one of these files before additional broad searching unless the file is clearly unrelated."
      : undefined,
    "",
    `Task ID: ${env.taskId}`,
    `Attempt: ${input.attempt}/${input.totalAttempts}`,
    "",
    "Requested update:",
    env.taskRequest.trim(),
    "",
    "Current git status:",
    input.gitStatus.trim() || "(clean)",
    "",
    previous
      ? [
          "Previous attempt summary:",
          `- exit code: ${previous.exitCode}`,
          `- duration: ${formatDuration(previous.durationMs)}`,
          previous.stdoutTail ? `- stdout tail:\n${previous.stdoutTail}` : "",
          previous.stderrTail ? `- stderr tail:\n${previous.stderrTail}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
    "Finish with a real code diff. Do not commit, push, or open a PR yourself."
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function recoveryAnchorTargetText(contextPack?: CodegenPromptContextPack) {
  const targets = contextPack?.anchorTargetFiles ?? [];
  if (!targets.length) return "";
  return targets
    .slice(0, 5)
    .map((file) => `- ${file.path}: ${file.reason}`)
    .join("\n");
}

function tail(value: string, maxChars: number) {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
