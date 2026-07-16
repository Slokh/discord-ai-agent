import { ChannelType, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  summarizeBotChannelPermissions,
  validateMemberLevelBotPermissions,
  visibleChannelIdsForMember
} from "../../src/discord/permissions.js";

describe("summarizeBotChannelPermissions", () => {
  it("counts member-level channel permissions needed by Discord AI Agent", () => {
    const member = { permissions: permissionSet([PermissionsBitField.Flags.CreateGuildExpressions]) } as any;
    const full = permissionSet([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.SendMessagesInThreads,
      PermissionsBitField.Flags.AttachFiles
    ]);
    const readOnly = permissionSet([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory
    ]);

    const summary = summarizeBotChannelPermissions(member, [
      channel("general", ChannelType.GuildText, full),
      channel("archive", ChannelType.GuildText, readOnly),
      channel("forum", ChannelType.GuildForum, full),
      channel("media", ChannelType.GuildMedia, full),
      channel("voice", ChannelType.GuildVoice, full)
    ]);

    expect(summary).toMatchObject({
      hasAdministrator: false,
      hasCreateGuildExpressions: true,
      textLikeChannels: 4,
      crawlableChannels: 4,
      sendableChannels: 3,
      threadSendableChannels: 3,
      attachableChannels: 3
    });
    expect(summary.missingSendChannelNames).toEqual(["#archive (archive)"]);
    expect(summary.missingAttachChannelNames).toEqual(["#archive (archive)"]);
  });

  it("samples missing crawl permission channels", () => {
    const member = {} as any;
    const noPerms = permissionSet([]);

    const summary = summarizeBotChannelPermissions(
      member,
      [
        channel("a", ChannelType.GuildText, noPerms),
        channel("b", ChannelType.GuildText, noPerms),
        channel("c", ChannelType.GuildText, noPerms)
      ],
      2
    );

    expect(summary.crawlableChannels).toBe(0);
    expect(summary.missingCrawlChannelNames).toEqual(["#a (a)", "#b (b)"]);
  });

  it("reports when the bot member has Administrator", () => {
    const member = { permissions: permissionSet([PermissionsBitField.Flags.Administrator]) } as any;

    expect(summarizeBotChannelPermissions(member, []).hasAdministrator).toBe(true);
  });

  it("reports the guild-level Create Expressions permission", () => {
    const member = { permissions: permissionSet([PermissionsBitField.Flags.CreateGuildExpressions]) } as any;
    expect(summarizeBotChannelPermissions(member, []).hasCreateGuildExpressions).toBe(true);
  });

  it("rejects Administrator for the member-level local milestone setup", () => {
    const baseSummary = {
      hasCreateGuildExpressions: true,
      textLikeChannels: 1,
      crawlableChannels: 1,
      sendableChannels: 1,
      threadSendableChannels: 1,
      attachableChannels: 1
    };

    expect(validateMemberLevelBotPermissions({ ...baseSummary, hasAdministrator: true })).toEqual([
      expect.stringContaining("Administrator permission")
    ]);
    expect(validateMemberLevelBotPermissions({ ...baseSummary, hasAdministrator: false })).toEqual([]);
  });

  it("rejects member-level setups without usable crawl, send, thread, or attach permissions", () => {
    const errors = validateMemberLevelBotPermissions({
      hasAdministrator: false,
      hasCreateGuildExpressions: false,
      textLikeChannels: 0,
      crawlableChannels: 0,
      sendableChannels: 0,
      threadSendableChannels: 0,
      attachableChannels: 0
    });

    expect(errors.join("\n")).toMatch(/cannot see any text/i);
    expect(errors.join("\n")).toMatch(/cannot crawl/i);
    expect(errors.join("\n")).toMatch(/cannot send messages/i);
    expect(errors.join("\n")).toMatch(/threads/i);
    expect(errors.join("\n")).toMatch(/Attach Files/i);
    expect(errors.join("\n")).toMatch(/Create Expressions/i);
  });
});

describe("visibleChannelIdsForMember", () => {
  it("permission-checks extra channel candidates before adding them", async () => {
    const member = {} as any;
    const full = permissionSet([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory
    ]);
    const noPerms = permissionSet([]);
    const cached = channel("cached", ChannelType.GuildText, full);
    const fetchedPrivateThread = channel("private-thread", ChannelType.PrivateThread, full);
    const inaccessibleMention = channel("secret", ChannelType.GuildText, noPerms);
    const fetch = vi.fn(async (id?: string) => {
      if (!id) return undefined;
      return new Map([
        [fetchedPrivateThread.id, fetchedPrivateThread],
        [inaccessibleMention.id, inaccessibleMention]
      ]).get(id) ?? null;
    });

    const guild = {
      channels: {
        cache: new Map([[cached.id, cached]]),
        fetch
      }
    } as any;

    await expect(visibleChannelIdsForMember(guild, member, ["private-thread", "secret", "missing"])).resolves.toEqual([
      "cached",
      "private-thread"
    ]);
    expect(fetch).toHaveBeenCalledWith("private-thread");
    expect(fetch).toHaveBeenCalledWith("secret");
    expect(fetch).toHaveBeenCalledWith("missing");
  });
});

function channel(id: string, type: ChannelType, permissions: ReturnType<typeof permissionSet>) {
  return {
    id,
    name: id,
    type,
    permissionsFor: () => permissions
  };
}

function permissionSet(flags: bigint[]) {
  return {
    has: (flag: bigint) => flags.includes(flag)
  };
}
