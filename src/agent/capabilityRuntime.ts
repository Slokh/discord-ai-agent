import type { AgentResponse } from "../tools/types.js";
import type { ToolName } from "../tools/toolDefinition.js";

export type AgentPromptContribution = {
  section: string;
  stability: "stable" | "turn";
  content: string;
};

/** Per-turn extension surface between the generic agent loop and installed capabilities. */
export type AgentCapabilityRuntime = {
  model?: string;
  promptContributions: AgentPromptContribution[];
  observeToolResult(toolName: ToolName, result: AgentResponse): void;
  finalizeResponse(response: AgentResponse): Promise<AgentResponse>;
  blocksTimeoutRecovery(): boolean;
};

export type PreparedAgentCapability = Partial<AgentCapabilityRuntime>;
