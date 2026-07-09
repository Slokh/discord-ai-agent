import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentRuntimeTurnEnvelope } from "./runtimeEnvelope.js";
import { executeInProcessAgentRuntime } from "./inProcessRuntimeExecutor.js";

export type AgentRuntimePromptExecutionInput = {
  toolContext: ToolContext;
  text: string;
  timeoutMs: number;
  silenceTimeoutMs?: number;
  hardTimeoutMs?: number;
  turnEnvelope: AgentRuntimeTurnEnvelope;
  inputLinesArtifactId?: string | null;
  inputLines?: string[];
};

export type AgentRuntimePromptExecutor = {
  name: string;
  execute: (input: AgentRuntimePromptExecutionInput) => Promise<AgentResponse>;
};

export class InProcessAgentRuntimePromptExecutor implements AgentRuntimePromptExecutor {
  readonly name = "in-process";

  async execute(input: AgentRuntimePromptExecutionInput): Promise<AgentResponse> {
    return executeInProcessAgentRuntime({
      toolContext: input.toolContext,
      text: input.text,
      timeoutMs: input.timeoutMs,
      silenceTimeoutMs: input.silenceTimeoutMs,
      hardTimeoutMs: input.hardTimeoutMs
    });
  }
}
