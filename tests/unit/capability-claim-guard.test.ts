import { describe, expect, it } from "vitest";
import { correctKnownCapabilityClaim } from "../../src/agent/capabilityClaimGuard.js";
import type { DiscordReplyContext, ToolContext } from "../../src/tools/types.js";

function context(overrides: Partial<ToolContext> = {}) {
  return {
    requestAttachments: [],
    ...overrides,
  } as ToolContext;
}

function replyContext(content: string, attachments: DiscordReplyContext["attachments"] = []): DiscordReplyContext {
  const message = {
    messageId: "parent",
    channelId: "channel",
    guildId: "guild",
    authorId: "user",
    authorDisplayName: "User",
    authorIsBot: false,
    content,
    attachmentSummaries: [],
    attachments,
    createdAt: null,
    url: null,
  };
  return { ...message, rootMessageId: "parent", chain: [message] };
}

describe("known capability claim guard", () => {
  it("corrects a hard transcription refusal when the missing input is a Discord attachment", () => {
    const result = correctKnownCapabilityClaim(
      context(),
      "please transcribe the recording",
      "I can't transcribe audio or video files in this environment.",
    );

    expect(result).toEqual({
      content: "I can transcribe common audio and video attachments. Attach the media here or reply to the Discord message containing it, and I’ll transcribe it.",
      corrected: true,
      capability: "discord_media_transcription",
    });
  });

  it("uses reply context to protect vague transcription follow-ups", () => {
    const result = correctKnownCapabilityClaim(
      context({ replyContext: replyContext("Can you transcribe this video?") }),
      "try again",
      "Video transcription isn't supported here.",
    );

    expect(result.corrected).toBe(true);
  });

  it("leaves accurate missing-input guidance unchanged", () => {
    const content = "I can transcribe it, but I need you to attach the video first.";
    expect(correctKnownCapabilityClaim(context(), "transcribe this clip", content)).toEqual({
      content,
      corrected: false,
    });
  });

  it("does not hide a real processing failure when media was attached", () => {
    const attachment = { id: "file", url: "https://cdn.example/file.mp4" };
    const content = "I couldn't transcribe the video because processing failed.";
    expect(correctKnownCapabilityClaim(
      context({ requestAttachments: [attachment] }),
      "transcribe this video",
      content,
    )).toEqual({ content, corrected: false });
  });

  it("does not rewrite an unrelated capability answer", () => {
    const content = "I can't generate a live concert recording.";
    expect(correctKnownCapabilityClaim(context(), "write a concert plan", content)).toEqual({
      content,
      corrected: false,
    });
  });
});
