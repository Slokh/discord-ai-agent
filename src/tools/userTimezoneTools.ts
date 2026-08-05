import { summarizeForAudit } from "../util/text.js";
import { DEFAULT_USER_TIMEZONE, normalizeIanaTimezone, USER_TIMEZONE_PREFERENCE_KEY } from "../util/timezone.js";
import type { AgentResponse, ToolContext } from "./types.js";

type UserTimezoneRepository = {
  setUserPreference(input: { userId: string; key: string; value: unknown }): Promise<unknown>;
  clearUserPreference(userId: string, key: string): Promise<boolean>;
};

export async function setMyTimezone(
  ctx: ToolContext,
  input: { action?: string; timezone?: string },
): Promise<AgentResponse> {
  const action = normalizeAction(input.action);
  if (!action) return failure(ctx, input, "timezone_action_invalid", "Use set or reset. No timezone setting was changed.");
  const repo = timezoneRepository(ctx);
  if (!repo) {
    return failure(
      ctx,
      input,
      "timezone_settings_unavailable",
      "Timezone settings are unavailable because the durable user-settings repository is not configured.",
    );
  }

  if (action === "reset") {
    await repo.clearUserPreference(ctx.userId, USER_TIMEZONE_PREFERENCE_KEY);
    await auditTimezoneChange(ctx, { action: "reset" }, DEFAULT_USER_TIMEZONE).catch(() => undefined);
    return success("Reset your timezone to the UTC default. It will be used beginning with your next request.");
  }

  const timezone = normalizeIanaTimezone(input.timezone);
  if (!timezone) {
    return failure(
      ctx,
      input,
      "timezone_invalid",
      "I couldn’t validate that timezone. Use an IANA timezone such as `America/New_York`, `Europe/London`, or `Asia/Tokyo`. No setting was changed.",
    );
  }
  if (timezone === DEFAULT_USER_TIMEZONE) {
    await repo.clearUserPreference(ctx.userId, USER_TIMEZONE_PREFERENCE_KEY);
  } else {
    await repo.setUserPreference({ userId: ctx.userId, key: USER_TIMEZONE_PREFERENCE_KEY, value: timezone });
  }
  await auditTimezoneChange(ctx, { action: "set", timezone }, timezone).catch(() => undefined);
  const source = timezone === DEFAULT_USER_TIMEZONE ? " UTC default" : ` \`${timezone}\``;
  return success(`Set your timezone to${source}. It will be used beginning with your next request.`);
}

function normalizeAction(value: string | undefined): "set" | "reset" | null {
  const action = (value ?? "set").trim().toLowerCase();
  if (action === "clear") return "reset";
  return action === "set" || action === "reset" ? action : null;
}

function timezoneRepository(ctx: ToolContext): UserTimezoneRepository | null {
  const repo = ctx.repo as unknown as Partial<UserTimezoneRepository>;
  return typeof repo.setUserPreference === "function" &&
    typeof repo.clearUserPreference === "function"
    ? repo as UserTimezoneRepository
    : null;
}

function success(content: string): AgentResponse {
  return {
    content,
    status: "ok",
    retryable: false,
    outcome: { kind: "user_timezone", state: "succeeded", terminal: true },
  };
}

async function failure(
  ctx: ToolContext,
  input: { action?: string; timezone?: string },
  error: string,
  content: string,
): Promise<AgentResponse> {
  await auditTimezoneChange(ctx, input, undefined, error).catch(() => undefined);
  return {
    content,
    status: "error",
    errorCode: error,
    retryable: false,
    outcome: { kind: "user_timezone", state: "failed", terminal: true },
  };
}

async function auditTimezoneChange(
  ctx: ToolContext,
  input: { action?: string; timezone?: string },
  effectiveTimezone?: string,
  error?: string,
) {
  await ctx.repo.auditTool({
    traceId: ctx.requestId,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "setMyTimezone",
    argumentsSummary: summarizeForAudit(input),
    resultSummary: effectiveTimezone
      ? summarizeForAudit({ effectiveTimezone })
      : undefined,
    error,
  });
}
