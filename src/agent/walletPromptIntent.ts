const NEGATED_REAL_WALLET = /\b(?:do\s+not|don['’]?t|dont|never|without|avoid|skip|ignore)\b[^.!?\n]{0,80}\b(?:real|actual|on[- ]?chain|managed)\s+(?:wallet|balance|money|funds?|bankroll|usd|dollars?)\b/i;
const NEGATED_WALLET_ACTION = /\b(?:do\s+not|don['’]?t|dont|never)\s+(?:actually\s+)?(?:use|touch|check|read|show|send|transfer|pay|tip|deposit|withdraw|fund|charge|move)\b[^.!?\n]{0,64}(?:\b(?:wallet|balance|funds?|money|usd|dollars?)\b|\$\s*(?:\d|\.\d))/i;
const WITHOUT_REAL_WALLET = /\bwithout\s+(?:using|touching|checking|changing|charging)?\s*(?:the\s+|my\s+|your\s+)?(?:wallet|balance|real\s+(?:money|funds?|balance)|actual\s+(?:money|funds?|balance))\b/i;
const PLAY_MONEY = /\b(?:play|fake|fictional|imaginary|pretend|simulated|virtual)\s+(?:money|wallet|balance|funds?|bankroll|currency|dollars?)\b/i;

/**
 * Returns true only for an explicit request-scoped opt-out from real managed
 * wallet activity. This is shared by deterministic balance routing, starter
 * funding, and user transfers so one prompt cannot be interpreted differently
 * at different stages of the request lifecycle.
 */
export function promptExcludesRealWallet(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return NEGATED_REAL_WALLET.test(normalized) ||
    NEGATED_WALLET_ACTION.test(normalized) ||
    WITHOUT_REAL_WALLET.test(normalized) ||
    PLAY_MONEY.test(normalized);
}
