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
  /** Repository checkout or scratch workspace the agent works in. */
  checkoutDir: string;
  gitEnv: NodeJS.ProcessEnv;
  toolShimDir: string;
  /** Repository context; scratch workspaces provide `prompt` instead. */
  contextPack?: CodegenContextPack;
  /** Repository base revision; absent for scratch workspaces, which never produce a diff. */
  baseRevision?: string;
  prompt?: string;
  instructions?: string;
  attempt?: number;
  totalAttempts?: number;
};
