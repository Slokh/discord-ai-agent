/**
 * Maps retained task errors to bounded operator-facing categories. Raw errors
 * can include task output, paths, and provider details, so they never leave
 * the trusted ledger.
 */
export function operatorTaskFailureSummary(status: unknown, error: unknown): string | null {
  if (String(status) !== "failed") return null;
  const text = typeof error === "string" ? error : "";
  if (/branch named .+ already exists/i.test(text)) return "The repair workspace branch already existed.";
  if (/backoff limit/i.test(text)) return "The repair retries reached their limit.";
  if (/timed? out|timeout/i.test(text)) return "The repair task timed out.";
  return "The repair task failed; retained task evidence has the details.";
}
