/**
 * Private feedback may be replayed only when the CLI can reconstruct every
 * input the asserted tool needs. The prompt runner can restore requester and
 * channel scope, but deliberately does not recreate Discord attachments.
 */
export function privateFeedbackReplaySkipReason(input: {
  hasAssertion: boolean;
  hasReplayScope: boolean;
  expectedTools: string[];
}): string | null {
  if (!input.hasAssertion) {
    return "Reviewer must add an expected/forbidden tool or answer phrase before this case can grade behavior.";
  }
  if (!input.hasReplayScope) {
    return "The original requester's visible-channel scope is unavailable, so this case cannot be replayed faithfully.";
  }
  if (input.expectedTools.includes("inspectDiscordFile")) {
    return "Discord attachments from the original request are not reproduced by private evals, so this file-inspection case requires manual review.";
  }
  return null;
}
