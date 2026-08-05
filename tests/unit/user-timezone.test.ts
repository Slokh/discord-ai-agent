import { describe, expect, it, vi } from "vitest";
import { prepareUserTimezoneCapability } from "../../src/capabilities/userTimezone.js";
import { setMyTimezone } from "../../src/tools/userTimezoneTools.js";
import { toolRegistry } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/types.js";
import { USER_TIMEZONE_PREFERENCE_KEY } from "../../src/util/timezone.js";

describe("user timezone preferences", () => {
  const now = new Date("2026-08-05T01:09:00.000Z");

  it("defaults requester-relative dates to UTC when no preference is stored", async () => {
    const ctx = context({ getUserPreference: vi.fn(async () => undefined) });

    const prepared = await prepareUserTimezoneCapability(ctx, now);

    expect(ctx.repo.getUserPreference).toHaveBeenCalledWith("user", USER_TIMEZONE_PREFERENCE_KEY);
    expect(prepared.promptContribution.content).toContain("Current requester timezone: UTC (default)");
    expect(prepared.promptContribution.content).toContain("Current requester-local date/time: 2026-08-05 01:09 UTC");
  });

  it("grounds relative dates in a validated stored timezone while retaining UTC context", async () => {
    const ctx = context({
      getUserPreference: vi.fn(async () => ({ value: "America/New_York" })),
    });

    const prepared = await prepareUserTimezoneCapability(ctx, now);

    expect(prepared.promptContribution.content).toContain("America/New_York (stored user override)");
    expect(prepared.promptContribution.content).toContain("2026-08-04 21:09 EDT");
    expect(prepared.promptContribution.content).toContain("Current UTC date/time: 2026-08-05 01:09 UTC");
    expect(prepared.promptContribution.content).toContain("preserve an explicit event date");
  });

  it("sets only the current requester's canonical timezone preference", async () => {
    const repo = preferenceRepo();
    const ctx = context(repo);

    await expect(setMyTimezone(ctx, {
      action: "set",
      timezone: "America/New_York",
    })).resolves.toEqual(expect.objectContaining({
      status: "ok",
      content: expect.stringContaining("America/New_York"),
      outcome: expect.objectContaining({ terminal: true }),
    }));
    expect(repo.setUserPreference).toHaveBeenCalledWith({
      userId: "user",
      key: USER_TIMEZONE_PREFERENCE_KEY,
      value: "America/New_York",
    });
    expect(repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "setMyTimezone",
      userId: "user",
    }));
  });

  it("exposes no model-supplied user identity in the mutation contract", () => {
    const contract = toolRegistry.find((tool) => tool.name === "setMyTimezone");

    expect(contract).toEqual(expect.objectContaining({ mutates: true, accessPolicy: "default" }));
    expect(contract?.parameters.properties).not.toHaveProperty("userId");
    expect(contract?.permissionRequirements).toContain("immutable_current_requester");
  });

  it("removes the override when resetting or selecting UTC", async () => {
    const repo = preferenceRepo();
    const ctx = context(repo);

    await setMyTimezone(ctx, { action: "reset" });
    await setMyTimezone(ctx, { action: "set", timezone: "UTC" });

    expect(repo.clearUserPreference).toHaveBeenNthCalledWith(1, "user", USER_TIMEZONE_PREFERENCE_KEY);
    expect(repo.clearUserPreference).toHaveBeenNthCalledWith(2, "user", USER_TIMEZONE_PREFERENCE_KEY);
    expect(repo.setUserPreference).not.toHaveBeenCalled();
  });

  it("rejects invalid timezone identifiers without changing preferences", async () => {
    const repo = preferenceRepo();
    const ctx = context(repo);

    await expect(setMyTimezone(ctx, {
      action: "set",
      timezone: "Eastern-ish",
    })).resolves.toEqual(expect.objectContaining({
      status: "error",
      errorCode: "timezone_invalid",
    }));
    expect(repo.setUserPreference).not.toHaveBeenCalled();
    expect(repo.clearUserPreference).not.toHaveBeenCalled();
    expect(repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ error: "timezone_invalid" }));
  });
});

function preferenceRepo() {
  return {
    getUserPreference: vi.fn(async () => undefined),
    setUserPreference: vi.fn(async () => undefined),
    clearUserPreference: vi.fn(async () => true),
    auditTool: vi.fn(async () => undefined),
  };
}

function context(repo: Record<string, unknown>): ToolContext {
  return {
    config: {},
    repo,
    openRouter: {},
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: ["channel"],
    requestId: "request",
    mutationAuthorizedByCurrentInput: true,
  } as unknown as ToolContext;
}
