import { describe, expect, it, vi } from "vitest";
import { ComponentType, MessageFlags } from "discord.js";
import { buildDiscordModal, discordComponentToken, prepareDiscordPresentation } from "../../src/discord/components/renderer.js";
import { parseDiscordPresentation } from "../../src/discord/components/validation.js";
import { restrictedToolGate } from "../../src/agent/toolGate.js";
import { handleDiscordRichInteraction } from "../../src/discord/components/interactionHandler.js";
import { composeDiscordResponse } from "../../src/tools/discordPresentationTools.js";
import { decodeDiscordComponentAction, encodeDiscordComponentAction } from "../../src/discord/components/actionCodec.js";
import { normalizeModalSubmission } from "../../src/discord/components/interactionNormalization.js";

describe("Discord rich components", () => {
  it("stores a validated presentation through the model-facing composition tool", async () => {
    const context: Record<string, unknown> = {};
    const result = await composeDiscordResponse(context as any, {
      audience: "requester",
      components: [{ type: "text", content: "## Result" }],
    });

    expect((context.turnOutput as any)?.presentation).toEqual(expect.objectContaining({
      version: 1,
      audience: "requester",
      components: [{ type: "text", content: "## Result" }],
    }));
    expect(result.content).toContain("Registered a Discord Components V2 presentation");
  });

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
    }] }] })).toThrow(/required choice/i);
  });

  it.each([
    { type: "string_select", key: "choice", label: "Choice", options: [{ label: "A", value: "a" }], minValues: 0 },
    { type: "user_select", key: "user", label: "User", minValues: 0 },
    { type: "role_select", key: "role", label: "Role", minValues: 0 },
    { type: "mentionable_select", key: "mention", label: "Mention", minValues: 0 },
    { type: "channel_select", key: "channel", label: "Channel", minValues: 0 },
    { type: "checkbox_group", key: "checks", label: "Checks", options: [{ label: "A", value: "a" }], minValues: 0 },
    { type: "file_upload", key: "file", label: "File", minValues: 0 },
  ])("enforces required choice cardinality for $type", (field) => {
    expect(() => parseDiscordPresentation({ components: [{ type: "action_row", components: [{
      type: "button", label: "Open", style: "primary", action: { type: "modal", prompt: "Use form", modal: {
        title: "Form", fields: [field],
      } },
    }] }] })).toThrow(/required choice/i);

    expect(() => parseDiscordPresentation({ components: [{ type: "action_row", components: [{
      type: "button", label: "Open", style: "primary", action: { type: "modal", prompt: "Use form", modal: {
        title: "Form", fields: [{ ...field, required: false }],
      } },
    }] }] })).not.toThrow();
  });

  it("validates supplied defaults against effective choice bounds", () => {
    const messageSelect = (component: Record<string, unknown>) => ({
      components: [{ type: "action_row", components: [component] }],
    });

    expect(() => parseDiscordPresentation(messageSelect({
      type: "string_select", prompt: "Choose", options: [
        { label: "A", value: "a", default: true },
        { label: "B", value: "b", default: true },
      ],
    }))).toThrow(/default values.*minValues.*maxValues/i);

    expect(() => parseDiscordPresentation(messageSelect({
      type: "user_select", prompt: "Choose", defaultValues: [
        { id: "123456789012345", type: "user" },
        { id: "123456789012346", type: "user" },
      ],
    }))).toThrow(/default values.*minValues.*maxValues/i);

    expect(() => parseDiscordPresentation(messageSelect({
      type: "string_select", prompt: "Choose", minValues: 2, maxValues: 2, options: [
        { label: "A", value: "a", default: true },
        { label: "B", value: "b", default: true },
      ],
    }))).not.toThrow();
  });

  it("rejects duplicate auto-populated defaults generically", () => {
    expect(() => parseDiscordPresentation({ components: [{ type: "action_row", components: [{
      type: "mentionable_select", prompt: "Choose", defaultValues: [
        { id: "123456789012345", type: "user" },
        { id: "123456789012345", type: "user" },
      ],
    }] }] })).toThrow(/default values must be unique/i);
  });

  it("validates referenced attachments before generating action registrations", () => {
    const presentation = parseDiscordPresentation({ components: [{ type: "file", url: "attachment://missing.csv" }] });
    expect(() => prepareDiscordPresentation({ presentation, content: "Report", fileNames: [] })).toThrow(/missing attachment/i);
  });

  it("does not persist actions for disabled controls", () => {
    const presentation = parseDiscordPresentation({ components: [{ type: "action_row", components: [
      { type: "button", label: "Disabled", style: "primary", disabled: true, action: { type: "continue", prompt: "Never run" } },
    ] }, { type: "action_row", components: [
      { type: "string_select", prompt: "Never select", disabled: true, options: [{ label: "A", value: "a" }] },
    ] }] });
    const prepared = prepareDiscordPresentation({ presentation, content: "Done", tokenFactory: () => "abcdefghijklmnopqrstuvwx" });
    const payload = prepared.payload as any;

    expect(prepared.registrations).toEqual([]);
    expect(payload.components[1].components[0].custom_id).toMatch(/^ai:v1:x:/);
    expect(payload.components[2].components[0].custom_id).toMatch(/^ai:v1:x:/);
    expect(discordComponentToken(payload.components[1].components[0].custom_id)).toBeNull();
  });

  it("gates premium buttons to configured application SKUs", () => {
    const presentation = parseDiscordPresentation({ components: [{ type: "action_row", components: [
      { type: "button", style: "premium", skuId: "123456789012345678" },
    ] }] });

    expect(() => prepareDiscordPresentation({ presentation, content: "Upgrade" })).toThrow(/SKU is not configured/i);
    expect(() => prepareDiscordPresentation({ presentation, content: "Upgrade", premiumSkuIds: ["123456789012345678"] })).not.toThrow();
  });

  it("enforces Discord attachment count and filename uniqueness before delivery", () => {
    const presentation = parseDiscordPresentation({ components: [{ type: "text", content: "Files" }] });
    expect(() => prepareDiscordPresentation({ presentation, content: "Files", fileNames: ["same.txt", "same.txt"] })).toThrow(/unique/i);
    expect(() => prepareDiscordPresentation({ presentation, content: "Files", fileNames: Array.from({ length: 11 }, (_, index) => `${index}.txt`) })).toThrow(/at most 10/i);
  });

  it("records deterministic component metadata with stored actions", () => {
    const presentation = parseDiscordPresentation({ components: [{ type: "container", components: [{ type: "action_row", components: [
      { type: "button", label: "Continue", style: "primary", action: { type: "continue", prompt: "Continue" } },
    ] }] }] });
    const prepared = prepareDiscordPresentation({ presentation, content: "Ready", tokenFactory: () => "abcdefghijklmnopqrstuvwx" });
    expect(prepared.registrations[0]?.action).toEqual(expect.objectContaining({
      metadata: { componentPath: "components.0.components.0.components.0", label: "Continue" },
    }));
  });

  it("round-trips only supported versioned stored actions", () => {
    const encoded = encodeDiscordComponentAction({ type: "continue", prompt: "Explain more" });
    expect(decodeDiscordComponentAction(encoded)).toEqual({ type: "continue", prompt: "Explain more" });
    expect(decodeDiscordComponentAction({ ...encoded, version: 2 })).toBeNull();
    expect(decodeDiscordComponentAction({ ...encoded, kind: "select" })).toBeNull();
    expect(decodeDiscordComponentAction({ ...encoded, payload: { type: "continue", prompt: "" } })).toBeNull();
  });

  it("normalizes every modal submission field without leaking transport identifiers", () => {
    const attachment = {
      id: "attachment-1", name: "report.csv", size: 42, contentType: "text/csv",
      url: "https://cdn.example/report.csv", proxyURL: "https://proxy.example/report.csv",
      width: null, height: null, description: null,
    };
    const normalized = normalizeModalSubmission({
      message: { id: "response-message" },
      fields: { fields: new Map([
        ["text", { type: ComponentType.TextInput, value: "hello" }],
        ["string", { type: ComponentType.StringSelect, values: ["a"] }],
        ["user", { type: ComponentType.UserSelect, values: ["user-1"] }],
        ["role", { type: ComponentType.RoleSelect, values: ["role-1"] }],
        ["mention", { type: ComponentType.MentionableSelect, values: ["user-2", "role-2"] }],
        ["channel", { type: ComponentType.ChannelSelect, values: ["channel-1"] }],
        ["file", { type: ComponentType.FileUpload, attachments: new Map([[attachment.id, attachment]]) }],
        ["radio", { type: ComponentType.RadioGroup, value: "option-1" }],
        ["checks", { type: ComponentType.CheckboxGroup, values: ["one", "two"] }],
        ["agree", { type: ComponentType.Checkbox, value: true }],
      ]) },
      customId: "ai:v1:m:secret-token:submit",
    } as any);

    expect(normalized.submission).toEqual(expect.objectContaining({
      schemaVersion: 1,
      messageId: "response-message",
      component: { type: "modal_submit" },
      fields: expect.arrayContaining([
        { key: "text", type: "text_input", value: "hello" },
        { key: "string", type: "string_select", values: ["a"] },
        { key: "agree", type: "checkbox", value: true },
        { key: "file", type: "file_upload", files: [{ id: "attachment-1", name: "report.csv", sizeBytes: 42, contentType: "text/csv" }] },
      ]),
    }));
    expect(normalized.attachments).toEqual([expect.objectContaining({ id: "attachment-1", filename: "report.csv" })]);
    expect(JSON.stringify(normalized.submission)).not.toContain("secret-token");
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
      deferred: false,
      replied: false,
      isMessageComponent: () => true,
      isModalSubmit: () => false,
      deferUpdate: vi.fn(async () => { events.push("defer"); interaction.deferred = true; }),
      followUp,
    } as any;
    const repo = { resolveDiscordComponentAction: vi.fn(async () => { events.push("resolve"); return { ok: false, reason: "wrong_user" }; }) };

    expect(await handleDiscordRichInteraction({ config: { discord: { guildId: "guild" } }, repo } as any, {} as any, interaction)).toBe(true);
    expect(events).toEqual(["defer", "resolve"]);
    expect(followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("belongs") }));
  });
});
