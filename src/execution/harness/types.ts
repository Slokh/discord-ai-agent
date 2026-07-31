import type { CodegenContextPack } from "../contextPack.js";
import type { SandboxEnv } from "../types.js";

export type AgentAttemptSummary = {
  attempt: number;
  command: "nanocodex-run";
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

export type NanoCodexRunInput = {
  env: SandboxEnv;
  checkoutDir: string;
  gitEnv: NodeJS.ProcessEnv;
  toolShimDir: string;
  contextPack: CodegenContextPack;
  baseRevision: string;
};
