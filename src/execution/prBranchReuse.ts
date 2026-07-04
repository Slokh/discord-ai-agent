// Detects when a code-update request references an existing pull request so the
// sandbox runner can reuse that PR's branch instead of opening a new one.

const PR_URL_PATTERN = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d{1,7})/i;
const PR_NUMBER_PATTERN = /\bpr\s*#?\s*(\d{1,7})\b/i;

const PR_FOLLOWUP_KEYWORDS = [
  "merge conflict",
  "merge conflicts",
  "fix conflict",
  "fix the conflict",
  "resolve conflict",
  "resolve the conflict",
  "resolve the merge conflict",
  "fix the merge conflict",
  "rebase conflict",
  "conflict markers",
  "follow-up change",
  "follow up change",
  "followup change",
  "follow-up pr",
  "follow up pr",
  "update the existing pr",
  "update existing pr",
  "existing pr",
  "push to the existing pr",
  "push to existing pr",
  "update the pr",
  "update that pr",
  "amend the pr",
  "fix the pr",
  "fix that pr"
];

const MERGE_CONFLICT_KEYWORDS = [
  "merge conflict",
  "merge conflicts",
  "fix conflict",
  "fix the conflict",
  "resolve conflict",
  "resolve the conflict",
  "resolve the merge conflict",
  "fix the merge conflict",
  "rebase conflict",
  "conflict markers"
];

export type ExistingPrReference =
  | { kind: "url"; prNumber: number; owner: string; repo: string }
  | { kind: "number"; prNumber: number };

export function detectExistingPrReference(taskRequest: string): ExistingPrReference | null {
  if (!taskRequest) return null;
  const urlMatch = taskRequest.match(PR_URL_PATTERN);
  if (urlMatch) {
    const prNumber = Number.parseInt(urlMatch[3], 10);
    if (Number.isFinite(prNumber) && prNumber > 0) {
      return { kind: "url", prNumber, owner: urlMatch[1], repo: urlMatch[2] };
    }
  }
  const numberMatch = taskRequest.match(PR_NUMBER_PATTERN);
  if (numberMatch) {
    const prNumber = Number.parseInt(numberMatch[1], 10);
    if (Number.isFinite(prNumber) && prNumber > 0) {
      return { kind: "number", prNumber };
    }
  }
  return null;
}

export function hasPrFollowupKeyword(taskRequest: string): boolean {
  if (!taskRequest) return false;
  const lower = taskRequest.toLowerCase();
  return PR_FOLLOWUP_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export function hasMergeConflictKeyword(taskRequest: string): boolean {
  if (!taskRequest) return false;
  const lower = taskRequest.toLowerCase();
  return MERGE_CONFLICT_KEYWORDS.some((keyword) => lower.includes(keyword));
}
