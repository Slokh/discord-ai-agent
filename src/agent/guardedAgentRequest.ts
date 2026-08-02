import type { AgentResponse, ToolContext } from "../tools/types.js";
import { loadAgentModelOverride } from "../tools/agentModelTools.js";
import {
  loadActiveGameSession,
  type ActiveGameSessionContext,
} from "./activeGameSession.js";
import { RandomOutcomeGuard } from "./randomOutcomeGuard.js";

export type GuardedAgentRequest = {
  randomOutcomeGuard: RandomOutcomeGuard;
  activeGame: ActiveGameSessionContext | null;
};

export async function runGuardedAgentRequest(
  ctx: ToolContext,
  userText: string,
  execute: (request: GuardedAgentRequest, executionText: string) => Promise<AgentResponse>,
  onPrepared?: (request: GuardedAgentRequest) => void,
): Promise<AgentResponse> {
  ctx.requestText = userText;
  await loadAgentModelOverride(ctx);
  const executionText = userText;
  const activeGame = await loadActiveGameSession(ctx);
  const randomOutcomeGuard = new RandomOutcomeGuard(ctx, executionText);
  const request = {
    randomOutcomeGuard,
    activeGame,
  };
  onPrepared?.(request);
  const response = await execute(request, executionText);
  return randomOutcomeGuard.enforce(response);
}
