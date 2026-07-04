import { describe, expect, it } from "vitest";
import { PermissionsBitField } from "discord.js";
import {
  canTriggerReplyRegeneration,
  CODING_AGENT_TOOL_NAMES,
  involvesCodingAgentTools,
  isRegenerateReplyReaction,
  REGENERATE_REPLY_REACTION_EMOJI
} from "../../src/discord/regenerateReaction.js";

describe("isRegenerateReplyReaction", () => {
  it("matches the unicode counterclockwise arrows emoji", () => {
    expect(isRegenerateReplyReaction({ id: null, name: "🔄" })).toBe(true);
    expect(isRegenerateReplyReaction({ id: null, name: REGENERATE_REPLY_REACTION_EMOJI })).toBe(true);
  });

  it("rejects custom guild emojis that look like counterclockwise arrows", () => {
    expect(isRegenerateReplyReaction({ id: "123456789", name: "counterclockwise_arrows" })).toBe(false);
  });

  it("rejects other unicode emojis", () => {
    expect(isRegenerateReplyReaction({ id: null, name: "❌" })).toBe(false);
    expect(isRegenerateReplyReaction({ id: null, name: "👍" })).toBe(false);
  });

  it("handles nullish emoji input", () => {
    expect(isRegenerateReplyReaction(null)).toBe(false);
    expect(isRegenerateReplyReaction(undefined)).toBe(false);
  });
});

describe("involvesCodingAgentTools", () => {
  it("flags the listed coding-agent tools", () => {
    expect(involvesCodingAgentTools(["runCodingAgent"])).toBe(true);
    expect(involvesCodingAgentTools(["getAgentTaskStatus"])).toBe(true);
    expect(involvesCodingAgentTools(["listAgentTasks", "searchDiscordHistory"])).toBe(true);
    expect(involvesCodingAgentTools(["retryAgentTask"])).toBe(true);
    expect(involvesCodingAgentTools(["cancelAgentTask"])).toBe(true);
  });

  it("flags other coding-related tools in the registry", () => {
    expect(involvesCodingAgentTools(["inspectAgentLogs"])).toBe(true);
    expect(involvesCodingAgentTools(["getDeploymentStatus"])).toBe(true);
  });

  it("does not flag conversational tools", () => {
    expect(involvesCodingAgentTools(["searchDiscordHistory", "getDiscordStats", "summarizeDiscordHistory"])).toBe(false);
    expect(involvesCodingAgentTools([])).toBe(false);
  });

  it("CODING_AGENT_TOOL_NAMES covers the requested set", () => {
    for (const name of [
      "runCodingAgent",
      "getAgentTaskStatus",
      "listAgentTasks",
      "retryAgentTask",
      "cancelAgentTask"
    ]) {
      expect(CODING_AGENT_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

describe("canTriggerReplyRegeneration", () => {
  function permissionsWith(...flags: bigint[]) {
    const set = new Set(flags);
    return {
      has: (flag: bigint) => set.has(flag)
    };
  }

  it("allows the original requester", () => {
    expect(
      canTriggerReplyRegeneration({
        reactorId: "user-1",
        originalRequesterId: "user-1",
        memberPermissions: permissionsWith()
      })
    ).toBe(true);
  });

  it("rejects other users without admin permissions", () => {
    expect(
      canTriggerReplyRegeneration({
        reactorId: "user-2",
        originalRequesterId: "user-1",
        memberPermissions: permissionsWith()
      })
    ).toBe(false);
  });

  it("allows server admins with Manage Messages", () => {
    expect(
      canTriggerReplyRegeneration({
        reactorId: "user-2",
        originalRequesterId: "user-1",
        memberPermissions: permissionsWith(PermissionsBitField.Flags.ManageMessages)
      })
    ).toBe(true);
  });

  it("allows server admins with Administrator", () => {
    expect(
      canTriggerReplyRegeneration({
        reactorId: "user-2",
        originalRequesterId: "user-1",
        memberPermissions: permissionsWith(PermissionsBitField.Flags.Administrator)
      })
    ).toBe(true);
  });

  it("rejects when member permissions are unavailable", () => {
    expect(
      canTriggerReplyRegeneration({
        reactorId: "user-2",
        originalRequesterId: "user-1",
        memberPermissions: null
      })
    ).toBe(false);
  });

  it("rejects when the original requester is unknown", () => {
    expect(
      canTriggerReplyRegeneration({
        reactorId: "user-2",
        originalRequesterId: null,
        memberPermissions: permissionsWith()
      })
    ).toBe(false);
  });
});
