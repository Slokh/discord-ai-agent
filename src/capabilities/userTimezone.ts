import type { AgentPromptContribution } from "../agent/capabilityRuntime.js";
import type { ToolContext } from "../tools/types.js";
import { DEFAULT_USER_TIMEZONE, normalizeIanaTimezone, USER_TIMEZONE_PREFERENCE_KEY } from "../util/timezone.js";
import { freshDataPromptContribution } from "./freshData.js";

type UserTimezoneRepository = {
  getUserPreference(userId: string, key: string): Promise<{ value: unknown } | undefined>;
};

export async function prepareUserTimezoneCapability(
  ctx: ToolContext,
  now = new Date(),
): Promise<{ promptContribution: AgentPromptContribution }> {
  const repo = ctx.repo as unknown as Partial<UserTimezoneRepository>;
  const stored = typeof repo.getUserPreference === "function"
    ? await repo.getUserPreference(ctx.userId, USER_TIMEZONE_PREFERENCE_KEY)
    : undefined;
  const storedTimezone = typeof stored?.value === "string" ? stored.value : undefined;
  const timezone = normalizeIanaTimezone(storedTimezone) ?? DEFAULT_USER_TIMEZONE;
  return {
    promptContribution: freshDataPromptContribution(now, {
      timezone,
      hasOverride: Boolean(stored && timezone !== DEFAULT_USER_TIMEZONE),
    }),
  };
}
