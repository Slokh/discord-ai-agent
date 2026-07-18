import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createDiscordEmoji } from "../../src/tools/guildEmojiTools.js";
import type { ToolContext } from "../../src/tools/types.js";
import { createAgentTurnOutput } from "../../src/tools/turnOutput.js";

const PNG_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  const turnOutput = createAgentTurnOutput();
  turnOutput.files.push({ name: "wizard.png", data: PNG_PIXEL, contentType: "image/png" });
  return {
    config: { maxReplyChars: 1_800 },
    repo: { auditTool: vi.fn(async () => undefined) },
    guildId: "guild",
    channelId: "channel",
    userId: "owner",
    userDisplayName: "Owner",
    visibleChannelIds: ["channel"],
    turnOutput,
    ...overrides,
  } as unknown as ToolContext;
}

describe("createDiscordEmoji", () => {
  it("normalizes a generated image and uploads it with a Discord-safe name", async () => {
    const create = vi.fn(async (_input: Parameters<NonNullable<ToolContext["createDiscordEmoji"]>>[0]) => ({
      id: "emoji-1",
      name: "nacho_wizard",
      animated: false,
      mention: "<:nacho_wizard:emoji-1>",
      url: "https://cdn.discordapp.com/emojis/emoji-1.webp",
    }));
    const ctx = context({ createDiscordEmoji: create });

    const response = await createDiscordEmoji(ctx, { name: ":Nacho Wizard!:" });

    expect(create).toHaveBeenCalledOnce();
    const call = create.mock.calls[0]?.[0];
    expect(call?.name).toBe("nacho_wizard");
    expect(call?.auditLogReason).toContain("Owner (owner)");
    expect(call?.image.length).toBeLessThanOrEqual(256 * 1024);
    await expect(sharp(call?.image).metadata()).resolves.toMatchObject({ width: 128, height: 128, format: "webp" });
    expect(response).toContain("<:nacho_wizard:emoji-1>");
    expect(response).toContain("128×128 WebP");
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "createDiscordEmoji" }));
  });

  it("returns a clear Discord permission failure", async () => {
    const ctx = context({
      createDiscordEmoji: vi.fn(async () => { throw new Error("the bot role needs Discord's Create Expressions permission"); }),
    });

    await expect(createDiscordEmoji(ctx, { name: "wizard" })).resolves.toContain("Create Expressions permission");
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("upload failed") }));
  });

  it("refuses an opaque generated image before uploading it as a transparent emoji", async () => {
    const opaqueJpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 220, g: 220, b: 220 } },
    }).jpeg().toBuffer();
    const create = vi.fn();
    const turnOutput = createAgentTurnOutput();
    turnOutput.files.push({ name: "checkerboard.jpg", data: opaqueJpeg, contentType: "image/jpeg" });
    const ctx = context({
      turnOutput,
      createDiscordEmoji: create,
    });

    const response = await createDiscordEmoji(ctx, { name: "checkerboard" });

    expect(response).toContain("does not contain verified alpha transparency");
    expect(response).toContain("checkerboard drawn into a JPEG/PNG is still an opaque background");
    expect(create).not.toHaveBeenCalled();
  });

  it("allows an intentionally opaque generated emoji when explicitly requested", async () => {
    const opaqueJpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 220, g: 220, b: 220 } },
    }).jpeg().toBuffer();
    const create = vi.fn(async () => ({
      id: "emoji-opaque",
      name: "tile",
      animated: false,
      mention: "<:tile:emoji-opaque>",
      url: "https://cdn.discordapp.com/emojis/emoji-opaque.webp",
    }));
    const turnOutput = createAgentTurnOutput();
    turnOutput.files.push({ name: "tile.jpg", data: opaqueJpeg, contentType: "image/jpeg" });
    const ctx = context({
      turnOutput,
      createDiscordEmoji: create,
    });

    const response = await createDiscordEmoji(ctx, { name: "tile", requireTransparent: false });

    expect(response).toContain("opaque source retained by request");
    expect(create).toHaveBeenCalledOnce();
  });

  it("accepts an explicit data image URL", async () => {
    const create = vi.fn(async (_input: Parameters<NonNullable<ToolContext["createDiscordEmoji"]>>[0]) => ({
      id: "emoji-2",
      name: "pixel",
      animated: false,
      mention: "<:pixel:emoji-2>",
      url: "https://cdn.discordapp.com/emojis/emoji-2.webp",
    }));
    const ctx = context({ turnOutput: createAgentTurnOutput(), createDiscordEmoji: create });
    const dataUrl = `data:image/png;base64,${PNG_PIXEL.toString("base64")}`;

    await expect(createDiscordEmoji(ctx, { name: "pixel", imageUrl: dataUrl }))
      .resolves.toContain("<:pixel:emoji-2>");
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects invalid names and image URL schemes before uploading", async () => {
    const create = vi.fn();
    const ctx = context({ createDiscordEmoji: create });

    await expect(createDiscordEmoji(ctx, { name: ":x:" })).resolves.toContain("2–32");
    await expect(createDiscordEmoji(ctx, { name: "wizard", imageUrl: "ftp://example.com/wizard.png" }))
      .resolves.toContain("http(s)");
    expect(create).not.toHaveBeenCalled();
  });

  it("explains when no image source is available", async () => {
    const ctx = context({ turnOutput: createAgentTurnOutput(), createDiscordEmoji: vi.fn() });
    await expect(createDiscordEmoji(ctx, { name: "wizard", useContextImage: false }))
      .resolves.toContain("generated, attached, or replied-to image");
  });
});
