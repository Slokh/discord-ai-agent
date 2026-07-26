import type { AgentResponse, ToolContext } from "../tools/types.js";
import { ensureAutomaticStarterFunds } from "../tools/walletTools.js";
import { coinflipWagerClarification } from "../tools/wagerIntent.js";
import {
  activeGameActionNeedsRandomDraw,
  loadActiveGameSession,
  type ActiveGameSessionContext,
} from "./activeGameSession.js";
import { FreshExternalDataGuard } from "./freshExternalDataGuard.js";
import { PublicUrlEvidenceGuard } from "./publicUrlEvidenceGuard.js";
import { RandomOutcomeGuard } from "./randomOutcomeGuard.js";
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
  execute: (request: AgentModelLoopRequest) => Promise<AgentResponse>,
): Promise<AgentResponse> {
  ctx.requestText = userText;
  const coinflipClarification = ctx.config.payments?.userWalletsEnabled
    ? coinflipWagerClarification(userText)
    : null;
  if (coinflipClarification) {
    await recordAgentEvent(ctx, {
      eventName: "wallet.wager.clarification_requested",
      summary: "Requested the missing coinflip side before reserving funds",
      metadata: { game: "coinflip" },
    });
    return { content: coinflipClarification };
  }

  const automaticStarterFunds = await ensureAutomaticStarterFunds(ctx);
  const activeGame = await loadActiveGameSession(ctx, userText);
  const activeGameNeedsRandomDraw = activeGameActionNeedsRandomDraw(activeGame, userText);
  const randomOutcomeGuard = new RandomOutcomeGuard(ctx, userText, activeGameNeedsRandomDraw);
  const richPresentationOutcomeGuard = new RichPresentationOutcomeGuard(ctx);
  if (activeGame?.actionRequested) randomOutcomeGuard.noteActiveWager(activeGame.wager.id);
  const freshExternalDataGuard = new FreshExternalDataGuard(ctx, userText);
  const publicUrlEvidenceGuard = new PublicUrlEvidenceGuard(ctx, userText);
  const response = await execute({
    randomOutcomeGuard,
    freshExternalDataGuard,
    publicUrlEvidenceGuard,
    richPresentationOutcomeGuard,
    activeGame,
    activeGameNeedsRandomDraw,
    automaticStarterFunds,
  });
  const urlGroundedResponse = await publicUrlEvidenceGuard.enforce(response);
  const freshResponse = await freshExternalDataGuard.enforce(urlGroundedResponse);
  const randomSafeResponse = await randomOutcomeGuard.enforce(freshResponse);
  return await richPresentationOutcomeGuard.enforce(randomSafeResponse);
}
