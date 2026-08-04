export function isAuthorizedDiscordBugReporter(
  reportedByUserId: string,
  originalRequesterUserId: string | null | undefined,
) {
  return Boolean(originalRequesterUserId && reportedByUserId === originalRequesterUserId);
}
