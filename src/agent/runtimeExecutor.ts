import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentRuntimeTurnEnvelope } from "./runtimeEnvelope.js";
import { executeInProcessAgentRuntime } from "./inProcessRuntimeExecutor.js";

export type AgentRuntimePromptExecutionInput = {
  toolContext: ToolContext;
  text: string;
  timeoutMs: number;
  turnEnvelope: AgentRuntimeTurnEnvelope;
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
      timeoutMs: input.timeoutMs
    });
  }
}

export class WarmSandboxAgentRuntimePromptExecutor implements AgentRuntimePromptExecutor {
  readonly name = "warm-sandbox";

  async execute(input: AgentRuntimePromptExecutionInput): Promise<AgentResponse> {
    throw new Error(
      `Warm sandbox agent runtime execution is not implemented yet. Stored replay envelope for request ${input.turnEnvelope.requestId}.`
    );
  }
}
