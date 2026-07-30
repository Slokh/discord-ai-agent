import type { AgentResponse, ToolContext } from "../tools/types.js";
import { ensureAutomaticStarterFunds } from "../tools/walletTools.js";
import {
  executeAgentModelCommand,
  loadAgentModelOverride,
} from "../tools/agentModelTools.js";
import { coinflipWagerClarification } from "../tools/wagerIntent.js";
import {
  activeGameActionNeedsRandomDraw,
  loadActiveGameSession,
  type ActiveGameSessionContext,
} from "./activeGameSession.js";
import { FreshExternalDataGuard } from "./freshExternalDataGuard.js";
import { PublicUrlEvidenceGuard } from "./publicUrlEvidenceGuard.js";
import { randomActionAuthorizedForTurn, RandomOutcomeGuard } from "./randomOutcomeGuard.js";
import { RichPresentationOutcomeGuard } from "./richPresentationOutcomeGuard.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export type AgentModelLoopRequest = {
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
  execute: (request: AgentModelLoopRequest, executionText: string) => Promise<AgentResponse>,
): Promise<AgentResponse> {
  ctx.requestText = userText;
  await loadAgentModelOverride(ctx);
  const agentModelCommand = await executeAgentModelCommand(ctx, userText);
  if (agentModelCommand && !agentModelCommand.continuationText) {
    return agentModelCommand.response;
  }
  const executionText = agentModelCommand?.continuationText ?? userText;
  const coinflipClarification = ctx.config.payments?.userWalletsEnabled
    ? coinflipWagerClarification(executionText)
    : null;
  if (coinflipClarification) {
    await recordAgentEvent(ctx, {
      eventName: "wallet.wager.clarification_requested",
      summary: "Requested the missing coinflip side before reserving funds",
      metadata: { game: "coinflip" },
    });
    return combineModelCommandResponse(agentModelCommand?.response, {
      content: coinflipClarification,
    });
  }

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
  const urlGroundedResponse = await publicUrlEvidenceGuard.enforce(response);
  const freshResponse = await freshExternalDataGuard.enforce(urlGroundedResponse);
  const randomSafeResponse = await randomOutcomeGuard.enforce(freshResponse);
  const guardedResponse = await richPresentationOutcomeGuard.enforce(randomSafeResponse);
  return combineModelCommandResponse(agentModelCommand?.response, guardedResponse);
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
