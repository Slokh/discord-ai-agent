const AGENT_SELF_HISTORY_INTENT =
  /(?:\b(?:what|why|when|where)\s+(?:did|have|has)\s+(?:you|the bot)\s+(?:(?:just|ever|previously|earlier)\s+)*(?:say|said|call|called|write|wrote|reply|replied|answer|answered|claim|claimed|generate|generated|link|linked|open|opened|do|did)\b|\b(?:did|have|has)\s+(?:you|the bot)\s+(?:(?:just|ever|previously|earlier)\s+)*(?:say|said|call|called|write|wrote|reply|replied|answer|answered|claim|claimed|generate|generated|link|linked|open|opened|do|did)\b|\b(?:you|the bot)\s+(?:(?:have|has)\s+)?(?:(?:just|ever|previously|earlier)\s+)*(?:say|said|call|called|write|wrote|reply|replied|answer|answered|claim|claimed|generate|generated|link|linked|open|opened|do|did)\b|\b(?:you|the bot)\s+(?:keep|keeps|kept)\s+(?:saying|calling|doing)\b)/i;

export function requiresAgentSelfHistory(text: string): boolean {
  return AGENT_SELF_HISTORY_INTENT.test(text);
}
