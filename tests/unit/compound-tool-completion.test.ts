import { describe, expect, it } from "vitest";
import {
  CompoundToolCompletionGuard,
  requestedArtifactActionForPrompt,
} from "../../src/agent/compoundToolCompletion.js";

describe("compound tool completion", () => {
  it("recognizes generated avatar and Discord emote workflows", () => {
    expect(requestedArtifactActionForPrompt("generate a new image and use it as your pfp"))
      .toBe("updateBotAvatar");
    expect(requestedArtifactActionForPrompt("make this into a server emote named nacho_wizard"))
      .toBe("createDiscordEmoji");
    expect(requestedArtifactActionForPrompt("generate a landscape image"))
      .toBeNull();
  });

  it("forces the downstream mutation after image generation and completes only on evidence", () => {
    const guard = new CompoundToolCompletionGuard("generate a new image and use it as your pfp");
    guard.noteToolResult("generateImage", {
      content: "Generated image for: a new avatar",
      files: [{ name: "avatar.png", data: Buffer.from("image"), contentType: "image/png" }],
    });

    expect(guard.hasPendingAction()).toBe(true);
    expect(guard.takeForcedTool()).toBe("updateBotAvatar");
    expect(guard.shouldRetryMissingAction()).toBe(true);
    expect(guard.takeForcedTool()).toBe("updateBotAvatar");
    expect(guard.shouldRetryMissingAction()).toBe(false);
    expect(guard.incompleteActionResponse()).toContain("couldn't update");
    guard.noteToolResult("updateBotAvatar", {
      content: "Updated my Discord bot avatar.\nSource: generated image",
    });

    expect(guard.hasPendingAction()).toBe(false);
    expect(guard.completedAction()?.routeName).toBe("updateBotAvatar");
  });
});
