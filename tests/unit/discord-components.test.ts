import { describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
import { buildDiscordModal, discordComponentToken, prepareDiscordPresentation } from "../../src/discord/components/renderer.js";
import { parseDiscordPresentation } from "../../src/discord/components/validation.js";
import { restrictedToolGate } from "../../src/agent/toolGate.js";
import { handleDiscordRichInteraction } from "../../src/discord/components/interactionHandler.js";

describe("Discord rich components", () => {
  it("validates and compiles the complete message component surface", async () => {
    const presentation = parseDiscordPresentation({
      version: 1,
      audience: "requester",
      components: [
        { type: "section", text: ["## Result", "Useful details"], accessory: { type: "thumbnail", url: "https://example.com/a.png" } },
        { type: "media_gallery", items: [{ url: "https://example.com/a.png", description: "A" }] },
        { type: "file", url: "attachment://report.csv" },
        { type: "separator", spacing: "large" },
        { type: "action_row", components: [
          { type: "button", label: "More", style: "primary", action: { type: "continue", prompt: "Explain more" } },
          { type: "button", label: "Docs", style: "link", url: "https://docs.discord.com" },
        ] },
        { type: "action_row", components: [{ type: "string_select", prompt: "Use the selection", options: [{ label: "One", value: "one" }] }] },
        { type: "action_row", components: [{ type: "user_select", prompt: "Use selected users" }] },
        { type: "action_row", components: [{ type: "role_select", prompt: "Use selected roles" }] },
        { type: "action_row", components: [{ type: "mentionable_select", prompt: "Use selected mentions" }] },
        { type: "action_row", components: [{ type: "channel_select", prompt: "Use selected channels", channelTypes: [0] }] },
        { type: "container", accentColor: 0x5865f2, components: [{ type: "text", content: "Inside" }] },
      ],
    });
    let tokenIndex = 0;
    const prepared = prepareDiscordPresentation({
      presentation,
      content: "Summary",
      fileNames: ["report.csv"],
      tokenFactory: () => `abcdefghijklmnopqrst${String(tokenIndex++).padStart(4, "0")}`,
    });
    const payload = prepared.payload as any;

    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.content).toBeNull();
    expect(payload.components.map((component: any) => component.type)).toEqual([10, 9, 12, 13, 14, 1, 1, 1, 1, 1, 1, 17]);
    expect(prepared.registrations).toHaveLength(6);
    expect(prepared.registrations.every((item) => discordComponentToken(item.customId)?.token === item.token)).toBe(true);
    expect(payload.components.filter((component: any) => component.type === 13)).toHaveLength(1);
  });

  it("compiles every current modal input type", () => {
    const modal = buildDiscordModal("ai:v1:m:abcdefghijklmnopqrstuvwx", {
      title: "All inputs",
      fields: [
        { type: "text", content: "Fill this out" },
        { type: "text_input", key: "text", label: "Text" },
        { type: "radio_group", key: "radio", label: "Radio", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] },
        { type: "checkbox_group", key: "checks", label: "Checks", options: [{ label: "A", value: "a" }] },
        { type: "file_upload", key: "file", label: "File" },
      ],
    }).toJSON() as any;

    expect(modal.custom_id).toMatch(/:submit$/);
    expect(modal.components.map((component: any) => component.type)).toEqual([10, 18, 18, 18, 18]);
    expect(modal.components.slice(1).map((component: any) => component.component.type)).toEqual([4, 21, 22, 19]);

    const selectors = buildDiscordModal("ai:v1:m:abcdefghijklmnopqrstuvwx", {
      title: "Selectors",
      fields: [
        { type: "string_select", key: "string", label: "String", options: [{ label: "A", value: "a" }] },
        { type: "user_select", key: "user", label: "User" },
        { type: "role_select", key: "role", label: "Role" },
        { type: "mentionable_select", key: "mention", label: "Mention" },
        { type: "channel_select", key: "channel", label: "Channel", channelTypes: [0] },
      ],
    }).toJSON() as any;
    expect(selectors.components.map((component: any) => component.component.type)).toEqual([3, 5, 6, 7, 8]);

    const checkbox = buildDiscordModal("ai:v1:m:abcdefghijklmnopqrstuvwx", {
      title: "Checkbox",
      fields: [{ type: "checkbox", key: "agree", label: "Agree" }],
    }).toJSON() as any;
    expect(checkbox.components[0].component.type).toBe(23);
  });

  it("rejects invalid Discord layouts before delivery", () => {
    expect(() => parseDiscordPresentation({ components: [{ type: "action_row", components: [
      { type: "string_select", prompt: "Choose", options: [{ label: "A", value: "a" }] },
      { type: "button", label: "Nope", style: "primary", action: { type: "continue", prompt: "Nope" } },
    ] }] })).toThrow(/only that select/i);
  });

  it("counts final text and nested components against Discord's 40-component limit", () => {
    const presentation = parseDiscordPresentation({
      components: Array.from({ length: 39 }, (_, index) => ({ type: "text", content: `line ${index}` })),
    });
    expect(() => prepareDiscordPresentation({ presentation, content: "body", footer: "footer" }))
      .toThrow(/at most 40/);
  });

  it("rejects cross-field constraints that Discord would reject", () => {
    expect(() => parseDiscordPresentation({ components: [{ type: "action_row", components: [{
      type: "string_select", prompt: "Choose", maxValues: 2, options: [{ label: "A", value: "a" }],
    }] }] })).toThrow(/available options/i);
    expect(() => parseDiscordPresentation({ components: [{ type: "action_row", components: [{
      type: "button", label: "Open", style: "primary", action: { type: "modal", prompt: "Use form", modal: {
        title: "Form", fields: [{ type: "text_input", key: "x", label: "X", minLength: 10, maxLength: 2 }],
      } },
    }] }] })).toThrow(/minLength/i);
    expect(() => parseDiscordPresentation({ components: [{ type: "action_row", components: [{
      type: "button", label: "Open", style: "primary", action: { type: "modal", prompt: "Use form", modal: {
        title: "Form", fields: [{ type: "file_upload", key: "file", label: "File", required: true, minValues: 0 }],
      } },
    }] }] })).toThrow(/required file upload/i);
  });

  it("validates referenced attachments before generating action registrations", () => {
    const presentation = parseDiscordPresentation({ components: [{ type: "file", url: "attachment://missing.csv" }] });
    expect(() => prepareDiscordPresentation({ presentation, content: "Report", fileNames: [] })).toThrow(/missing attachment/i);
  });

  it("blocks generic component turns from authorizing mutating tools", async () => {
    const decision = await restrictedToolGate({ mutationAuthorizedByCurrentInput: false } as any, "transferWalletFunds");
    expect(decision).toEqual({ allowed: false, message: expect.stringContaining("cannot authorize") });
  });

  it("opens a stored modal without starting an agent turn", async () => {
    const showModal = vi.fn(async () => undefined);
    const interaction = {
      id: "interaction",
      customId: "ai:v1:m:abcdefghijklmnopqrstuvwx",
      guildId: "guild",
      channelId: "channel",
      message: { id: "response" },
      user: { id: "user" },
      isMessageComponent: () => true,
      isModalSubmit: () => false,
      showModal,
    } as any;
    const repo = {
      resolveDiscordComponentAction: vi.fn(async () => ({ ok: true, record: {
        sourceMessageId: "source", originatingExecutionId: "origin",
        action: { type: "modal", prompt: "Plan it", modal: { title: "Plan", fields: [{ type: "text_input", key: "topic", label: "Topic" }] } },
      } })),
    };

    expect(await handleDiscordRichInteraction({ config: { discord: { guildId: "guild" } }, repo } as any, {} as any, interaction)).toBe(true);
    expect(showModal).toHaveBeenCalledOnce();
    expect(repo.resolveDiscordComponentAction).toHaveBeenCalledWith(expect.objectContaining({ consume: false, userId: "user" }));
  });

  it("returns an ephemeral error for a requester-scoped control used by someone else", async () => {
    const events: string[] = [];
    const followUp = vi.fn(async () => undefined);
    const interaction = {
      id: "interaction",
      customId: "ai:v1:a:abcdefghijklmnopqrstuvwx",
      guildId: "guild",
      channelId: "channel",
      message: { id: "response" },
      user: { id: "other" },
      deferred: true,
      replied: false,
      isMessageComponent: () => true,
      isModalSubmit: () => false,
      deferUpdate: vi.fn(async () => { events.push("defer"); }),
      followUp,
    } as any;
    const repo = { resolveDiscordComponentAction: vi.fn(async () => { events.push("resolve"); return { ok: false, reason: "wrong_user" }; }) };

    expect(await handleDiscordRichInteraction({ config: { discord: { guildId: "guild" } }, repo } as any, {} as any, interaction)).toBe(true);
    expect(events).toEqual(["defer", "resolve"]);
    expect(followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("belongs") }));
  });
});
