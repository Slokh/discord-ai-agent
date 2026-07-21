import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";

const createDiscordPoll = vi.fn();
const addDiscordReaction = vi.fn();
const updateBotAvatar = vi.fn();
const createDiscordEmoji = vi.fn();

vi.mock("../../src/tools/discordPollTools.js", () => ({ createDiscordPoll }));
vi.mock("../../src/tools/discordReactionTools.js", () => ({ addDiscordReaction }));
vi.mock("../../src/tools/botProfileTools.js", () => ({ updateBotAvatar }));
vi.mock("../../src/tools/guildEmojiTools.js", () => ({ createDiscordEmoji }));

const { executeDiscordActionToolRoute } = await import("../../src/agent/discordActionToolRoutes.js");

const ctx = { config: { maxReplyChars: 1_800 } } as ToolContext;

function route(name: AgentToolRoute["name"], args: Record<string, unknown>): AgentToolRoute {
  return { id: "call-1", name, arguments: args, argumentsText: JSON.stringify(args) };
}

describe("executeDiscordActionToolRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createDiscordPoll.mockResolvedValue("poll created");
    addDiscordReaction.mockResolvedValue("reaction added");
    updateBotAvatar.mockResolvedValue("avatar updated");
    createDiscordEmoji.mockResolvedValue("emoji created");
  });

  it("routes native poll arguments", async () => {
    await expect(executeDiscordActionToolRoute(ctx, route("createDiscordPoll", {
      question: "Pick one",
      answers: [" One ", "", "Two"],
      durationHours: "48",
      allowMultiselect: "false",
    }), "fallback question")).resolves.toEqual({ content: "poll created" });
    expect(createDiscordPoll).toHaveBeenCalledWith(ctx, {
      question: "Pick one",
      answers: ["One", "Two"],
      durationHours: 48,
      allowMultiselect: false,
    });
  });

  it("routes Discord reaction arguments with the exact current request", async () => {
    await expect(executeDiscordActionToolRoute(ctx, route("addDiscordReaction", {
      messageIdOrUrl: " message ",
      emoji: " 👍 ",
    }), "add 👍 to that message")).resolves.toEqual({ content: "reaction added" });
    expect(addDiscordReaction).toHaveBeenCalledWith(ctx, {
      messageIdOrUrl: "message",
      emoji: "👍",
    }, "add 👍 to that message");
  });

  it("routes avatar image context arguments", async () => {
    await expect(executeDiscordActionToolRoute(ctx, route("updateBotAvatar", {
      imageUrl: " https://example.com/avatar.png ",
      messageIdOrUrl: "message",
      useContextImage: "yes",
    }), "change avatar")).resolves.toEqual({ content: "avatar updated" });
    expect(updateBotAvatar).toHaveBeenCalledWith(ctx, {
      imageUrl: "https://example.com/avatar.png",
      messageIdOrUrl: "message",
      useContextImage: true,
    });
  });

  it("routes custom emoji arguments and ignores unrelated tools", async () => {
    await expect(executeDiscordActionToolRoute(ctx, route("createDiscordEmoji", {
      name: "wizard",
      useContextImage: true,
    }), "upload emoji")).resolves.toEqual({ content: "emoji created" });
    expect(createDiscordEmoji).toHaveBeenCalledWith(ctx, {
      name: "wizard",
      imageUrl: undefined,
      messageIdOrUrl: undefined,
      useContextImage: true,
    });
    await expect(executeDiscordActionToolRoute(ctx, route("listTools", {}), "tools")).resolves.toBeNull();
  });
});
