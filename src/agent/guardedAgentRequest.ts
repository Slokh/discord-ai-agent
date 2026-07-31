import type { AgentResponse, ToolContext } from "../tools/types.js";
import { ensureAutomaticStarterFunds } from "../tools/walletTools.js";
import {
  executeAgentModelCommand,
  loadAgentModelOverride,
} from "../tools/agentModelTools.js";
import {
  activeGameActionNeedsRandomDraw,
  loadActiveGameSession,
  type ActiveGameSessionContext,
} from "./activeGameSession.js";
import { FreshExternalDataGuard } from "./freshExternalDataGuard.js";
import { MemberAvailabilityGuard } from "./memberAvailabilityGuard.js";
import { PublicUrlEvidenceGuard } from "./publicUrlEvidenceGuard.js";
import { randomActionAuthorizedForTurn, RandomOutcomeGuard } from "./randomOutcomeGuard.js";
import { RichPresentationOutcomeGuard } from "./richPresentationOutcomeGuard.js";

export type GuardedAgentRequest = {
  randomOutcomeGuard: RandomOutcomeGuard;
  freshExternalDataGuard: FreshExternalDataGuard;
  publicUrlEvidenceGuard: PublicUrlEvidenceGuard;
  richPresentationOutcomeGuard: RichPresentationOutcomeGuard;
  activeGame: ActiveGameSessionContext | null;
  activeGameNeedsRandomDraw: boolean;
  automaticStarterFunds: string | null;
};

export async function runGuardedAgentRequest(
  ctx: ToolContext,
  userText: string,
  execute: (request: GuardedAgentRequest, executionText: string) => Promise<AgentResponse>,
): Promise<AgentResponse> {
  ctx.requestText = userText;
  await loadAgentModelOverride(ctx);
  const agentModelCommand = await executeAgentModelCommand(ctx, userText);
  if (agentModelCommand && !agentModelCommand.continuationText) {
    return agentModelCommand.response;
  }
  const executionText = agentModelCommand?.continuationText ?? userText;
  const automaticStarterFunds = await ensureAutomaticStarterFunds(ctx);
  const activeGame = await loadActiveGameSession(ctx, executionText);
  const activeGameNeedsRandomDraw = activeGameActionNeedsRandomDraw(activeGame, executionText);
  ctx.randomActionAuthorized = randomActionAuthorizedForTurn({
    userText: executionText,
    replyContext: ctx.replyContext,
    activeGameActionRequested: activeGame?.actionRequested,
  });
  const randomOutcomeGuard = new RandomOutcomeGuard(ctx, executionText, activeGameNeedsRandomDraw);
  const richPresentationOutcomeGuard = new RichPresentationOutcomeGuard(ctx);
  if (activeGame?.actionRequested) randomOutcomeGuard.noteActiveWager(activeGame.wager.id);
  const freshExternalDataGuard = new FreshExternalDataGuard(ctx, executionText);
  const publicUrlEvidenceGuard = new PublicUrlEvidenceGuard(ctx, executionText);
  const response = await execute({
    randomOutcomeGuard,
    freshExternalDataGuard,
    publicUrlEvidenceGuard,
    richPresentationOutcomeGuard,
    activeGame,
    activeGameNeedsRandomDraw,
    automaticStarterFunds,
  }, executionText);
  const memberAvailabilityGuard = new MemberAvailabilityGuard(ctx);
  const memberDecision = await memberAvailabilityGuard.inspectDraft(response.content);
  const memberSafeResponse = memberDecision === "allow"
    ? response
    : memberAvailabilityGuard.blockedResponse(responseWithoutContent(response));
  const urlGroundedResponse = await publicUrlEvidenceGuard.enforce(memberSafeResponse);
  const freshResponse = await freshExternalDataGuard.enforce(urlGroundedResponse);
  const randomSafeResponse = await randomOutcomeGuard.enforce(freshResponse);
  const guardedResponse = await richPresentationOutcomeGuard.enforce(randomSafeResponse);
  return combineModelCommandResponse(agentModelCommand?.response, guardedResponse);
}

function responseWithoutContent(response: AgentResponse): Omit<AgentResponse, "content"> {
  const copy = { ...response };
  delete (copy as Partial<AgentResponse>).content;
  return copy;
}

function combineModelCommandResponse(
  commandResponse: AgentResponse | undefined,
  response: AgentResponse,
): AgentResponse {
  if (!commandResponse) return response;
  return {
    ...response,
    content: `${commandResponse.content}\n\n${response.content}`.trim(),
  };
}
