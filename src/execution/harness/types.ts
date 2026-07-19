import type { CodegenContextPack } from "../contextPack.js";
import type { CodegenHarness, SandboxEnv } from "../types.js";

export type { CodegenHarness } from "../types.js";

export type AgentAttemptSummary = {
  attempt: number;
  command: "app-server" | "exec" | "resume" | "opencode-run";
  exitCode: number;
  durationMs: number;
  producedDiff: boolean;
  finalResponse?: string;
  stdoutTail: string;
  stderrTail: string;
};

export type AgentRunSummary = {
  attempts: AgentAttemptSummary[];
};

export class CodegenNoDiffError extends Error {
  readonly attempts: AgentAttemptSummary[];

  constructor(message: string, attempts: AgentAttemptSummary[] = []) {
    super(message);
    this.name = "CodegenNoDiffError";
    this.attempts = attempts;
  }
}

export type CodegenHarnessRunInput = {
  env: SandboxEnv;
  checkoutDir: string;
  gitEnv: NodeJS.ProcessEnv;
  workRoot: string;
  codexHome: string;
  opencodeHome: string;
  toolShimDir: string;
  contextPack: CodegenContextPack;
  baseRevision: string;
};

export type CodegenHarnessConfigInput = Pick<CodegenHarnessRunInput, "env" | "checkoutDir" | "codexHome" | "opencodeHome">;

export interface CodegenHarnessAdapter {
  readonly name: CodegenHarness;
  /** Human-readable harness label used in progress events and artifacts. */
  readonly artifactHarnessLabel: string;
  /** Writes the harness's ephemeral configuration before a run. */
  writeConfig(input: CodegenHarnessConfigInput): Promise<void>;
  /** Runs the harness (including its internal recovery attempts) and reports attempt summaries. */
  run(input: CodegenHarnessRunInput): Promise<AgentRunSummary>;
}
