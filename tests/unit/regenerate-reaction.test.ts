import { describe, expect, it } from "vitest";
import { PermissionsBitField } from "discord.js";
import {
  canTriggerImageRegeneration,
  canTriggerReplyRegeneration,
  CODING_AGENT_TOOL_NAMES,
  IMAGE_GENERATION_TOOL_NAMES,
  IMAGE_REGENERATION_REACTION_EMOJIS,
  involvesCodingAgentTools,
  involvesImageGenerationTools,
  isImageRegenerationReaction,
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

describe("isImageRegenerationReaction", () => {
  it("matches each image regeneration emoji", () => {
    for (const emoji of IMAGE_REGENERATION_REACTION_EMOJIS) {
      expect(isImageRegenerationReaction({ id: null, name: emoji })).toBe(true);
    }
    expect(isImageRegenerationReaction({ id: null, name: "🔄" })).toBe(true);
    expect(isImageRegenerationReaction({ id: null, name: "🔁" })).toBe(true);
    expect(isImageRegenerationReaction({ id: null, name: "🎲" })).toBe(true);
  });

  it("rejects custom guild emojis that look like regeneration emojis", () => {
    expect(isImageRegenerationReaction({ id: "123456789", name: "game_die" })).toBe(false);
    expect(isImageRegenerationReaction({ id: "123456789", name: "🔄" })).toBe(false);
  });

  it("rejects other unicode emojis", () => {
    expect(isImageRegenerationReaction({ id: null, name: "❌" })).toBe(false);
    expect(isImageRegenerationReaction({ id: null, name: "👍" })).toBe(false);
    expect(isImageRegenerationReaction({ id: null, name: "♻️" })).toBe(false);
  });

  it("handles nullish emoji input", () => {
    expect(isImageRegenerationReaction(null)).toBe(false);
    expect(isImageRegenerationReaction(undefined)).toBe(false);
  });
});

describe("involvesImageGenerationTools", () => {
  it("flags the generateImage tool", () => {
    expect(involvesImageGenerationTools(["generateImage"])).toBe(true);
    expect(involvesImageGenerationTools(["searchDiscordHistory", "generateImage"])).toBe(true);
  });

  it("does not flag non-image tools", () => {
    expect(involvesImageGenerationTools(["searchDiscordHistory", "getDiscordStats"])).toBe(false);
    expect(involvesImageGenerationTools([])).toBe(false);
  });

  it("IMAGE_GENERATION_TOOL_NAMES covers generateImage", () => {
    expect(IMAGE_GENERATION_TOOL_NAMES.has("generateImage")).toBe(true);
  });
});

describe("canTriggerImageRegeneration", () => {
  it("allows the original prompter", () => {
    expect(
      canTriggerImageRegeneration({
        reactorId: "user-1",
        originalPrompterId: "user-1"
      })
    ).toBe(true);
  });

  it("rejects other users", () => {
    expect(
      canTriggerImageRegeneration({
        reactorId: "user-2",
        originalPrompterId: "user-1"
      })
    ).toBe(false);
  });

  it("does not grant an admin override for image regeneration", () => {
    // Image regeneration is prompter-only by design; admins cannot regenerate
    // another user's image via reaction.
    expect(
      canTriggerImageRegeneration({
        reactorId: "admin-1",
        originalPrompterId: "user-1"
      })
    ).toBe(false);
  });

  it("rejects when the original prompter is unknown", () => {
    expect(
      canTriggerImageRegeneration({
        reactorId: "user-1",
        originalPrompterId: null
      })
    ).toBe(false);
  });

  it("rejects when the reactor id is missing", () => {
    expect(
      canTriggerImageRegeneration({
        reactorId: null,
        originalPrompterId: "user-1"
      })
    ).toBe(false);
  });
});
