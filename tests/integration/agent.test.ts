import { describe, expect, it, vi } from "vitest";
import { handleAgentRequest } from "../../src/agent/router.js";
import { OpenRouterTimeoutError } from "../../src/models/openrouter.js";
import type { WagerReservation } from "../../src/payments/types.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("agent router", () => {
  it("replays a reply-chain emote question with exact reacted emoji and learned visible usage", async () => {
    const targetProfiles = [
      {
        emojiId: "101",
        inlineUses: 2,
        reactionUses: 6,
        messageCount: 4,
        lastUsedAt: new Date("2026-07-20T00:00:00.000Z"),
        examples: [{
          emojiId: "101",
          kind: "reaction" as const,
          messageId: "example-1",
          content: "synthetic celebration context",
          createdAt: new Date("2026-07-20T00:00:00.000Z"),
        }],
      },
      {
        emojiId: "102",
        inlineUses: 1,
        reactionUses: 4,
        messageCount: 3,
        lastUsedAt: new Date("2026-07-19T00:00:00.000Z"),
        examples: [{
          emojiId: "102",
          kind: "reaction" as const,
          messageId: "example-2",
          content: "synthetic uncertainty context",
          createdAt: new Date("2026-07-19T00:00:00.000Z"),
        }],
      },
    ];
    const listDiscordEmojiCultureProfiles = vi.fn(async (input: { emojiIds: string[] }) =>
      input.emojiIds.length === 2 ? targetProfiles : []);
    const chat = vi.fn(async (request: { messages: Array<{ content: unknown }> }) => {
      const prompt = request.messages.map((message) => String(message.content)).join("\n");
      const grounded =
        prompt.includes("Reactions visible on this message: <:party:101> ×1, <:hmm:102> ×1") &&
        prompt.includes("<:party:101> (4 observed messages)") &&
        prompt.includes("<:hmm:102> (3 observed messages)");
      return {
        content: grounded
          ? "Two custom reactions are on that ancestor; one is used for celebration and the other for uncertainty."
          : "I cannot identify which emote you mean from the reply.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      };
    });
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
        listDiscordEmojiCultureProfiles,
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      discordGuildEmojis: [
        { id: "101", name: "party", animated: false, mention: "<:party:101>" },
        { id: "102", name: "hmm", animated: false, mention: "<:hmm:102>" },
        { id: "103", name: "unrelated", animated: false, mention: "<:unrelated:103>" },
      ],
      sessionMessages: [],
      replyContext: {
        messageId: "parent",
        channelId: "c",
        guildId: "g",
        authorId: "bot",
        authorDisplayName: "AI",
        authorIsBot: true,
        content: "A synthetic reply.",
        attachmentSummaries: [],
        attachments: [],
        createdAt: "2026-07-23T18:00:00.000Z",
        url: "https://discord.com/channels/g/c/parent",
        rootMessageId: "root",
        chain: [
          {
            messageId: "root",
            channelId: "c",
            guildId: "g",
            authorId: "u",
            authorDisplayName: "User",
            authorIsBot: false,
            content: "A synthetic ancestor.",
            attachmentSummaries: [],
            attachments: [],
            reactionSummaries: ["<:party:101> ×1", "<:hmm:102> ×1"],
            createdAt: "2026-07-23T17:59:00.000Z",
            url: "https://discord.com/channels/g/c/root",
          },
          {
            messageId: "parent",
            channelId: "c",
            guildId: "g",
            authorId: "bot",
            authorDisplayName: "AI",
            authorIsBot: true,
            content: "A synthetic reply.",
            attachmentSummaries: [],
            attachments: [],
            createdAt: "2026-07-23T18:00:00.000Z",
            url: "https://discord.com/channels/g/c/parent",
          },
        ],
      },
      requestId: "message-emote-question",
      requestMessageId: "message-emote-question",
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what does that emote mean?");

    expect(response.content).toContain("Two custom reactions");
    expect(listDiscordEmojiCultureProfiles).toHaveBeenCalledWith(expect.objectContaining({
      guildId: "g",
      visibleChannelIds: ["c"],
      emojiIds: ["101", "102"],
      limit: 2,
    }));
  });

  it("answers ordinary chat without inspecting or funding the requester's wallet", async () => {
    const requestStarterFunds = vi.fn(async () => ({
      granted: true as const,
      amountUsd: 1,
      transfer: { status: "confirmed", transactionHash: `0x${"7".repeat(64)}` },
      destination: { balance: { formatted: "1" } },
      source: { balance: { formatted: "22" } },
    }));
    const chat = vi.fn(async () => ({
      content: "Recursion is when a process solves a problem by calling itself on a smaller version.",
      model: "router-model",
      raw: {},
      toolCalls: [],
    }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        payments: {
          walletEnabled: true,
          userWalletsEnabled: true,
          tempoNetwork: "mainnet",
          privyAppId: "app",
          privyAppSecret: "secret",
        },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      walletService: { requestStarterFunds },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      requestId: "message-ordinary-chat",
      requestMessageId: "message-ordinary-chat",
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what is recursion?");

    expect(response.content).toBe("Recursion is when a process solves a problem by calling itself on a smaller version.");
    expect(response.footerLines ?? []).toEqual([]);
    expect(requestStarterFunds).not.toHaveBeenCalled();
    const modelRequest = (chat.mock.calls as any[])[0]?.[0];
    expect(JSON.stringify(modelRequest.messages)).not.toContain("Automatic starter funding");
  });

  it("automatically tops up starter funds before handling a below-target user request", async () => {
    const transactionHash = `0x${"8".repeat(64)}`;
    const requestStarterFunds = vi.fn(async (_input, record) => {
      await record({
        eventName: "wallet.transfer.confirmed",
        summary: "starter grant confirmed",
        metadata: { transactionHash },
      });
      return {
        granted: true as const,
        amountUsd: 1,
        transfer: { status: "confirmed", transactionHash },
        destination: { balance: { formatted: "1" } },
        source: { balance: { formatted: "22" } },
      };
    });
    const chat = vi.fn(async () => ({
      content: "You were automatically topped up to $1, so we can keep going.",
      model: "router-model",
      raw: {},
      toolCalls: [],
    }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        payments: {
          walletEnabled: true,
          userWalletsEnabled: true,
          tempoNetwork: "mainnet",
          privyAppId: "app",
          privyAppSecret: "secret",
        },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      walletService: { requestStarterFunds },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      requestId: "message-auto-starter",
      requestMessageId: "message-auto-starter",
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "start pack please and 1 on corner bet");

    expect(requestStarterFunds).toHaveBeenCalledWith({
      guildId: "g",
      requestedByUserId: "u",
      requestId: "message-auto-starter",
    }, expect.any(Function));
    expect(requestStarterFunds.mock.invocationCallOrder[0]).toBeLessThan(chat.mock.invocationCallOrder[0]);
    const modelRequest = (chat.mock.calls as any[])[0]?.[0];
    expect(modelRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Automatic starter funding succeeded before this request"),
      }),
    ]));
    expect(response.footerLines).toContain(`💸 [transfer](<https://explore.tempo.xyz/tx/${transactionHash}>)`);
  });

  it("uses the requester's verified wallet balance in a conversational response", async () => {
    const chat = vi.fn(async () => ({
      content: "You have exactly **$1.00** in your wallet.",
      model: "router-model",
      raw: {},
      toolCalls: [],
    }));
    const getUserWalletSummary = vi.fn(async () => ({
      wallet: { address: `0x${"1".repeat(40)}` },
      balance: { formatted: "1", token: { symbol: "USDC.e" } }
    }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        payments: {
          walletEnabled: true,
          userWalletsEnabled: true,
          privyAppId: "app",
          privyAppSecret: "secret"
        }
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined)
      },
      walletService: { getUserWalletSummary },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      requestId: "message-1",
      requestMessageId: "message-1"
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "balance");

    expect(response.content).toBe("You have exactly **$1.00** in your wallet.");
    expect(response.content).not.toContain("USDC.e");
    expect(chat).toHaveBeenCalledTimes(1);
    const synthesisRequest = (chat.mock.calls as any[])[0]?.[0];
    expect(synthesisRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: expect.stringContaining("Your wallet: $1 USD") }),
    ]));
    expect(getUserWalletSummary).toHaveBeenCalledWith({ guildId: "g", userId: "u" }, expect.any(Function));
  });

  it("replays a recent-win question through canonical wager history before answering", async () => {
    const listWagerHistory = vi.fn(async () => ({
      entries: [{
        wager: {
          requestId: "earlier-wager",
          channelId: "casino",
          game: "coinflip",
          status: "settled",
          settlementOutcome: "player_win",
          stakeAtomic: 500_000n,
          payoutAtomic: 1_000_000n,
          tokenDecimals: 6,
          explanation: "The verified draw matched the requested side.",
          createdAt: new Date("2026-07-23T16:20:00.000Z"),
        },
        draw: {
          kind: "coin",
          outcome: { kind: "coin", values: ["heads"] },
          reason: "requester chose heads",
        },
      }],
      hasMore: false,
    }));
    const chat = vi.fn(async () => ({
      content: "You won the latest wager because the verified coin result matched your choice; the ledger shows a net $0.50 gain.",
      model: "router-model",
      raw: {},
      toolCalls: [],
    }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        payments: {
          walletEnabled: true,
          userWalletsEnabled: true,
          privyAppId: "app",
          privyAppSecret: "secret",
        },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      walletService: { listWagerHistory },
      openRouter: { chat },
      guildId: "g",
      channelId: "casino",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["casino"],
      sessionMessages: [],
      requestId: "recent-win-question",
      requestMessageId: "recent-win-question",
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "why did I win my most recent wager?");

    expect(response.content).toContain("verified coin result");
    expect(listWagerHistory).toHaveBeenCalledWith({
      guildId: "g",
      userId: "u",
      game: undefined,
      limit: 20,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    const synthesisRequest = (chat.mock.calls as any[])[0]?.[0];
    expect(synthesisRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Canonical requester wager ledger"),
      }),
    ]));
  });

  it("replays a terse wager correction from a multi-user reply chain through the current requester's ledger", async () => {
    const listWagerHistory = vi.fn(async () => ({
      entries: [{
        wager: {
          requestId: "requester-wager",
          channelId: "casino",
          game: "synthetic-game",
          status: "settled",
          settlementOutcome: "player_win",
          stakeAtomic: 250_000n,
          payoutAtomic: 500_000n,
          tokenDecimals: 6,
          explanation: "The verified draw matched the requester's selection.",
          createdAt: new Date("2026-07-23T17:00:00.000Z"),
        },
        draw: {
          kind: "coin",
          outcome: { kind: "coin", values: ["heads"] },
          reason: "synthetic requester selection",
        },
      }],
      hasMore: false,
    }));
    const chat = vi.fn(async (request: { messages: Array<{ content: unknown }> }) => {
      const hasLedger = JSON.stringify(request.messages).includes("Canonical requester wager ledger");
      return {
        content: hasLedger
          ? "The verified requester ledger confirms the latest result."
          : "I cannot verify which prior result belongs to you.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      };
    });
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        payments: {
          walletEnabled: true,
          userWalletsEnabled: true,
          privyAppId: "app",
          privyAppSecret: "secret",
        },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      walletService: { listWagerHistory },
      openRouter: { chat },
      guildId: "g",
      channelId: "casino",
      userId: "current-requester",
      userDisplayName: "Current requester",
      visibleChannelIds: ["casino"],
      sessionMessages: [],
      requestId: "terse-correction",
      requestMessageId: "terse-correction",
      replyContext: {
        messageId: "parent",
        channelId: "casino",
        guildId: "g",
        authorId: "bot",
        authorDisplayName: "AI",
        authorIsBot: true,
        content: "Your latest wager ledger entry was a settled loss.",
        attachmentSummaries: [],
        attachments: [],
        rootMessageId: "root",
        chain: [
          {
            messageId: "root",
            channelId: "casino",
            guildId: "g",
            authorId: "other-member",
            authorDisplayName: "Other member",
            authorIsBot: false,
            content: "Show the latest wager result.",
            attachmentSummaries: [],
            attachments: [],
          },
          {
            messageId: "requester-follow-up",
            channelId: "casino",
            guildId: "g",
            authorId: "current-requester",
            authorDisplayName: "Current requester",
            authorIsBot: false,
            content: "Show my latest wager.",
            attachmentSummaries: [],
            attachments: [],
          },
          {
            messageId: "parent",
            channelId: "casino",
            guildId: "g",
            authorId: "bot",
            authorDisplayName: "AI",
            authorIsBot: true,
            content: "Your latest wager ledger entry was a settled loss.",
            attachmentSummaries: [],
            attachments: [],
          },
        ],
      },
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "that's not my turn");

    expect(response.content).toBe("The verified requester ledger confirms the latest result.");
    expect(listWagerHistory).toHaveBeenCalledWith({
      guildId: "g",
      userId: "current-requester",
      game: undefined,
      limit: 20,
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("uses the verified bot balance in a conversational response", async () => {
    const chat = vi.fn(async () => ({
      content: "I currently have **$5.95** available.",
      model: "router-model",
      raw: {},
      toolCalls: [],
    }));
    const getBotWalletSummary = vi.fn(async () => ({
      wallet: { address: `0x${"2".repeat(40)}` },
      balance: { formatted: "5.95", token: { symbol: "USDC.e" } },
    }));
    const getUserWalletSummary = vi.fn();
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        payments: {
          walletEnabled: true,
          userWalletsEnabled: true,
          privyAppId: "app",
          privyAppSecret: "secret",
        },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      walletService: { getBotWalletSummary, getUserWalletSummary },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      requestId: "message-2",
      requestMessageId: "message-2",
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what's your balance?");

    expect(response.content).toBe("I currently have **$5.95** available.");
    expect(getBotWalletSummary).toHaveBeenCalledWith("g", expect.any(Function));
    expect(getUserWalletSummary).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("uses the live member wallet directory in a conversational response", async () => {
    const chat = vi.fn(async () => ({
      content: "Only AI and Alice have positive balances:\n\n```text\nWallet  Balance\nAI      $9.5\nAlice   $2.5\n```",
      model: "router-model",
      raw: {},
      toolCalls: [],
    }));
    const traceEvents: Array<{ eventName: string; metadata?: Record<string, unknown> }> = [];
    const listExistingUserWalletSummaries = vi.fn(async () => [{
      userId: "alice",
      wallet: { address: `0x${"3".repeat(40)}` },
      balance: { formatted: "2.5", amountAtomic: 2_500_000n },
      error: null,
    }]);
    const fetchDiscordGuildMembers = vi.fn(async () => [
      { userId: "alice", username: "alice", displayName: "Alice", isBot: false },
      { userId: "bob", username: "bob", displayName: "Bob", isBot: false },
    ]);
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        allowlists: { ownerUserId: null, opsUserIds: [] },
        payments: {
          walletEnabled: true,
          userWalletsEnabled: true,
          balancesPublic: true,
          privyAppId: "app",
          privyAppSecret: "secret",
        },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        getDiscordUserReferenceTerms: vi.fn(async () => [{
          userId: "alice", username: "alice", globalName: "Alice", aliases: [], terms: []
        }]),
        recordTraceEvent: vi.fn(async (event) => {
          traceEvents.push(event as { eventName: string; metadata?: Record<string, unknown> });
        }),
      },
      walletService: {
        listExistingUserWalletSummaries,
        getBotWalletSummary: vi.fn(async () => ({
          wallet: { address: `0x${"4".repeat(40)}` },
          balance: { formatted: "9.5", amountAtomic: 9_500_000n }
        }))
      },
      fetchDiscordGuildMembers,
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      requestId: "message-3",
      requestMessageId: "message-3",
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "every user's balance");

    expect(response.content).toContain("```text\nWallet  Balance\nAI      $9.5\nAlice   $2.5\n```");
    expect(response.content).not.toContain("Bob");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(listExistingUserWalletSummaries).toHaveBeenCalledWith({ guildId: "g" });
    expect(fetchDiscordGuildMembers).not.toHaveBeenCalled();
    expect(traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: "agent.deterministic_tool.selected",
        metadata: expect.objectContaining({ toolName: "listWalletBalances" }),
      }),
    ]));
  });

  it("lets the model present a model-selected wallet directory instead of returning the tool format verbatim", async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [{
          id: "wallet-directory",
          name: "listWalletBalances",
          argumentsText: "{}",
        }],
      })
      .mockResolvedValueOnce({
        content: "AI has $9.50 and Alice has $2.50. Those are the only funded wallets right now.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      });
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: false,
        openRouter: {},
        allowlists: { ownerUserId: null, opsUserIds: [] },
        payments: {
          walletEnabled: true,
          userWalletsEnabled: true,
          balancesPublic: true,
          privyAppId: "app",
          privyAppSecret: "secret",
        },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        getDiscordUserReferenceTerms: vi.fn(async () => [{
          userId: "alice", username: "alice", globalName: "Alice", aliases: [], terms: [],
        }]),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      walletService: {
        listExistingUserWalletSummaries: vi.fn(async () => [{
          userId: "alice",
          wallet: { address: `0x${"3".repeat(40)}` },
          balance: { formatted: "2.5", amountAtomic: 2_500_000n },
          error: null,
        }]),
        getBotWalletSummary: vi.fn(async () => ({
          wallet: { address: `0x${"4".repeat(40)}` },
          balance: { formatted: "9.5", amountAtomic: 9_500_000n },
        })),
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      requestId: "message-wallet-directory",
      requestMessageId: "message-wallet-directory",
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "baalnces");

    expect(response.content).toBe("AI has $9.50 and Alice has $2.50. Those are the only funded wallets right now.");
    expect(response.content).not.toContain("| Wallet | Balance |");
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1]?.[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        name: "listWalletBalances",
        content: expect.stringContaining("| Alice | $2.5 |"),
      }),
    ]));
  });

  it("forces an explicit named transfer through the wallet tool on the first model round", async () => {
    const transactionHash = `0x${"5".repeat(64)}`;
    const chat = vi.fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [{
          id: "transfer-luke",
          name: "transferWalletFunds",
          argumentsText: JSON.stringify({ destination: "user", destinationUserId: "luke", amountUsd: 1 }),
        }],
      })
      .mockResolvedValueOnce({ content: "Luke has his dollar back.", model: "router-model", raw: {}, toolCalls: [] });
    const transferFromUser = vi.fn(async () => ({
      transfer: { status: "confirmed", transactionHash },
      source: { wallet: {}, balance: { formatted: "1" } },
      destination: { wallet: {}, balance: { formatted: "1" } },
    }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        allowlists: { ownerUserId: null, opsUserIds: [] },
        payments: {
          walletEnabled: true,
          userWalletsEnabled: true,
          tempoNetwork: "mainnet",
          privyAppId: "app",
          privyAppSecret: "secret",
        },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      walletService: { transferFromUser },
      fetchDiscordGuildMembers: vi.fn(async () => [
        { userId: "luke-id", username: "lukester", displayName: "Luke", isBot: false },
      ]),
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      requestId: "message-transfer",
      requestMessageId: "message-transfer",
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "give luke back $1 so he can use it");

    expect(response.content).toContain("Luke has his dollar back");
    expect(chat.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      toolChoice: { type: "function", function: { name: "transferWalletFunds" } },
    }));
    expect(transferFromUser).toHaveBeenCalledWith(expect.objectContaining({
      requestedByUserId: "u",
      destination: { kind: "user", userId: "luke-id" },
      amountUsd: 1,
    }), expect.any(Function));
  });

  it("resumes a generic wallet game from versioned state in a Discord reply", async () => {
    const activeWager = {
      id: "wager_yahtzee",
      requestId: "root-message",
      guildId: "g",
      channelId: "c",
      threadKey: "g:c:rng-root:root-message",
      requestedByUserId: "u",
      userWalletId: "user-wallet",
      botWalletId: "bot-wallet",
      game: "dice game",
      token: "USDC.e",
      tokenDecimals: 6,
      stakeAtomic: 1_000_000n,
      maxPayoutAtomic: 5_000_000n,
      payoutAtomic: null,
      drawId: 12,
      settlementTransferId: null,
      status: "drawn",
      explanation: null,
      interactionMode: "player_decisions",
      settlementOutcome: null,
      settlementResolutionSource: null,
      settlementRequestId: null,
      awaitingAction: true,
      stateVersion: 1,
      decisionState: { dice: [6, 4, 6, 2, 1], rollsRemaining: 2, held: [] },
      allowedActions: ["hold 1 and 3", "reroll all", "score now"],
      actionPrompt: "Which dice do you want to hold?",
      lastActionRequestId: "root-message",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies WagerReservation;
    const getActiveGameSession = vi.fn(async () => activeWager);
    const awaitGameAction = vi.fn(async () => ({
      ...activeWager,
      stateVersion: 2,
      decisionState: { ...activeWager.decisionState, held: [1, 3] },
      allowedActions: ["roll", "change holds", "score now"],
      actionPrompt: "Roll the other three dice?",
      lastActionRequestId: "reply-message",
    }));
    const chat = vi.fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [{
          id: "save-game",
          name: "awaitRandomWagerAction",
          argumentsText: JSON.stringify({
            expectedVersion: 1,
            state: { ...activeWager.decisionState, held: [1, 3] },
            allowedActions: ["roll", "change holds", "score now"],
            prompt: "Roll the other three dice?",
          }),
        }],
      })
      .mockResolvedValueOnce({
        content: "Locked dice 1 and 3. Want to roll the other three, change your holds, or score now?",
        model: "router-model",
        raw: {},
        toolCalls: [],
      });
    const ctx = {
      config: {
        maxReplyChars: 1_800,
        toolsetScoping: true,
        openRouter: {},
        payments: {
          walletEnabled: true,
          userWalletsEnabled: true,
          privyAppId: "app",
          privyAppSecret: "secret",
        },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      walletService: {
        getActiveGameSession,
        getCurrentWager: vi.fn(async () => activeWager),
        awaitGameAction
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      threadKey: "g:c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      requestId: "reply-message",
      requestMessageId: "reply-message",
      replyContext: {
        messageId: "bot-prompt",
        rootMessageId: "root-message",
        channelId: "c",
        guildId: "g",
        authorId: "bot",
        authorDisplayName: "ai",
        authorIsBot: true,
        content: "Which dice do you want to hold?",
        attachmentSummaries: [],
        attachments: [],
        createdAt: null,
        url: null,
        chain: [],
      },
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "hold 1 and 3");

    expect(response.content).toContain("Locked dice 1 and 3");
    expect(chat.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ toolChoice: "required" }));
    expect(chat.mock.calls[0]?.[0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "system", content: expect.stringContaining("State version: 1") }),
      expect.objectContaining({ role: "system", content: expect.stringContaining('"rollsRemaining":2') }),
    ]));
    expect(awaitGameAction).toHaveBeenCalledWith(expect.objectContaining({
      wagerId: activeWager.id,
      userId: "u",
      expectedVersion: 1,
      requestId: "reply-message",
    }), expect.any(Function));
  });

  it("retries malformed tool calls with the original reply context and toolset", async () => {
    const traceEvents: any[] = [];
    const auditTool = vi.fn(async () => undefined);
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [{
          id: "malformed-call",
          name: "drawRandom(kind</arg_key><arg_value>integers</arg_value>",
          argumentsText: "{}",
        }],
      })
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [{
          id: "valid-call",
          name: "drawRandom",
          argumentsText: JSON.stringify({
            kind: "integers",
            count: 30,
            min: 1,
            max: 8,
            reason: "10 slot spins × 3 reels",
          }),
        }],
      })
      .mockResolvedValueOnce({
        content: "I couldn't complete verified spins because the RNG store is unavailable.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      });
    const ctx = {
      config: { maxReplyChars: 1800, toolsetScoping: true, openRouter: {}, payments: { walletEnabled: false, userWalletsEnabled: false } },
      repo: {
        auditTool,
        recordTraceEvent: vi.fn(async (event: any) => {
          traceEvents.push(event);
        }),
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      threadKey: "discord:g:c",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      replyContext: {
        messageId: "previous-reply",
        channelId: "c",
        guildId: "g",
        rootMessageId: "original-request",
        authorId: "bot",
        authorDisplayName: "ai",
        authorIsBot: true,
        content: "10 spins at $5 each with slot results",
        createdAt: "2026-07-13T18:49:13.000Z",
        url: null,
        attachmentSummaries: [],
        attachments: [],
        chain: [],
      },
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "10 more, win this time");

    expect(response.content).toContain("RNG store is unavailable");
    expect(chat).toHaveBeenCalledTimes(3);
    const recoveryRequest = chat.mock.calls[1]?.[0] as {
      messages?: Array<{ role: string; content: string }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    expect(recoveryRequest.tools?.some((tool) => tool.function?.name === "drawRandom")).toBe(true);
    expect(recoveryRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "system", content: expect.stringContaining("10 spins at $5 each with slot results") }),
      expect.objectContaining({ role: "system", content: expect.stringContaining("Do not claim that context is missing") }),
      expect.objectContaining({ role: "user", content: "10 more, win this time" }),
    ]));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "agentError",
      error: "invalid_model_tool_call",
    }));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "drawRandom" }));
    expect(traceEvents.some((event) => event.eventName === "agent.invalid_tool_call_recovery.started")).toBe(true);
  });

  it("rejects a fabricated chance outcome and retries with drawRandom available", async () => {
    const traceEvents: any[] = [];
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "The wheel spins... 21 red. You lose.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        content: "I need to use the provably fair draw before reporting a result.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      });
    const ctx = {
      config: { maxReplyChars: 1800, toolsetScoping: true, openRouter: {}, payments: { walletEnabled: false, userWalletsEnabled: false } },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async (event: any) => {
          traceEvents.push(event);
        }),
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "500 on roulette black");

    expect(chat).toHaveBeenCalledTimes(2);
    expect(response.content).toContain("need to use the provably fair draw");
    const retryRequest = (chat.mock.calls[1]?.[0] ?? {}) as {
      messages?: Array<{ role: string; content: string }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    expect(retryRequest.tools?.some((tool) => tool.function?.name === "drawRandom")).toBe(true);
    expect(retryRequest.messages?.some((message) =>
      message.role === "system" && message.content.includes("verified chance workflow is incomplete")
    )).toBe(true);
    expect(traceEvents.some((event) => event.eventName === "agent.random_outcome_guard.rejected"))
      .toBe(true);
  });

  it("removes invented roll framing from ordinary conversation without forcing RNG", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "Roll: 4. English. One catch does not become a million points.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        content: "One legitimate catch still does not become a million points.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      });
    const ctx = {
      config: { maxReplyChars: 1800, toolsetScoping: true, openRouter: {}, payments: { walletEnabled: false, userWalletsEnabled: false } },
      repo: { auditTool: vi.fn(async () => undefined), recordTraceEvent: vi.fn(async () => undefined) },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "That one catch does not count for a million points.");

    expect(response.content).toContain("One legitimate catch");
    expect(chat).toHaveBeenCalledTimes(2);
    const retryRequest = (chat.mock.calls[1]?.[0] ?? {}) as {
      messages?: Array<{ role: string; content: string }>;
      toolChoice?: unknown;
    };
    expect(retryRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("user did not ask you to perform"),
      }),
    ]));
    expect(retryRequest.messages?.some((message) => message.content.includes("Do not call drawRandom unless"))).toBe(true);
  });

  it("forces the reveal tool for an explicit randomness reveal", async () => {
    const chat = vi.fn(async () => ({
      content: "I will reveal the committed RNG session.",
      model: "router-model",
      raw: {},
      toolCalls: [],
    }));
    const ctx = {
      config: { maxReplyChars: 1800, toolsetScoping: true, openRouter: {}, payments: { walletEnabled: false, userWalletsEnabled: false } },
      repo: { auditTool: vi.fn(async () => undefined), recordTraceEvent: vi.fn(async () => undefined) },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "Reveal randomness");

    const request = ((chat.mock.calls as any[])[0]?.[0] ?? {}) as {
      toolChoice?: unknown;
      tools?: Array<{ function?: { name?: string } }>;
    };
    expect(request.toolChoice).toEqual({ type: "function", function: { name: "revealRandomness" } });
    expect(request.tools?.some((tool) => tool.function?.name === "revealRandomness")).toBe(true);
  });

  it("does not short-circuit a balance-backed roulette wager into tool-free synthesis", async () => {
    const getUserWalletSummary = vi.fn();
    const chat = vi.fn(async () => ({
      content: "I need a verified balance and RNG draw before resolving that wager.",
      model: "router-model",
      raw: {},
      toolCalls: [],
    }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        payments: { walletEnabled: true, userWalletsEnabled: true, privyAppId: "app", privyAppSecret: "secret" },
      },
      repo: { auditTool: vi.fn(async () => undefined), recordTraceEvent: vi.fn(async () => undefined) },
      walletService: { getUserWalletSummary },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "bet the rest of my balance on roulette");

    expect(getUserWalletSummary).not.toHaveBeenCalled();
    const request = ((chat.mock.calls as any[])[0]?.[0] ?? {}) as { tools?: Array<{ function?: { name?: string } }> };
    expect(request.tools?.some((tool) => tool.function?.name === "getWalletBalance")).toBe(true);
    expect(request.tools?.some((tool) => tool.function?.name === "drawRandom")).toBe(true);
  });

  it("re-executes an exact drawRandom call after a failed result instead of treating it as successful evidence", async () => {
    const auditTool = vi.fn(async () => undefined);
    const drawCall = { id: "draw-call", name: "drawRandom", argumentsText: JSON.stringify({ kind: "coin" }) };
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ content: "", model: "router-model", raw: {}, toolCalls: [drawCall] })
      .mockResolvedValueOnce({ content: "", model: "router-model", raw: {}, toolCalls: [{ ...drawCall, id: "draw-retry" }] })
      .mockResolvedValueOnce({
        content: "I couldn't complete a verified coin flip because the RNG service is unavailable.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      });
    const ctx = {
      config: { maxReplyChars: 1800, toolsetScoping: true, openRouter: {}, payments: { walletEnabled: false, userWalletsEnabled: false } },
      repo: { auditTool, recordTraceEvent: vi.fn(async () => undefined) },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "flip a coin");

    expect(response.content).toContain("couldn't complete a verified coin flip");
    const drawAudits = (auditTool.mock.calls as any[]).filter((call) => call[0]?.toolName === "drawRandom");
    expect(drawAudits).toHaveLength(2);
  });

  it("rejects fabricated live fares and retries with fresh retrieval tools", async () => {
    const traceEvents: any[] = [];
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "United is cheapest at $841 round-trip this fall.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        content: "Fresh search results do not expose a bookable fare without exact travel dates. How long should the trip be?",
        model: "router-model",
        raw: {},
        toolCalls: [],
        serverToolUse: {
          web_search_requests: 1,
          tool_calls_requested: 1,
          tool_calls_executed: 1,
        },
        urlCitations: [{ url: "https://example.com/current-fares", title: "Current fares" }],
      });
    const ctx = {
      config: { maxReplyChars: 1800, toolsetScoping: true, openRouter: {} },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async (event: any) => {
          traceEvents.push(event);
        }),
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
    } as unknown as ToolContext;

    const response = await handleAgentRequest(
      ctx,
      "Find the cheapest nonstop round-trip flights from NYC to Japan this fall.",
    );

    expect(chat).toHaveBeenCalledTimes(2);
    expect(response.content).toContain("How long should the trip be?");
    const retryRequest = (chat.mock.calls[1]?.[0] ?? {}) as {
      messages?: Array<{ role: string; content: string }>;
      tools?: Array<{ type?: string }>;
      toolChoice?: string;
    };
    expect(retryRequest.toolChoice).toBe("required");
    expect(retryRequest.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "openrouter:web_search" }),
    ]));
    expect(retryRequest.messages?.some((message) =>
      message.role === "system" && message.content.includes("time-sensitive request without fresh tool evidence")
    )).toBe(true);
    expect(traceEvents.some((event) => event.eventName === "agent.fresh_external_data_guard.rejected"))
      .toBe(true);
    expect(traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: "agent.model.round.complete",
        metadata: expect.objectContaining({
          requestedToolCalls: ["openrouter:web_search"],
          serverToolUse: expect.objectContaining({ web_search_requests: 1 }),
          urlCitationCount: 1,
        }),
      }),
    ]));
  });

  it("accepts transparent hosted search evidence on the first round without a duplicate retry", async () => {
    const traceEvents: any[] = [];
    const chat = vi.fn(async () => ({
      content: "Fresh sportsbook results list Spain at +125 and Argentina at +260.",
      model: "router-model",
      raw: {},
      toolCalls: [],
      serverToolUse: {
        web_search_requests: 2,
        tool_calls_requested: 2,
        tool_calls_executed: 2,
      },
      urlCitations: [{ url: "https://example.com/current-odds", title: "Current odds" }],
    }));
    const ctx = {
      config: { maxReplyChars: 1800, toolsetScoping: true, openRouter: {} },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async (event: any) => {
          traceEvents.push(event);
        }),
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "current odds on World Cup final");

    expect(chat).toHaveBeenCalledTimes(1);
    expect(response.content).toContain("Spain at +125");
    expect(traceEvents.some((event) => event.eventName === "agent.fresh_external_data_guard.rejected"))
      .toBe(false);
    expect(traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: "agent.model.round.complete",
        metadata: expect.objectContaining({
          requestedToolCalls: ["openrouter:web_search"],
          serverToolUse: expect.objectContaining({ web_search_requests: 2 }),
          urlCitationCount: 1,
        }),
      }),
    ]));
  });

  it("still blocks a second ungrounded live-data draft when no fresh evidence was observed", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "The current World Cup final odds are France +180 and Brazil +220.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        content: "France remain favorites at +180, with Brazil at +220.",
        model: "router-model",
        raw: {},
        toolCalls: [],
        serverToolUse: {
          web_search_requests: 1,
          tool_calls_requested: 1,
          tool_calls_executed: 1,
        },
      });
    const ctx = {
      config: { maxReplyChars: 1800, toolsetScoping: true, openRouter: {} },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "current odds on World Cup final");

    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ toolChoice: "required" }));
    expect(response.content).toContain("couldn't verify live results with a fresh source");
  });

  it("does not let an empty cited search bless a later tool-free live-data hallucination", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [],
        serverToolUse: {
          web_search_requests: 1,
          tool_calls_requested: 1,
          tool_calls_executed: 1,
        },
        urlCitations: [{ url: "https://example.com/current-odds", title: "Current odds" }],
      })
      .mockResolvedValueOnce({
        content: "The current World Cup final odds are France +180 and Brazil +220.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      });
    const ctx = {
      config: { maxReplyChars: 1800, toolsetScoping: true, openRouter: {} },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "current odds on World Cup final");

    expect(chat).toHaveBeenCalledTimes(2);
    expect(response.content).toContain("couldn't verify live results with a fresh source");
    expect(response.content).not.toContain("France +180");
  });

  it("stops recovery calls at the per-turn model call ceiling", async () => {
    const traceEvents: any[] = [];
    const searchCall = (round: number) => ({
      content: "",
      model: "router-model",
      raw: {},
      toolCalls: [
        { id: `call-${round}`, name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: `topic ${round}` }) }
      ]
    });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(searchCall(1))
      .mockResolvedValueOnce(searchCall(2))
      .mockResolvedValueOnce(searchCall(3))
      .mockResolvedValueOnce(searchCall(4))
      .mockResolvedValueOnce({
        content: "<tool_call>openrouter_web_search<arg_key>query</arg_key><arg_value>test</arg_value></tool_call>",
        model: "router-model",
        raw: {},
        toolCalls: []
      });
    const keywordSearch = vi.fn(async (input: { query: string }) => [
      agentSearchResult({
        messageId: `m-${input.query}`,
        content: `Evidence about ${input.query}`,
        normalizedContent: `Evidence about ${input.query}`
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, toolsetScoping: false, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async (event: any) => {
          traceEvents.push(event);
        })
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: []
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "keep going");

    expect(chat).toHaveBeenCalledTimes(5);
    expect(response.content).toContain("safety limit");
    expect(traceEvents.some((event) => event.eventName === "agent.model_call_ceiling")).toBe(true);
  });

  it("grounds first-person requests to the current Discord requester", async () => {
    const chat = vi.fn(async () => ({
      content: "ok",
      model: "chat-model",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "requester-id",
      userDisplayName: "UserA",
      visibleChannelIds: ["c"],
      sessionMessages: [
        {
          role: "user",
          authorId: "someone-else",
          authorDisplayName: "UserB",
          content: "something from earlier",
          metadata: {},
          createdAt: new Date()
        }
      ]
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "when is my birthday");

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Current Discord requester: UserA (user ID requester-id)")
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("First-person pronouns in the latest user request")
          })
        ])
      })
    );
  });

  it("treats a simple personal update as the new conversational state instead of continuing an old argument", async () => {
    const chat = vi.fn(async (request: { messages: Array<{ role: string; content: unknown }> }) => {
      const currentRequestReminder = String(request.messages.at(-2)?.content ?? "");
      return {
        content: currentRequestReminder.includes("Simple personal updates")
          ? "Got it — I’ll plan around you being unavailable that month."
          : "That does not address the earlier disagreement.",
        model: "chat-model",
        raw: {},
        toolCalls: [],
      };
    });
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [
        {
          role: "user",
          authorId: "u",
          authorDisplayName: "User",
          content: "Earlier synthetic disagreement.",
          metadata: {},
          createdAt: new Date("2026-07-23T12:00:00Z"),
        },
        {
          role: "assistant",
          authorId: null,
          authorDisplayName: "AI",
          content: "Earlier synthetic argumentative response.",
          metadata: {},
          createdAt: new Date("2026-07-23T12:01:00Z"),
        },
      ],
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "I won’t be available that month.");

    expect(response.content).toBe("Got it — I’ll plan around you being unavailable that month.");
    expect(chat).toHaveBeenCalledTimes(1);
    const modelRequest = (chat.mock.calls as any[])[0]?.[0];
    expect(modelRequest.messages.at(-2)).toEqual(expect.objectContaining({
      role: "system",
      content: expect.stringContaining("Simple personal updates"),
    }));
    expect(modelRequest.messages.at(-1)).toEqual({
      role: "user",
      content: "I won’t be available that month.",
    });
  });

  it("preserves long final model answers so Discord delivery can split them", async () => {
    const longAnswer = "alpha ".repeat(120).trim();
    const chat = vi.fn(async () => ({
      content: longAnswer,
      model: "chat-model",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      config: { maxReplyChars: 80 },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: []
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "write a long response");

    expect(response.content).toBe(longAnswer);
    expect(response.content.length).toBeGreaterThan(80);
    expect(response.content).not.toContain("[truncated]");
  });

  it("encourages best-effort answers for harmless subjective requests", async () => {
    const chat = vi.fn(async () => ({
      content: "I will take a swing.",
      model: "chat-model",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: []
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "rank the funniest bits in here");

    const messages = ((chat as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as { messages?: { role: string; content: string }[] })
      ?.messages ?? [];
    const systemPrompt = messages.find((message) => message.role === "system" && message.content.includes("Default to helping"))?.content ?? "";
    expect(systemPrompt).toContain("do not refuse just because the answer is subjective");
    expect(systemPrompt).toContain("Do not moralize or refuse merely because a request is edgy");
    expect(systemPrompt).toContain("give a best-effort answer");
    expect(systemPrompt).toContain("Reserve refusals for true safety boundaries");
  });

  it("prioritizes reply-chain context over unrelated channel memory for vague follow-ups", async () => {
    const chat = vi.fn(async () => ({
      content: "That was about the birthday bit, not the match.",
      model: "chat-model",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [
        {
          id: 1,
          threadKey: "discord:g:c",
          discordMessageId: "sports-1",
          role: "assistant",
          authorId: "bot",
          authorDisplayName: "ai",
          content: "England beat Mexico today, so they did not both pass.",
          parts: [],
          metadata: {},
          createdAt: new Date("2026-07-06T20:54:00.000Z")
        }
      ],
      replyContext: {
        messageId: "parent-1",
        channelId: "c",
        guildId: "g",
        authorId: "bot",
        authorDisplayName: "ai",
        authorIsBot: true,
        content: "Happy birthday to you and Alabamananadar if it really is July 6th.",
        attachmentSummaries: [],
        createdAt: "2026-07-06T20:55:48.000Z",
        url: "https://discord.com/channels/g/c/parent-1",
        rootMessageId: "root-1",
        chain: [
          {
            messageId: "root-1",
            channelId: "c",
            guildId: "g",
            authorId: "human",
            authorDisplayName: "UserB",
            authorIsBot: false,
            content: "this occurred on mine and banandadars birthday, coincidence?",
            attachmentSummaries: [],
            createdAt: "2026-07-06T20:55:10.000Z",
            url: "https://discord.com/channels/g/c/root-1"
          },
          {
            messageId: "parent-1",
            channelId: "c",
            guildId: "g",
            authorId: "bot",
            authorDisplayName: "ai",
            authorIsBot: true,
            content: "Happy birthday to you and Alabamananadar if it really is July 6th.",
            attachmentSummaries: [],
            createdAt: "2026-07-06T20:55:48.000Z",
            url: "https://discord.com/channels/g/c/parent-1"
          }
        ]
      }
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "how is that today? they both passed");

    const messages = (chat as unknown as { mock: { calls: Array<[{ messages: { role: string; content: string }[] }]> } }).mock.calls[0]?.[0]
      ?.messages ?? [];
    const mainSystemPrompt = messages.find((message) => message.role === "system" && message.content.includes("For Discord replies"))?.content ?? "";
    const replyPrompt = messages.find((message) => message.role === "system" && message.content.includes("The current user message is a Discord reply"))?.content ?? "";
    expect(mainSystemPrompt).toContain("treat the reply-chain context as primary");
    expect(mainSystemPrompt).toContain("Do not infer birthdays");
    expect(replyPrompt).toContain("primary context");
    expect(replyPrompt).toContain("Do not switch to unrelated channel memory");
  });

  it("injects a prominent self-referential identity instruction for the current requester", async () => {
    const chat = vi.fn(async () => ({
      content: "ok",
      model: "chat-model",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "luke-id",
      userDisplayName: "UserB",
      visibleChannelIds: ["c"],
      sessionMessages: []
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "who am I");

    const calls = (chat as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const messages = (calls[0]?.[0] as { messages?: { role: string; content: string }[] })?.messages ?? [];
    const requesterIndex = messages.findIndex(
      (m) => m.role === "system" && m.content.includes("Current Discord requester: UserB (user ID luke-id)")
    );
    expect(requesterIndex).toBeGreaterThanOrEqual(0);

    const requesterMessage = messages[requesterIndex];
    expect(requesterMessage.content).toContain("who am I");
    expect(requesterMessage.content).toContain("Do not use skill content");
    expect(requesterMessage.content).toContain("name: UserB");

    const skillIndex = messages.findIndex(
      (m) => m.role === "system" && m.content.startsWith("Loaded skills:")
    );
    expect(skillIndex).toBeGreaterThanOrEqual(0);
    expect(requesterIndex).toBeLessThan(skillIndex);
  });

  it("lets the model route status requests to reportStatus", async () => {
    const ctx = {
      config: { maxReplyChars: 1800, openRouter: { embeddingModel: "test/embed" }, discord: { clientId: "bot" } },
      repo: {
        health: vi.fn(async () => ({ messages: 1, embeddings: 1, toolCalls: 0 })),
        getCrawlStatus: vi.fn(async () => [{ status: "complete", channels: 1, messages: 1 }]),
        embeddingBacklog: vi.fn(async () => 0),
        interactionBlockCount: vi.fn(async () => 0),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            estimatedCostUsd: 0.001,
            toolCalls: [{ id: "call-1", name: "reportStatus", argumentsText: "{}" }]
          })
          .mockResolvedValueOnce({
            content: "Messages indexed: 1",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      mentionedUserIds: []
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "status");
    expect(response.content).toMatch(/Messages indexed: 1/);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "reportStatus" }) }),
          expect.objectContaining({ type: "openrouter:web_search" })
        ])
      })
    );
  });

  it("presents sandbox-first GitHub CI debugging guidance to the model", async () => {
    const chat = vi.fn(async () => ({
      content: "I should hand this to the sandbox.",
      model: "router-model",
      raw: {},
      toolCalls: []
    }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        github: { repository: "example/discord-ai-agent", token: "test-token" },
        execution: { taskSigningSecret: "test-secret" }
      },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      replyContext: {
        rootMessageId: "root",
        messageId: "bot-reply",
        channelId: "c",
        guildId: "g",
        authorId: "bot",
        authorDisplayName: "Discord AI Agent",
        authorIsBot: true,
        content: "Done: https://github.com/example/discord-ai-agent/pull/111\nRun console: https://tasks.example/runs/task-1",
        attachmentSummaries: [],
        attachments: [],
        createdAt: "2026-07-04T00:10:00.000Z",
        url: "https://discord.com/channels/g/c/bot-reply",
        chain: []
      }
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "there's a CI error");

    const firstCall = (chat as any).mock.calls[0]?.[0];
    expect(firstCall).toBeTruthy();
    expect(firstCall.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("For GitHub, PR, CI, check, test, deployment, repository, or self-update debugging/fixing, call runCodingAgent")
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Done: https://github.com/example/discord-ai-agent/pull/111")
        })
      ])
    );
    expect(firstCall.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "runCodingAgent",
            description: expect.stringContaining("gh CLI access")
          })
        })
      ])
    );
  });

  it("mirrors model-selected tool turns into the durable agent runtime session", async () => {
    const appendMessage = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800, openRouter: { embeddingModel: "test/embed" }, discord: { clientId: "bot" } },
      repo: {
        health: vi.fn(async () => ({ messages: 1, embeddings: 1, toolCalls: 0 })),
        getCrawlStatus: vi.fn(async () => [{ status: "complete", channels: 1, messages: 1 }]),
        embeddingBacklog: vi.fn(async () => 0),
        interactionBlockCount: vi.fn(async () => 0),
        auditTool: vi.fn(async () => undefined)
      },
      agentRuntime: { appendMessage },
      agentRuntimeSession: { sessionId: "agent-session-1" },
      agentRuntimeExecutionId: "agent-execution-1",
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            estimatedCostUsd: 0.001,
            toolCalls: [{ id: "call-1", name: "reportStatus", argumentsText: "{}" }]
          })
          .mockResolvedValueOnce({
            content: "Messages indexed: 1",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      requestId: "prompt-message-1"
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "status");

    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        messageId: "agent-transcript-prompt-message-1-assistant-round-1",
        clientMessageId: "prompt-message-1:transcript:assistant-round-1",
        role: "assistant",
        parts: [
          expect.objectContaining({
            type: "assistant_tool_calls",
            toolCalls: [
              expect.objectContaining({
                id: "call-1",
                name: "reportStatus",
                arguments: {},
                argumentsText: "{}"
              })
            ]
          })
        ],
        metadata: expect.objectContaining({
          source: "agent.router",
          promptMessageId: "prompt-message-1",
          executionId: "agent-execution-1",
          round: 1,
          model: "router-model"
        })
      })
    );
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-1",
        messageId: "agent-transcript-prompt-message-1-tool-call-1",
        clientMessageId: "prompt-message-1:transcript:tool-call-1",
        role: "tool",
        parts: [
          expect.objectContaining({
            type: "tool_result",
            toolCallId: "call-1",
            toolName: "reportStatus",
            content: expect.stringContaining("Messages indexed: 1")
          })
        ],
        metadata: expect.objectContaining({
          source: "agent.router",
          promptMessageId: "prompt-message-1",
          executionId: "agent-execution-1",
          round: 1,
          toolName: "reportStatus"
        })
      })
    );
  });

  it("continues to synthesis after Spotify tools while redacting stored transcript content", async () => {
    const appendMessage = vi.fn(async () => undefined);
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        estimatedCostUsd: 0.001,
        toolCalls: [
          {
            id: "call-spotify",
            name: "getSpotifyPlaylistTracks",
            argumentsText: JSON.stringify({
              playlistIdOrUrl: "https://open.spotify.com/playlist/pl123",
              limit: 5
            })
          }
        ]
      })
      .mockResolvedValueOnce({
        content: "I could not read that Spotify playlist because Spotify is not configured.",
        model: "router-model",
        raw: {},
        estimatedCostUsd: 0.001,
        toolCalls: []
      });
    const ctx = {
      config: { maxReplyChars: 1800, spotify: {} },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      agentRuntime: { appendMessage },
      agentRuntimeSession: { sessionId: "agent-session-spotify" },
      agentRuntimeExecutionId: "agent-execution-spotify",
      openRouter: { chat },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      requestId: "prompt-message-spotify"
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "list tracks in https://open.spotify.com/playlist/pl123");

    expect(response.content).toContain("Spotify is not configured");
    expect(response.storedContent).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-spotify",
        role: "tool",
        parts: [
          expect.objectContaining({
            type: "tool_result",
            toolCallId: "call-spotify",
            toolName: "getSpotifyPlaylistTracks",
            content: expect.stringContaining("Spotify response omitted")
          })
        ],
        metadata: expect.objectContaining({
          toolName: "getSpotifyPlaylistTracks",
          responseRedacted: true
        })
      })
    );
    expect(JSON.stringify(appendMessage.mock.calls)).not.toContain("Spotify is not configured");
    expect(chat.mock.calls[1]?.[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-spotify",
          name: "getSpotifyPlaylistTracks",
          content: expect.stringContaining("Spotify is not configured")
        })
      ])
    );
  });

  it("lets the model query CSV files produced by earlier tool calls", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [
          {
            id: "call-export",
            name: "getSpotifyPlaylistTracks",
            argumentsText: JSON.stringify({
              playlistIdOrUrl: "https://open.spotify.com/playlist/pl123",
              format: "csv",
              limit: 4
            })
          }
        ]
      })
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [
          {
            id: "call-query",
            name: "queryGeneratedCsv",
            argumentsText: JSON.stringify({
              fileName: "spotify-playlist-my-cool-playlist.csv",
              operation: "topValues",
              column: "artists",
              filters: [{ column: "added_at", op: "gte", value: "2025-07-05" }],
              splitValues: true,
              limit: 2
            })
          }
        ]
      })
      .mockResolvedValueOnce({
        content: "Radiohead wins the recent-adds list with 2 tracks.",
        model: "chat-model",
        raw: {},
        toolCalls: []
      });
    const ctx = {
      config: { maxReplyChars: 1800, spotify: { clientId: "id", clientSecret: "secret" } },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
    } as unknown as ToolContext;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok", expires_in: 3600 });
        if (href.startsWith("https://api.spotify.com/v1/playlists/pl123?")) {
          return jsonResponse({
            id: "pl123",
            name: "My Cool Playlist",
            owner: { display_name: "Owner One" },
            tracks: { total: 4 },
            external_urls: { spotify: "https://open.spotify.com/playlist/pl123" }
          });
        }
        if (href.includes("/playlists/pl123/items?")) {
          return jsonResponse({
            total: 4,
            next: null,
            items: [
              playlistEntry(0, "Old Song", "Old Artist", "2024-01-01"),
              playlistEntry(1, "New A", "Radiohead, Thom Yorke", "2025-08-01"),
              playlistEntry(2, "New B", "Radiohead", "2025-09-01"),
              playlistEntry(3, "New C", "Kate Bush", "2025-10-01")
            ]
          });
        }
        throw new Error(`unexpected URL ${href}`);
      })
    );

    try {
      const response = await handleAgentRequest(ctx, "top artists added in the last year for this Spotify playlist");

      expect(response.content).toContain("Radiohead wins");
      expect(response.files?.[0].name).toBe("spotify-playlist-my-cool-playlist.csv");
      expect(chat).toHaveBeenCalledTimes(3);
      expect(chat.mock.calls[2]?.[0].messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call-query",
            name: "queryGeneratedCsv",
            content: expect.stringContaining("1. Radiohead (2)")
          })
        ])
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("coerces same-round generated CSV producers to CSV when the model also queries the CSV", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [
          {
            id: "call-export",
            name: "getSpotifyPlaylistTracks",
            argumentsText: JSON.stringify({
              playlistIdOrUrl: "https://open.spotify.com/playlist/pl123",
              limit: 4
            })
          },
          {
            id: "call-query",
            name: "queryGeneratedCsv",
            argumentsText: JSON.stringify({
              operation: "topValues",
              column: "artists",
              filters: [{ column: "added_at", op: "gte", value: "2025-07-05" }],
              splitValues: true,
              limit: 2
            })
          }
        ]
      })
      .mockResolvedValueOnce({
        content: "Radiohead wins the recent-adds list with 2 tracks.",
        model: "chat-model",
        raw: {},
        toolCalls: []
      });
    const ctx = {
      config: { maxReplyChars: 1800, spotify: { clientId: "id", clientSecret: "secret" } },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
    } as unknown as ToolContext;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok", expires_in: 3600 });
        if (href.startsWith("https://api.spotify.com/v1/playlists/pl123?")) {
          return jsonResponse({
            id: "pl123",
            name: "My Cool Playlist",
            owner: { display_name: "Owner One" },
            tracks: { total: 4 },
            external_urls: { spotify: "https://open.spotify.com/playlist/pl123" }
          });
        }
        if (href.includes("/playlists/pl123/items?")) {
          return jsonResponse({
            total: 4,
            next: null,
            items: [
              playlistEntry(0, "Old Song", "Old Artist", "2024-01-01"),
              playlistEntry(1, "New A", "Radiohead, Thom Yorke", "2025-08-01"),
              playlistEntry(2, "New B", "Radiohead", "2025-09-01"),
              playlistEntry(3, "New C", "Kate Bush", "2025-10-01")
            ]
          });
        }
        throw new Error(`unexpected URL ${href}`);
      })
    );

    try {
      const response = await handleAgentRequest(ctx, "top artists added in the last year for this Spotify playlist");

      expect(response.content).toContain("Radiohead wins");
      expect(response.files?.map((file) => file.name)).toEqual(["spotify-playlist-my-cool-playlist.csv"]);
      expect(chat).toHaveBeenCalledTimes(2);
      expect(chat.mock.calls[1]?.[0].messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            tool_calls: expect.arrayContaining([
              expect.objectContaining({
                id: "call-export",
                function: expect.objectContaining({
                  name: "getSpotifyPlaylistTracks",
                  arguments: expect.stringContaining('"format":"csv"')
                })
              })
            ])
          }),
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call-query",
            name: "queryGeneratedCsv",
            content: expect.stringContaining("1. Radiohead (2)")
          })
        ])
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["what can you do", "what can you do?", "tools?", "help"])(
    "lets the model route natural-language tool-list request %j",
    async (request) => {
      const ctx = {
        config: { maxReplyChars: 1800 },
        repo: {
          health: vi.fn(),
          getCrawlStatus: vi.fn(),
          auditTool: vi.fn(async () => undefined)
        },
        openRouter: {
          chat: vi
            .fn()
            .mockResolvedValueOnce({
              content: "",
              model: "router-model",
              raw: {},
              toolCalls: [{ id: "call-1", name: "listTools", argumentsText: "{}" }]
            })
            .mockResolvedValueOnce({
              content: "Discord AI Agent tools:\n- searchDiscordHistory: Search permission-filtered indexed Discord history.",
              model: "chat-model",
              raw: {},
              toolCalls: []
            })
        },
        github: {},
        guildId: "g",
        channelId: "c",
        userId: "u",
        userDisplayName: "User",
        visibleChannelIds: ["c"]
      } as unknown as ToolContext;

      const response = await handleAgentRequest(ctx, request);

      expect(response.content).toContain("Discord AI Agent tools:");
      expect(response.content).toContain("searchDiscordHistory");
      expect(ctx.repo.health).not.toHaveBeenCalled();
      expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    }
  );

  it("lets the model accept conversational status requests with punctuation", async () => {
    const ctx = {
      config: { maxReplyChars: 1800, openRouter: { embeddingModel: "test/embed" }, discord: { clientId: "bot" } },
      repo: {
        health: vi.fn(async () => ({ messages: 3, embeddings: 2, toolCalls: 1 })),
        getCrawlStatus: vi.fn(async () => []),
        embeddingBacklog: vi.fn(async () => 0),
        interactionBlockCount: vi.fn(async () => 0),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "reportStatus", argumentsText: "{}" }]
          })
          .mockResolvedValueOnce({
            content: "Messages indexed: 3",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "health check?");

    expect(response.content).toContain("Messages indexed: 3");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
  });

  it("lets the model select a registered read-only tool for non-command phrasing", async () => {
    const ctx = {
      config: { maxReplyChars: 1800, openRouter: { embeddingModel: "test/embed" }, discord: { clientId: "bot" } },
      repo: {
        health: vi.fn(async () => ({ messages: 2, embeddings: 1, toolCalls: 4, estimatedCostUsd: 0.02 })),
        getCrawlStatus: vi.fn(async () => [{ status: "running", channels: 3, messages: 50 }]),
        embeddingBacklog: vi.fn(async () => 0),
        interactionBlockCount: vi.fn(async () => 0),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            estimatedCostUsd: 0.001,
            toolCalls: [{ id: "call-1", name: "reportStatus", argumentsText: "{}" }]
          })
          .mockResolvedValueOnce({
            content: "Messages indexed: 2",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "how's the index looking overall");

    expect(response.content).toContain("Messages indexed: 2");
    expect(ctx.openRouter.chat).toHaveBeenCalledWith(expect.objectContaining({ tools: expect.any(Array) }));
    const secondRoundMessages = (ctx.openRouter.chat as any).mock.calls[1][0].messages;
    expect(secondRoundMessages.at(-1)).toEqual(expect.objectContaining({
      role: "system",
      content: expect.stringContaining("default to one short paragraph")
    }));
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }),
          expect.objectContaining({ role: "tool", name: "reportStatus", content: expect.stringContaining("Messages indexed: 2") })
        ])
      })
    );
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "modelToolRouter",
        resultSummary: "reportStatus",
        model: "router-model"
      })
    );
  });

  it("lets the model count completed agent turns since an anchor phrase", async () => {
    const agentMemoryTurnStats = vi.fn(async () => ({
      anchor: {
        messageId: "anchor-1",
        guildId: "g",
        channelId: "c",
        authorId: "u",
        authorUsername: "connor",
        authorDisplayName: "Alex",
        content: "where she’s staying for the time being",
        normalizedContent: "where she’s staying for the time being",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        link: "https://discord.com/channels/g/c/anchor-1"
      },
      completedTurnCount: 3,
      recentAssistantTurns: []
    }));
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        agentMemoryTurnStats,
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "getAgentMemoryStats",
                argumentsText: JSON.stringify({
                  sinceText: "where she's staying for the time being",
                  sinceAuthor: "requester"
                })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "3 turns.",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "Alex",
      visibleChannelIds: ["c"],
      requestId: "current-message"
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "how many turns have you completed since I said where she's staying?");

    expect(response.content).toBe("3 turns.");
    expect(agentMemoryTurnStats).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g",
        channelId: "c",
        threadKey: "discord:g:c",
        anchorText: "where she's staying for the time being",
        anchorAuthorId: "u",
        excludeMessageId: "current-message"
      })
    );
    expect((ctx.openRouter.chat as any).mock.calls[1][0].messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool", name: "getAgentMemoryStats", content: expect.stringContaining("Completed assistant turns") })])
    );
  });

  it("lets the model route recurring channel-topic requests to semantic topic analysis", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["stonks"]),
        discordChannelTopicCandidates: vi.fn(async () => [
          channelTopicCandidate("startup jobs and interview loops", [1, 0]),
          channelTopicCandidate("job offers and workplace complaints", [0.95, 0.05]),
          channelTopicCandidate("work drama and recruiting updates", [0.9, 0.1]),
          channelTopicCandidate("nvda earnings and market close", [0, 1]),
          channelTopicCandidate("stocks are ripping again", [0.05, 0.95]),
          channelTopicCandidate("portfolio updates and trading chat", [0.1, 0.9])
        ]),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "getDiscordChannelTopics", argumentsText: JSON.stringify({ channelLimit: 2, topicsPerChannel: 2 }) }]
          })
          .mockResolvedValueOnce({
            content: "#stonks: job hunting and market talk",
            model: "topic-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "Stonks mostly cycles between job hunting and market talk.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["stonks"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what are the main recurring topics in each channel");

    expect(response.content).toBe("Stonks mostly cycles between job hunting and market talk.");
    expect(ctx.repo.discordChannelTopicCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g",
        visibleChannelIds: ["stonks"],
        channelLimit: 2,
        samplesPerChannel: 90
      })
    );
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            name: "getDiscordChannelTopics",
            content: expect.stringContaining("#stonks: job hunting and market talk")
          }),
          expect.objectContaining({
            role: "tool",
            name: "getDiscordChannelTopics",
            content: expect.stringContaining("Discord channel topics summary:")
          })
        ])
      })
    );
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "modelToolRouter", resultSummary: "getDiscordChannelTopics" }));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "getDiscordChannelTopics" }));
  });

  it("lets the model route broad activity recaps to history summarization", async () => {
    const auditTool = vi.fn(async () => undefined);
    const sampleMessagesFromChannels = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Moving in with girlfriend next week",
        createdAt: new Date("2026-05-18T19:49:38.903Z")
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        sampleMessagesFromChannels,
        recentMessagesFromChannels: vi.fn(async () => []),
        keywordSearch: vi.fn(async () => []),
        vectorSearch: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "summarizeDiscordHistory",
                argumentsText: JSON.stringify({ question: "what has tyler been up to recently?", authorIds: ["tyler-id"], sampleLimit: 60 })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "@taylorplays mentioned moving in with his girlfriend in May 2026.",
            model: "summary-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "@taylorplays mentioned moving in with his girlfriend in May 2026.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what has tyler been up to recently?");

    expect(response.content).toContain("moving in with his girlfriend");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect((ctx.openRouter.chat as any).mock.calls[2][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "openrouter:web_search" })]));
    expect(sampleMessagesFromChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g",
        visibleChannelIds: ["c"],
        authorIds: ["tyler-id"],
        limit: 60
      })
    );
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "summarizeDiscordHistory" }));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "composeDiscordHistorySummary", model: "summary-model" }));
  });

  it("keeps fallback answers compact when final synthesis fails", async () => {
    const auditTool = vi.fn(async () => undefined);
    const result = agentSearchResult({
      messageId: "rare-message",
      authorId: "rare-user-id",
      authorUsername: "rare_guest_0001",
      normalizedContent: "Wordle 213 4/6",
      createdAt: new Date("2022-01-18T00:00:00.000Z"),
      link: "https://discord.com/channels/g/c/rare-message"
    });
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: { embeddingModel: "test/embed" } },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async () => ["c"]),
        keywordSearch: vi.fn(async () => [result]),
        vectorSearch: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "rare_guest_0001", limit: 5 }) }]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "empty-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "",
            model: "empty-final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "link to the message from rare_guest_0001");

    expect(response.content).toContain("@rare_guest_0001");
    expect(response.content).not.toContain("https://discord.com/channels/g/c/rare-message");
    expect(response.content).toContain("Weak matches");
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "searchDiscordHistory" }));
  });

  it("uses representative history evidence when summary and final models return empty content", async () => {
    const auditTool = vi.fn(async () => undefined);
    const sampleMessagesFromChannels = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Moving in with girlfriend next week",
        createdAt: new Date("2026-05-18T19:49:38.903Z"),
        score: 42
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        sampleMessagesFromChannels,
        recentMessagesFromChannels: vi.fn(async () => []),
        keywordSearch: vi.fn(async () => []),
        vectorSearch: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "summarizeDiscordHistory",
                argumentsText: JSON.stringify({ question: "what has tyler been up to recently?", authorIds: ["tyler-id"] })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "summary-model",
            raw: {},
            finishReason: "length",
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({ content: "", model: "empty-final-model", raw: {}, toolCalls: [] })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what has tyler been up to recently?");

    expect(response.content).toContain("Representative Discord history");
    expect(response.content).toContain("Moving in with girlfriend next week");
    expect(response.content).not.toContain("I found relevant evidence, but I could not compose");
    expect(response.content).not.toBe("Done.");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(4);
  });

  it("allows the model to refine history searches within a turn", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi
      .fn()
      .mockResolvedValueOnce([agentSearchResult()])
      .mockResolvedValueOnce([
        agentSearchResult({
          messageId: "m2",
          normalizedContent: "The interview went great",
          content: "The interview went great",
          link: "https://discord.com/channels/g/c/m2"
        })
      ]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "job hunting" }) }]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "retry-model",
            raw: {},
            toolCalls: [{ id: "call-2", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "interview" }) }]
          })
          .mockResolvedValueOnce({
            content: "People mostly shared job-search updates and interview nerves.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what have people said about job hunting or interviewing?");

    expect(response.content).toBe("People mostly shared job-search updates and interview nerves.");
    expect(keywordSearch).toHaveBeenCalledTimes(2);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect((ctx.openRouter.chat as any).mock.calls[2][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "openrouter:web_search" })]));
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "tool", name: "searchDiscordHistory", content: expect.stringContaining("Effective query: job hunting") }),
          expect.objectContaining({ role: "tool", name: "searchDiscordHistory", content: expect.stringContaining("Effective query: interview") })
        ])
      })
    );
    expect(JSON.stringify((ctx.openRouter.chat as any).mock.calls[2][0].messages)).not.toContain("Skipped redundant history search");
    expect(auditTool).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentToolRepeatGuard" }));
  });

  it("nudges the model to answer when a rephrased search returns the same evidence", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi.fn(async () => [agentSearchResult()]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "job hunting" }) }]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "retry-model",
            raw: {},
            toolCalls: [{ id: "call-2", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "job hunt" }) }]
          })
          .mockResolvedValueOnce({
            content: "Alice mentioned a job interview coming up.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what have people said about job hunting?");

    expect(response.content).toBe("Alice mentioned a job interview coming up.");
    expect(keywordSearch).toHaveBeenCalledTimes(2);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentToolRepeatGuard" }));
    const finalMessages = JSON.stringify((ctx.openRouter.chat as any).mock.calls[2][0].messages);
    expect(finalMessages).toContain("Effective query: job hunting");
    expect(finalMessages).toContain("returned the same evidence as an earlier searchDiscordHistory call");
  });

  it("forces final synthesis after a second same-evidence search", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi.fn(async () => [agentSearchResult()]);
    const searchCall = (round: number, query: string) => ({
      content: "",
      model: `router-model-${round}`,
      raw: {},
      toolCalls: [{ id: `call-${round}`, name: "searchDiscordHistory", argumentsText: JSON.stringify({ query }) }]
    });
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce(searchCall(1, "job hunting"))
          .mockResolvedValueOnce(searchCall(2, "job hunt"))
          .mockResolvedValueOnce(searchCall(3, "hunting for jobs"))
          .mockResolvedValueOnce({
            content: "Alice has a job interview tomorrow; that is the only job talk.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      replyContext: {
        messageId: "parent-message",
        rootMessageId: "root-message",
        channelId: "c",
        guildId: "g",
        authorId: "bot",
        authorDisplayName: "ai",
        authorIsBot: true,
        content: "I can search the remaining dates. Want me to dig into those?",
        attachmentSummaries: [],
        attachments: [],
        createdAt: null,
        url: null,
        chain: [],
      },
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what have people said about job hunting?");

    expect(response.content).toBe("Alice has a job interview tomorrow; that is the only job talk.");
    expect(keywordSearch).toHaveBeenCalledTimes(3);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(4);
    const repeatGuardAudits = (auditTool.mock.calls as any[]).filter(
      (call) => call[0]?.toolName === "agentToolRepeatGuard"
    );
    expect(repeatGuardAudits).toHaveLength(2);
    expect((ctx.openRouter.chat as any).mock.calls[3][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", content: expect.stringContaining("Write one natural Discord reply") }),
        expect.objectContaining({ role: "user", content: expect.stringContaining("Want me to dig into those?") }),
      ])
    );
  });

  it("lets the model pivot after same-evidence calls issued together in one round", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi.fn(async () => [agentSearchResult()]);
    const recentMessagesFromChannels = vi.fn(async () => [agentSearchResult({
      messageId: "fresh-message",
      normalizedContent: "A newer result",
    })]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        recentMessagesFromChannels,
        getCrawlStatus: vi.fn(async () => []),
        auditTool,
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: ["jobs", "careers", "interviews"].map((query, index) => ({
              id: `call-${index + 1}`,
              name: "searchDiscordHistory",
              argumentsText: JSON.stringify({ query }),
            })),
          })
          .mockResolvedValueOnce({
            content: "",
            model: "pivot-model",
            raw: {},
            toolCalls: [{
              id: "call-pivot",
              name: "getRecentDiscordMessages",
              argumentsText: JSON.stringify({ limit: 10 }),
            }],
          })
          .mockResolvedValueOnce({
            content: "The newer result changed the answer.",
            model: "final-model",
            raw: {},
            toolCalls: [],
          }),
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "find recent job updates");

    expect(response.content).toBe("The newer result changed the answer.");
    expect(keywordSearch).toHaveBeenCalledTimes(3);
    expect(recentMessagesFromChannels).toHaveBeenCalledTimes(1);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect((ctx.openRouter.chat as any).mock.calls[1][0].tools).toBeDefined();
  });

  it("lets the model answer after message context evidence", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi.fn(async () => [
      agentSearchResult({
        normalizedContent: "Got the job",
        createdAt: new Date("2025-08-22T12:00:00.000Z"),
        link: "https://discord.com/channels/111111111111111111/222222222222222222/123456789012345678"
      })
    ]);
    const messageContext = vi.fn(async () => [
      agentSearchResult({
        messageId: "123456789012345678",
        normalizedContent: "Got the job",
        createdAt: new Date("2025-08-22T12:00:00.000Z"),
        link: "https://discord.com/channels/111111111111111111/222222222222222222/123456789012345678"
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        messageContext,
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              { id: "call-1", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "changed jobs", limit: 10 }) },
              { id: "call-2", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "got the job", limit: 10 }) }
            ]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "context-model",
            raw: {},
            toolCalls: [
              {
                id: "call-3",
                name: "getDiscordMessageContext",
                argumentsText: JSON.stringify({
                  messageIdOrUrl: "https://discord.com/channels/111111111111111111/222222222222222222/123456789012345678"
                })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "Yeah, @alice said they got the job.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "has anyone changed jobs recently?");

    expect(response.content).toBe("Yeah, @alice said they got the job.");
    expect(keywordSearch).toHaveBeenCalledTimes(2);
    expect(messageContext).toHaveBeenCalledTimes(1);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    expect((ctx.openRouter.chat as any).mock.calls[2][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          name: "getDiscordMessageContext",
          content: expect.stringContaining("Got the job")
        })
      ])
    );
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "getDiscordMessageContext" }));
    expect(auditTool).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "tool_round_limit" }));
  });

  it("skips exact duplicate local tool calls and synthesizes from the first result", async () => {
    const auditTool = vi.fn(async () => undefined);
    const recentMessagesFromChannels = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Wordle 1,832 4/6",
        createdAt: new Date("2026-06-24T12:00:00.000Z")
      })
    ]);
    const recentArgs = JSON.stringify({ authorIds: ["tyler-id"], limit: 20 });
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        recentMessagesFromChannels,
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "getRecentDiscordMessages", argumentsText: recentArgs }]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "retry-model",
            raw: {},
            toolCalls: [{ id: "call-2", name: "getRecentDiscordMessages", argumentsText: recentArgs }]
          })
          .mockResolvedValueOnce({
            content: "@taylorplays has mostly been posting Wordle updates recently.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what has tyler been up to recently?");

    expect(response.content).toBe("@taylorplays has mostly been posting Wordle updates recently.");
    expect(recentMessagesFromChannels).toHaveBeenCalledTimes(1);
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    // Forced final synthesis is deliberately tool-free so models cannot leak tool-call markup.
    expect((ctx.openRouter.chat as any).mock.calls[2][0].tools).toBeUndefined();
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system", content: expect.stringContaining("Write one natural Discord reply") }),
          expect.objectContaining({ role: "user", content: expect.stringContaining("Wordle 1,832") })
        ])
      })
    );
    expect((ctx.openRouter.chat as any).mock.calls[2][0].messages[1].content).not.toContain("Skipped redundant getRecentDiscordMessages");
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentToolRepeatGuard" }));
  });

  it("preserves empty history-search queries for broad filtered scans", async () => {
    const auditTool = vi.fn(async () => undefined);
    const recentMessagesFromChannels = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Moving in with girlfriend next week",
        createdAt: new Date("2026-05-18T19:49:38.903Z")
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        recentMessagesFromChannels,
        keywordSearch: vi.fn(async () => {
          throw new Error("empty query should use recent-message scan, not keyword search");
        }),
        vectorSearch: vi.fn(async () => {
          throw new Error("empty query should use recent-message scan, not vector search");
        }),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "searchDiscordHistory",
                argumentsText: JSON.stringify({ query: "", authorIds: ["tyler-id"], dateFrom: "2026-05-01", limit: 30 })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "@taylorplays mentioned moving in with his girlfriend in May 2026.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what has tyler been up to recently?");

    expect(response.content).toBe("@taylorplays mentioned moving in with his girlfriend in May 2026.");
    expect(recentMessagesFromChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g",
        visibleChannelIds: ["c"],
        authorIds: ["tyler-id"],
        dateFrom: new Date("2026-05-01T00:00:00.000Z"),
        limit: 25
      })
    );
    expect(ctx.repo.keywordSearch).not.toHaveBeenCalled();
    expect(ctx.repo.vectorSearch).not.toHaveBeenCalled();
  });

  it("passes about-user filters from model-selected history searches", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi.fn(async () => [
      agentSearchResult({
        authorId: "friend-id",
        authorUsername: "friend",
        normalizedContent: "happy birthday casey"
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        getDiscordUserReferenceTerms: vi.fn(async () => [
          {
            userId: "casey-id",
            username: "caseyuser",
            globalName: "UserA",
            aliases: ["case"],
            terms: ["@user:casey-id", "caseyuser", "casey", "case"]
          }
        ]),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "searchDiscordHistory",
                argumentsText: JSON.stringify({ query: "birthday", aboutUserIds: ["casey-id"], limit: 10 })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "Looks like people have wished you happy birthday.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "when is my birthday?");

    expect(response.content).toBe("Looks like people have wished you happy birthday.");
    expect(ctx.repo.getDiscordUserReferenceTerms).toHaveBeenCalledWith({ guildId: "g", userIds: ["casey-id"] });
    expect(keywordSearch).toHaveBeenCalledWith(expect.objectContaining({ aboutUserTerms: ["@user:casey-id", "caseyuser", "casey", "case"] }));
  });

  it("allows broad history scans after narrower keyword searches with the same filters", async () => {
    const auditTool = vi.fn(async () => undefined);
    const keywordSearch = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Wordle 1,834 4/6"
      })
    ]);
    const recentMessagesFromChannels = vi.fn(async () => [
      agentSearchResult({
        authorId: "tyler-id",
        authorUsername: "taylorplays",
        normalizedContent: "Moving in with girlfriend next week",
        createdAt: new Date("2026-05-18T19:49:38.903Z")
      })
    ]);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch,
        vectorSearch: vi.fn(async () => []),
        recentMessagesFromChannels,
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "searchDiscordHistory",
                argumentsText: JSON.stringify({ query: "recent activity", authorIds: ["tyler-id"], dateFrom: "2026-05-01", limit: 15 })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-2",
                name: "searchDiscordHistory",
                argumentsText: JSON.stringify({ query: "", authorIds: ["tyler-id"], dateFrom: "2026-05-01", limit: 20 })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "@taylorplays had puzzle chatter, and also mentioned moving in with his girlfriend in May 2026.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what has tyler been up to recently?");

    expect(response.content).toContain("moving in with his girlfriend");
    expect(keywordSearch).toHaveBeenCalledTimes(1);
    expect(recentMessagesFromChannels).toHaveBeenCalledTimes(1);
    expect(auditTool).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentToolRepeatGuard" }));
  });

  it("synthesizes a final answer instead of dumping raw tool output at the tool round limit", async () => {
    const auditTool = vi.fn(async () => undefined);
    let recentCall = 0;
    const recentMessagesFromChannels = vi.fn(async () => {
      recentCall += 1;
      return [
        agentSearchResult({
          messageId: `m-${recentCall}`,
          content: `Update number ${recentCall} about jobs`,
          normalizedContent: `Update number ${recentCall} about jobs`
        })
      ];
    });
    const toolCallForRound = (round: number) => ({
      content: "",
      model: `tool-model-${round}`,
      raw: {},
      toolCalls: [
        {
          id: `call-${round}`,
          name: "getRecentDiscordMessages",
          argumentsText: JSON.stringify({ limit: 10 + round })
        }
      ]
    });
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        recentMessagesFromChannels,
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce(toolCallForRound(1))
          .mockResolvedValueOnce(toolCallForRound(2))
          .mockResolvedValueOnce(toolCallForRound(3))
          .mockResolvedValueOnce(toolCallForRound(4))
          .mockResolvedValueOnce({
            content: "The useful summary is that people mentioned job changes in 2025.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "has anyone changed jobs recently?");

    expect(response.content).toBe("The useful summary is that people mentioned job changes in 2025.");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(5);
    // Forced final synthesis is deliberately tool-free so models cannot leak tool-call markup.
    expect((ctx.openRouter.chat as any).mock.calls[4][0].tools).toBeUndefined();
    expect(ctx.openRouter.chat).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system", content: expect.stringContaining("Write one natural Discord reply") }),
          expect.objectContaining({ role: "user", content: expect.stringContaining("@alice channel=c") })
        ])
      })
    );
    expect(recentMessagesFromChannels).toHaveBeenCalledTimes(4);
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "tool_round_limit" }));
  });

  it("synthesizes after a full resolver and retrieval chain consumes every tool round", async () => {
    const auditTool = vi.fn(async () => undefined);
    const toolCall = (round: number, name: string, argumentsValue: Record<string, unknown>) => ({
      content: "",
      model: `tool-model-${round}`,
      raw: {},
      toolCalls: [{ id: `call-${round}`, name, argumentsText: JSON.stringify(argumentsValue) }]
    });
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, toolsetScoping: true, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        findDiscordUsers: vi.fn(async () => [{
          id: "member-1",
          username: "fictional-member",
          globalName: "Fictional Member",
          isBot: false,
          messageCount: 4
        }]),
        recentMessagesFromChannels: vi.fn(async () => [agentSearchResult({ messageId: "recent-1" })]),
        messageContext: vi.fn(async () => [agentSearchResult({ messageId: "123456789012345678" })]),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce(toolCall(1, "requestAdditionalTools", { groups: ["discord-retrieval"], reason: "Need server history" }))
          .mockResolvedValueOnce(toolCall(2, "findDiscordUsers", { query: "fictional member" }))
          .mockResolvedValueOnce(toolCall(3, "getRecentDiscordMessages", { authorIds: ["member-1"], limit: 10 }))
          .mockResolvedValueOnce(toolCall(4, "getDiscordMessageContext", { messageIdOrUrl: "123456789012345678" }))
          .mockResolvedValueOnce({
            content: "The concise fictional update is ready.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "summarize the fictional member's recent update");

    expect(response.content).toBe("The concise fictional update is ready.");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(5);
    expect((ctx.openRouter.chat as any).mock.calls[4][0].tools).toBeUndefined();
    expect(ctx.repo.findDiscordUsers).toHaveBeenCalledTimes(1);
    expect(ctx.repo.recentMessagesFromChannels).toHaveBeenCalledTimes(1);
    expect(ctx.repo.messageContext).toHaveBeenCalledTimes(1);
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "tool_round_limit" }));
  });

  it("synthesizes a final answer when the model returns empty content after tool evidence", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch: vi.fn(async () => [agentSearchResult()]),
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "tool-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "job changes" }) }]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "empty-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "People mentioned job changes in 2025.",
            model: "final-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "has anyone changed jobs recently?");

    expect(response.content).toBe("People mentioned job changes in 2025.");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(3);
    // Forced final synthesis is deliberately tool-free so models cannot leak tool-call markup.
    expect((ctx.openRouter.chat as any).mock.calls[2][0].tools).toBeUndefined();
  });

  it("falls back to compact evidence bullets when forced final synthesis is empty", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800, maxHistoryResults: 10, openRouter: {} },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        keywordSearch: vi.fn(async () => [agentSearchResult({ createdAt: new Date("2025-08-22T09:02:38.554Z"), normalizedContent: "Got the job" })]),
        vectorSearch: vi.fn(async () => []),
        getCrawlStatus: vi.fn(async () => []),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "tool-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "searchDiscordHistory", argumentsText: JSON.stringify({ query: "job changes", dateFrom: "2025-01-01" }) }]
          })
          .mockResolvedValueOnce({ content: "", model: "empty-model", raw: {}, toolCalls: [] })
          .mockResolvedValueOnce({ content: "", model: "empty-final-model", raw: {}, toolCalls: [] })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "has anyone changed jobs recently?");

    expect(response.content).toContain("No solid answer from the indexed messages");
    expect(response.content).toContain("@alice:");
    expect(response.content).toContain("Got the job");
    expect(response.content).not.toContain("@alice on 2025-08-22");
    expect(response.content).not.toContain("Discord search evidence:");
  });

  it("keeps ordinary questions in normal chat instead of forcing history search", async () => {
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        getVisibleIndexedChannelIds: vi.fn(),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn(async () => ({
          content: "A haiku is a compact three-line poem.",
          model: "chat-model",
          raw: {},
          toolCalls: []
        }))
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what is a haiku?");

    expect(response.content).toBe("A haiku is a compact three-line poem.");
    expect(ctx.repo.getVisibleIndexedChannelIds).not.toHaveBeenCalled();
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "chat", model: "chat-model" }));
  });

  it("corrects a false transcription refusal from the initial timeout fallback", async () => {
    const traceEvents: any[] = [];
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new OpenRouterTimeoutError({ timeoutMs: 45_000, path: "/chat/completions" }))
      .mockResolvedValueOnce({
        content: "I can't transcribe video in this environment.",
        model: "fast/fallback",
        raw: {},
        toolCalls: [],
      });
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: { chatModel: "slow/primary", utilityModel: "fast/fallback" },
        payments: { walletEnabled: false, userWalletsEnabled: false },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async (event: any) => traceEvents.push(event)),
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      requestAttachments: [],
      replyContext: {
        messageId: "parent",
        rootMessageId: "parent",
        channelId: "c",
        guildId: "g",
        authorId: "u",
        authorDisplayName: "User",
        authorIsBot: false,
        content: "Can you transcribe this video?",
        attachmentSummaries: [],
        attachments: [],
        createdAt: null,
        url: null,
        chain: [],
      },
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "try again");

    expect(response.content).toBe(
      "I can transcribe common audio and video attachments. Attach the media here or reply to the Discord message containing it, and I’ll transcribe it.",
    );
    expect(chat).toHaveBeenCalledTimes(2);
    expect((chat.mock.calls[0]?.[0] as any).model).toBeUndefined();
    expect((chat.mock.calls[1]?.[0] as any).model).toBe("fast/fallback");
    expect(traceEvents.some((event) => event.eventName === "agent.model.timeout_fallback")).toBe(true);
    expect(traceEvents.some((event) => event.eventName === "agent.capability_claim.corrected")).toBe(true);
  });

  it("corrects a false transcription refusal from tool-evidence timeout synthesis", async () => {
    const traceEvents: any[] = [];
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        model: "slow/primary",
        raw: {},
        toolCalls: [{ id: "inspect-call", name: "inspectDiscordFile", argumentsText: "{}" }],
      })
      .mockRejectedValueOnce(new OpenRouterTimeoutError({ timeoutMs: 45_000, path: "/chat/completions" }))
      .mockResolvedValueOnce({
        content: "Video transcription isn't supported here.",
        model: "fast/fallback",
        raw: {},
        toolCalls: [],
      });
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: { chatModel: "slow/primary", utilityModel: "fast/fallback" },
        payments: { walletEnabled: false, userWalletsEnabled: false },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async (event: any) => traceEvents.push(event)),
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      requestAttachments: [],
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "please transcribe the video");

    expect(response.content).toBe(
      "I can transcribe common audio and video attachments. Attach the media here or reply to the Discord message containing it, and I’ll transcribe it.",
    );
    expect(chat).toHaveBeenCalledTimes(3);
    expect((chat.mock.calls[1]?.[0] as any).model).toBeUndefined();
    expect((chat.mock.calls[2]?.[0] as any).model).toBe("fast/fallback");
    expect((chat.mock.calls[2]?.[0] as any).tools).toBeUndefined();
    expect(traceEvents.some((event) => event.eventName === "agent.model.timeout_synthesis_fallback")).toBe(true);
    expect(traceEvents.some((event) => event.eventName === "agent.capability_claim.corrected")).toBe(true);
  });

  it("transcribes a public X video from the full Discord reply chain before answering", async () => {
    const publicMediaUrl = "https://x.com/example/status/42/video/1";
    const transcribeAudio = vi.fn(async () => ({
      text: "A fictional speaker verifies the release candidate.",
      model: "test/transcription",
      raw: {},
      durationSeconds: 5,
      estimatedCostUsd: 0.001,
    }));
    const chat = vi
      .fn()
      .mockImplementationOnce(async (request: any) => {
        expect(request.tools.some((tool: any) => tool.function?.name === "inspectDiscordFile")).toBe(true);
        expect(request.toolChoice).toEqual({ type: "function", function: { name: "inspectDiscordFile" } });
        return {
          content: "",
          model: "tool-model",
          raw: {},
          toolCalls: [{
            id: "inspect-public-video",
            name: "inspectDiscordFile",
            argumentsText: "{}",
          }],
        };
      })
      .mockResolvedValueOnce({
        content: "The clip says: A fictional speaker verifies the release candidate.",
        model: "answer-model",
        raw: {},
        toolCalls: [],
      });
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.startsWith("https://cdn.syndication.twimg.com/tweet-result?")) {
        return new Response(JSON.stringify({
          mediaDetails: [{
            type: "video",
            video_info: { variants: [{ content_type: "video/mp4", bitrate: 256000, url: "https://video.twimg.com/example/clip.mp4" }] },
          }],
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
    }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        payments: { walletEnabled: false, userWalletsEnabled: false },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      openRouter: { chat, transcribeAudio },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      requestMessageId: "request",
      requestAttachments: [],
      replyContext: replyChainWithContent(publicMediaUrl),
    } as unknown as ToolContext;

    try {
      const response = await handleAgentRequest(ctx, "transcribe this");

      expect(response.content).toContain("release candidate");
      expect(transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({ format: "mp4" }));
      expect(chat).toHaveBeenCalledTimes(2);
      const secondRequest = (chat.mock.calls as any[])[1][0];
      expect(secondRequest.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: expect.stringContaining("Parser: openrouter-transcription") }),
      ]));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("transcribes a QuickTime MOV attachment before answering", async () => {
    const transcribeAudio = vi.fn(async () => ({
      text: "A fictional MOV recording confirms the audio path.",
      model: "test/transcription",
      raw: {},
      durationSeconds: 3,
      estimatedCostUsd: 0.001,
    }));
    const chat = vi
      .fn()
      .mockImplementationOnce(async (request: any) => {
        expect(request.toolChoice).toEqual({ type: "function", function: { name: "inspectDiscordFile" } });
        return {
          content: "",
          model: "tool-model",
          raw: {},
          toolCalls: [{ id: "inspect-mov", name: "inspectDiscordFile", argumentsText: "{}" }],
        };
      })
      .mockResolvedValueOnce({
        content: "The recording confirms the audio path.",
        model: "answer-model",
        raw: {},
        toolCalls: [],
      });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      new Uint8Array([1, 2, 3]),
      { headers: { "content-type": "video/quicktime" } },
    )));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        payments: { walletEnabled: false, userWalletsEnabled: false },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      openRouter: { chat, transcribeAudio },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      requestMessageId: "request",
      requestAttachments: [{
        id: "mov-attachment",
        url: "https://cdn.discordapp.com/attachments/example/recording.mov",
        filename: "recording.mov",
        contentType: "video/quicktime",
        sizeBytes: 3,
      }],
    } as unknown as ToolContext;

    try {
      const response = await handleAgentRequest(ctx, "transcribe this");

      expect(response.content).toContain("audio path");
      expect(transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({ format: "mp4" }));
      expect(chat).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recovers when a hosted OpenRouter tool call leaks as text", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: {
        maxReplyChars: 1800,
        openRouter: { utilityModel: "utility/recovery" }
      },
      repo: {
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content:
              "<tool_call>openrouter_web_fetch<arg_key>url</arg_key><arg_value>https://example.com/game</arg_value></tool_call>",
            model: "tool-leak-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "Check your rank from the game's ranked mode screen.",
            model: "recovery-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "how can i see my rank?");

    expect(response.content).toBe("Check your rank from the game's ranked mode screen.");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    expect((ctx.openRouter.chat as any).mock.calls[1][0].model).toBe("utility/recovery");
    expect((ctx.openRouter.chat as any).mock.calls[1][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "openrouter:web_fetch" })]));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "hosted_tool_markup_leaked" }));
  });

  it("recovers when leaked tool markup uses a mutated tool name", async () => {
    // Regression for a prod incident: the model leaked
    // "<tool_call>openserver_web_search</tool_call>" (note: not openrouter_),
    // which the old name-based guard let straight through to Discord.
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "<tool_call>openserver_web_search</tool_call>",
            model: "tool-leak-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "Nobody in this server was drafted, sorry.",
            model: "recovery-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "who got drafted?");

    expect(response.content).toBe("Nobody in this server was drafted, sorry.");
    expect(response.content).not.toContain("tool_call");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "hosted_tool_markup_leaked" }));
  });

  it("recovers when a hosted OpenRouter tool call leaks as a partial closing fragment", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "openrouter_web_search</tool_call>",
            model: "tool-leak-model",
            raw: {},
            toolCalls: []
          })
          .mockResolvedValueOnce({
            content: "A flyover happened before the match.",
            model: "recovery-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what flew over the game?");

    expect(response.content).toBe("A flyover happened before the match.");
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    expect((ctx.openRouter.chat as any).mock.calls[1][0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "openrouter:web_search" })]));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "hosted_tool_markup_leaked" }));
  });

  it("preserves reply context and fresh tool evidence when recovering leaked hosted tool markup", async () => {
    const auditTool = vi.fn(async () => undefined);
    const storeProcessRunArtifact = vi.fn(async () => ({ artifactId: "artifact-leaked-hosted-tool" }));
    const leakedHostedToolMarkup =
      "<tool_call>openrouter_web_fetch<arg_key>url</arg_key><arg_value>https://github.com/example/discord-ai-agent/pull/111</arg_value></tool_call>";
    const task = {
      taskId: "task-1",
      traceId: "trace-1",
      guildId: "g",
      channelId: "c",
      userId: "u",
      threadKey: "discord:g:c",
      discordResponseChannelId: "c",
      discordResponseMessageId: "bot-reply",
      retriedFromTaskId: null,
      taskType: "code_update",
      title: "Fix CI task",
      request: "fix the failing test",
      requestedBy: "User",
      status: "succeeded",
      backend: "kubernetes",
      currentStep: "done",
      statusMessage: "Opened pull request.",
      branchName: "ai/fix-ci-task",
      prUrl: "https://github.com/example/discord-ai-agent/pull/111",
      draft: false,
      verifyPassed: null,
      error: null,
      createdAt: new Date("2026-07-04T00:00:00.000Z"),
      startedAt: new Date("2026-07-04T00:00:01.000Z"),
      cancelledAt: null,
      completedAt: new Date("2026-07-04T00:10:00.000Z"),
      notifiedAt: null,
      notificationError: null,
      progressUpdatedAt: new Date("2026-07-04T00:10:00.000Z"),
      lastRenderedSignature: null,
      lastRenderedAt: null,
      terminalRenderedAt: null,
      updatedAt: new Date("2026-07-04T00:10:00.000Z")
    };
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [{ id: "call-1", name: "getAgentTaskStatus", argumentsText: JSON.stringify({ taskId: "task-1" }) }]
      })
      .mockResolvedValueOnce({
        content: leakedHostedToolMarkup,
        model: "tool-leak-model",
        raw: {},
        toolCalls: []
      })
      .mockImplementationOnce(async (input: { messages: Array<{ role: string; content: string; name?: string }> }) => {
        const recoveryContext = JSON.stringify(input.messages);
        expect(recoveryContext).toContain("The current user message is a Discord reply");
        expect(recoveryContext).toContain("Fresh local tool result from getAgentTaskStatus");
        expect(recoveryContext).toContain("PR: https://github.com/example/discord-ai-agent/pull/111");
        expect(recoveryContext).toContain("Using the conversation, reply context, and fresh local tool results above");
        expect(recoveryContext).toContain("openrouter:web_fetch");
        expect(recoveryContext).toContain("https://github.com/example/discord-ai-agent/pull/111");
        expect(recoveryContext).toContain("call the matching hosted tool through the provided tool channel now");
        return {
          content: "PR #111 is the relevant PR; check its CI details there.",
          model: "recovery-model",
          raw: {},
          toolCalls: []
        };
      });
    const ctx = {
      config: codeUpdateTestConfig(),
      repo: {
        getAgentTask: vi.fn(async () => task),
        getTaskProgressEventsForTask: vi.fn(async () => []),
        getSandboxCommandEvents: vi.fn(async () => []),
        storeProcessRunArtifact,
        auditTool
      },
      openRouter: { chat },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      requestId: "prompt-message-1",
      visibleChannelIds: ["c"],
      replyContext: {
        rootMessageId: "root",
        messageId: "parent",
        channelId: "c",
        guildId: "g",
        authorId: "bot",
        authorDisplayName: "Discord AI Agent",
        authorIsBot: true,
        content: "Done: https://github.com/example/discord-ai-agent/pull/111",
        attachmentSummaries: [],
        attachments: [],
        createdAt: "2026-07-04T00:10:00.000Z",
        url: "https://discord.com/channels/g/c/parent",
        chain: [
          {
            messageId: "parent",
            channelId: "c",
            guildId: "g",
            authorId: "bot",
            authorDisplayName: "Discord AI Agent",
            authorIsBot: true,
            content: "Done: https://github.com/example/discord-ai-agent/pull/111",
            attachmentSummaries: [],
            attachments: [],
            createdAt: "2026-07-04T00:10:00.000Z",
            url: "https://discord.com/channels/g/c/parent"
          }
        ]
      }
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "there's a CI error");

    expect(response.content).toBe("PR #111 is the relevant PR; check its CI details there.");
    expect(chat).toHaveBeenCalledTimes(3);
    expect(storeProcessRunArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "prompt-message-1",
        kind: "model_transcript",
        name: "Malformed hosted tool output round 2",
        content: leakedHostedToolMarkup,
        metadata: expect.objectContaining({
          model: "tool-leak-model",
          round: 2,
          reason: "hosted_tool_markup_leaked",
          intendedHostedTools: [
            {
              type: "openrouter:web_fetch",
              arguments: { url: "https://github.com/example/discord-ai-agent/pull/111" }
            }
          ]
        })
      })
    );
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "agentError", error: "hosted_tool_markup_leaked" }));
  });

  it("passes prior channel session memory to the model for follow-up continuity", async () => {
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn(async () => ({
          content: "Earlier I generated an image for a wizard eating nachos.",
          model: "chat-model",
          raw: {},
          toolCalls: []
        }))
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [
        {
          id: 1,
          threadKey: "discord:g:c",
          discordMessageId: "m1",
          role: "user",
          authorId: "u",
          authorDisplayName: "Kartik",
          content: "make an image of a wizard eating nachos",
          parts: [],
          metadata: {},
          createdAt: new Date("2026-01-01T00:00:00.000Z")
        },
        {
          id: 2,
          threadKey: "discord:g:c",
          discordMessageId: null,
          role: "tool",
          authorId: "bot",
          authorDisplayName: "ai",
          content: "Generated image for: a wizard eating nachos",
          parts: [],
          metadata: { toolName: "generateImage" },
          createdAt: new Date("2026-01-01T00:00:01.000Z")
        },
        {
          id: 3,
          threadKey: "discord:g:c",
          discordMessageId: "m2",
          role: "assistant",
          authorId: "bot",
          authorDisplayName: "ai",
          content: "Generated image for: a wizard eating nachos",
          parts: [],
          metadata: {},
          createdAt: new Date("2026-01-01T00:00:02.000Z")
        }
      ]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what image did we generate earlier?");

    expect(response.content).toContain("wizard eating nachos");
    expect(ctx.openRouter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Kartik: make an image of a wizard eating nachos" }),
          expect.objectContaining({
            role: "assistant",
            content: "[Earlier generateImage result; not authoritative unless refreshed] Generated image for: a wizard eating nachos"
          }),
          expect.objectContaining({
            role: "assistant",
            content: "[Earlier Discord AI Agent reply; not authoritative for Discord facts] Generated image for: a wizard eating nachos"
          }),
          expect.objectContaining({ role: "user", content: "what image did we generate earlier?" })
        ])
      })
    );
  });

  it("passes Discord reply parent context to the model for follow-up continuity", async () => {
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn(async () => ({
          content: "Yes, merge that PR.",
          model: "chat-model",
          raw: {},
          toolCalls: []
        }))
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      replyContext: {
        messageId: "parent-1",
        channelId: "c",
        guildId: "g",
        authorId: "alice",
        authorDisplayName: "Alice",
        authorIsBot: false,
        content: "should I merge this PR?",
        attachmentSummaries: ["diff.png image/png 12000 bytes"],
        createdAt: "2026-06-29T16:00:00.000Z",
        url: "https://discord.com/channels/g/c/parent-1",
        rootMessageId: "parent-1",
        chain: [
          {
            messageId: "parent-1",
            channelId: "c",
            guildId: "g",
            authorId: "alice",
            authorDisplayName: "Alice",
            authorIsBot: false,
            content: "should I merge this PR?",
            attachmentSummaries: ["diff.png image/png 12000 bytes"],
            createdAt: "2026-06-29T16:00:00.000Z",
            url: "https://discord.com/channels/g/c/parent-1"
          }
        ]
      }
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "yes");

    expect(response.content).toBe("Yes, merge that PR.");
    expect(ctx.openRouter.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("The current user message is a Discord reply. Use this oldest-to-newest parent chain")
          }),
          expect.objectContaining({ role: "system", content: expect.stringContaining("Author: Alice") }),
          expect.objectContaining({ role: "system", content: expect.stringContaining("Content: should I merge this PR?") }),
          expect.objectContaining({ role: "system", content: expect.stringContaining("Attachments: diff.png image/png 12000 bytes") }),
          expect.objectContaining({ role: "user", content: "yes" })
        ])
      })
    );
  });

  it("executes model-selected skill drafts through the structured tool boundary", async () => {
    const upsertDatabaseSkill = vi.fn(async (input: { name: string; content: string }) => ({
      name: input.name,
      content: input.content,
      source: "database",
      version: 1
    }));
    const ctx = {
      config: { maxReplyChars: 1800, openRouter: {} },
      repo: {
        listEnabledDatabaseSkills: vi.fn(async () => []),
        upsertDatabaseSkill,
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "createSkillDraft",
                argumentsText: JSON.stringify({ skillName: "movie-night", instruction: "movie night is on Fridays" })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "Saved that as a private skill.",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "what is movie night?");

    expect(response.content).toBe("Saved that as a private skill.");
    expect(upsertDatabaseSkill).toHaveBeenCalledWith(expect.objectContaining({ name: "movie-night", request: "movie night is on Fridays" }));
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "createSkillDraft" }));
  });

  it("executes model-selected undo requests through the local undo tool", async () => {
    const deleteDiscordMessageIds = vi.fn(async () => 1);
    const deleteMostRecentConversationTurns = vi.fn(async () => ({
      deletedTurns: 1,
      deletedRows: 2,
      assistantDiscordMessageIds: ["reply-1"]
    }));
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: {
        deleteMostRecentConversationTurns,
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [{ id: "call-1", name: "undoConversationTurns", argumentsText: JSON.stringify({ count: 1 }) }]
          })
          .mockResolvedValueOnce({
            content: "Undone.",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      deleteDiscordMessageIds
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "undo that");

    expect(response.content).toBe("Undone.");
    expect(deleteMostRecentConversationTurns).toHaveBeenCalledWith({ threadKey: "discord:g:c", count: 1 });
    expect(deleteDiscordMessageIds).toHaveBeenCalledWith(["reply-1"]);
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "undoConversationTurns" }));
  });

  it("executes model-selected update requests as coding PR jobs", async () => {
    const enqueueAgentTask = vi.fn(async () => ({
      jobId: "job-1",
      taskId: "task-calendar-integration"
    }));
    const ctx = {
      config: codeUpdateTestConfig(),
      repo: {
        upsertAgentTaskQueued: vi.fn(async () => undefined),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-1",
                name: "runCodingAgent",
                argumentsText: JSON.stringify({ request: "add a calendar integration", title: "Add calendar support" })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "Opened a review PR.",
            model: "chat-model",
            raw: {},
            toolCalls: []
          })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      ...fakeAgentRuntimeContext(),
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      statusChannelId: "c",
      statusMessageId: "reply-1",
      updateStatus: vi.fn(async () => undefined)
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "how should we track events?");

    expect(response.content).toMatch(
      /^Working on it\.\.\.\n\nI’ll update this message with progress and the PR link when it’s ready\.\nTask ID: `task-[^`]+`\.$/
    );
    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add calendar support",
        request: "add a calendar integration",
        requestedBy: "User (u)",
        taskType: "code_update",
        threadKey: "discord:g:c",
        discordResponseChannelId: "c",
        discordResponseMessageId: "reply-1"
      })
    );
    expect(ctx.updateStatus).toHaveBeenCalledWith("Working on it...\n\nI’ll edit this message with progress and the PR link when it’s ready.");
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "runCodingAgent" }));
  });

  it("creates model-selected code-update jobs through the current agent runtime session when available", async () => {
    const enqueueAgentTask = vi.fn(async (job: { taskId?: string }) => ({
      jobId: "job-1",
      taskId: job.taskId ?? "task-runtime-first"
    }));
    const agentRuntime = {
      appendMessage: vi.fn(async () => undefined),
      createExecution: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined),
      updateExecution: vi.fn(async () => undefined)
    };
    const upsertAgentTaskQueued = vi.fn(async () => undefined);
    const ctx = {
      config: {
        maxReplyChars: 1800,
        github: { repository: "example/discord-ai-agent", token: "test-token" },
        openRouter: { codegenModel: "z-ai/glm-5.2" },
        execution: { codegenBackend: "local-process", codegenHarness: "opencode", taskSigningSecret: "test-secret" }
      },
      repo: {
        upsertAgentTaskQueued,
        auditTool: vi.fn(async () => undefined)
      },
      agentRuntime,
      agentRuntimeSession: {
        sessionId: "agent-session-channel",
        traceId: "prompt-message-1",
        threadKey: "discord:g:c",
        guildId: "g",
        channelId: "c",
        userId: "u",
        title: "Channel session",
        request: "how should we track events?",
        requestedBy: "User",
        status: "running",
        harness: "in-process",
        model: null,
        provider: null,
        harnessThreadId: null,
        metadata: {},
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
        updatedAt: new Date()
      },
      openRouter: {
        chat: vi.fn().mockResolvedValueOnce({
          content: "",
          model: "router-model",
          raw: {},
          toolCalls: [
            {
              id: "call-1",
              name: "runCodingAgent",
              argumentsText: JSON.stringify({ request: "add a calendar integration", title: "Add calendar support" })
            }
          ]
        })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      requestId: "prompt-message-1",
      agentRuntimeExecutionId: "agent-execution-prompt",
      statusChannelId: "c",
      statusMessageId: "reply-1",
      updateStatus: vi.fn(async () => undefined)
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "how should we track events?");
    const taskId = enqueueAgentTask.mock.calls[0]?.[0].taskId;

    expect(taskId).toEqual(expect.stringMatching(/^task-/));
    expect(response.content).toContain(`Task ID: \`${taskId}\``);
    expect(agentRuntime.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-channel",
        role: "tool",
        parts: [expect.objectContaining({ toolName: "runCodingAgent", taskId })]
      })
    );
    expect(agentRuntime.createExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent-session-channel",
        taskId,
        harness: "runCodingAgent"
      })
    );
    expect(upsertAgentTaskQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        taskType: "code_update",
        title: "Add calendar support",
        request: "add a calendar integration",
        parentAgentSessionId: "agent-session-channel",
        parentAgentExecutionId: "agent-execution-prompt",
        parentAgentThreadKey: "discord:g:c"
      })
    );
    expect(upsertAgentTaskQueued.mock.invocationCallOrder[0]).toBeLessThan(
      agentRuntime.createExecution.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        runtimeMirror: "external",
        traceId: "prompt-message-1",
        parentAgentSessionId: "agent-session-channel",
        parentAgentExecutionId: "agent-execution-prompt",
        parentAgentThreadKey: "discord:g:c",
        title: "Add calendar support",
        request: "add a calendar integration",
        discordResponseChannelId: "c",
        discordResponseMessageId: "reply-1"
      })
    );
  });

  it("passes model-selected existing PR targets into code-update jobs", async () => {
    const enqueueAgentTask = vi.fn(async () => ({
      jobId: "job-1",
      taskId: "task-existing-pr"
    }));
    const ctx = {
      config: codeUpdateTestConfig(),
      repo: {
        upsertAgentTaskQueued: vi.fn(async () => undefined),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn().mockResolvedValueOnce({
          content: "",
          model: "router-model",
          raw: {},
          toolCalls: [
            {
              id: "call-1",
              name: "runCodingAgent",
              argumentsText: JSON.stringify({
                request: "Fix the failing CI check on PR #120 and push to the existing branch.",
                title: "Fix CI on PR #120",
                targetBranch: "ai/reuse-existing-pr-branch-follow-up-7ad0",
                targetPullRequestNumber: 120,
                targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
              })
            }
          ]
        })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      ...fakeAgentRuntimeContext(),
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      requestId: "prompt-message-1",
      statusChannelId: "c",
      statusMessageId: "reply-1",
      updateStatus: vi.fn(async () => undefined)
    } as unknown as ToolContext;

    await handleAgentRequest(ctx, "fix CI in that PR");

    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        request: "Fix the failing CI check on PR #120 and push to the existing branch.",
        title: "Fix CI on PR #120",
        targetBranch: "ai/reuse-existing-pr-branch-follow-up-7ad0",
        targetPullRequestNumber: 120,
        targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
      })
    );
  });

  it("continues after linked Discord evidence when a code-update request still needs a PR tool", async () => {
    const enqueueAgentTask = vi.fn(async () => ({
      jobId: "job-1",
      taskId: "task-exclude-channel"
    }));
    const auditTool = vi.fn(async () => undefined);
    const messageContext = vi.fn(async () => [
      agentSearchResult({
        messageId: "333333333333333333",
        channelId: "trivia",
        normalizedContent: "The example-channel channel should not be part of the bot knowledge base.",
        link: "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333"
      })
    ]);
    const ctx = {
      config: codeUpdateTestConfig(),
      repo: {
        getVisibleIndexedChannelIds: vi.fn(async (_guildId: string, channelIds: string[]) => channelIds),
        messageContext,
        upsertAgentTaskQueued: vi.fn(async () => undefined),
        auditTool
      },
      openRouter: {
        chat: vi
          .fn()
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-context",
                name: "getDiscordMessageContext",
                argumentsText: JSON.stringify({
                  messageIdOrUrl: "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333"
                })
              }
            ]
          })
          .mockResolvedValueOnce({
            content: "",
            model: "router-model",
            raw: {},
            toolCalls: [
              {
                id: "call-codegen",
                name: "runCodingAgent",
                argumentsText: JSON.stringify({
                  request:
                    "Fully remove the example-channel channel from current and future Discord knowledge, including storage, indexing, embeddings, retrieval, stats, summaries, and attachment search.",
                  title: "Exclude example-channel from knowledge"
                })
              }
            ]
          })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      ...fakeAgentRuntimeContext(),
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c", "trivia"],
      threadKey: "discord:g:c",
      statusChannelId: "c",
      statusMessageId: "reply-1",
      updateStatus: vi.fn(async () => undefined)
    } as unknown as ToolContext;

    const response = await handleAgentRequest(
      ctx,
      "open pr to fully remove example-channel from your current and future knowledge https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333"
    );

    expect(response.content).toMatch(/Task ID: `task-[^`]+`/);
    expect(messageContext).toHaveBeenCalledWith(expect.objectContaining({ messageId: "333333333333333333" }));
    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Exclude example-channel from knowledge",
        request: expect.stringContaining("Fully remove the example-channel channel"),
        taskType: "code_update"
      })
    );
    expect(ctx.openRouter.chat).toHaveBeenCalledTimes(2);
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "getDiscordMessageContext" }));
    expect(auditTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "runCodingAgent" }));
  });

  it("uses the lazily-created Discord status message when enqueueing codegen jobs", async () => {
    const enqueueAgentTask = vi.fn(async () => ({
      jobId: "job-1",
      taskId: "task-lazy-status"
    }));
    const ctx = {
      config: codeUpdateTestConfig(),
      repo: {
        upsertAgentTaskQueued: vi.fn(async () => undefined),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn().mockResolvedValueOnce({
          content: "",
          model: "router-model",
          raw: {},
          toolCalls: [
            {
              id: "call-1",
              name: "runCodingAgent",
              argumentsText: JSON.stringify({ request: "add better task progress updates", title: "Improve task progress updates" })
            }
          ]
        })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      ...fakeAgentRuntimeContext(),
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      statusChannelId: undefined,
      statusMessageId: undefined,
      updateStatus: vi.fn(async () => {
        ctx.statusChannelId = "c";
        ctx.statusMessageId = "lazy-reply-1";
      })
    } as unknown as ToolContext & { statusChannelId?: string; statusMessageId?: string };

    const response = await handleAgentRequest(ctx, "update yourself to show better task progress");

    expect(response.content).toMatch(/Task ID: `task-[^`]+`/);
    expect(ctx.updateStatus).toHaveBeenCalledWith("Working on it...\n\nI’ll edit this message with progress and the PR link when it’s ready.");
    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Improve task progress updates",
        request: "add better task progress updates",
        discordResponseChannelId: "c",
        discordResponseMessageId: "lazy-reply-1"
      })
    );
  });

  it("preserves prompt trace and Discord scope when warm runtimes enqueue codegen without a status updater", async () => {
    const enqueueAgentTask = vi.fn(async () => ({
      jobId: "job-1",
      taskId: "task-warm-runtime"
    }));
    const ctx = {
      config: codeUpdateTestConfig(),
      repo: {
        upsertAgentTaskQueued: vi.fn(async () => undefined),
        auditTool: vi.fn(async () => undefined)
      },
      openRouter: {
        chat: vi.fn().mockResolvedValueOnce({
          content: "",
          model: "router-model",
          raw: {},
          toolCalls: [
            {
              id: "call-1",
              name: "runCodingAgent",
              argumentsText: JSON.stringify({ request: "make warm runtime task updates reliable", title: "Fix warm task updates" })
            }
          ]
        })
      },
      github: {},
      jobs: {
        enqueueAgentTask
      },
      ...fakeAgentRuntimeContext(),
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      threadKey: "discord:g:c",
      requestId: "prompt-message-1"
    } as unknown as ToolContext;

    const response = await handleAgentRequest(ctx, "update yourself so warm runtime task updates work");

    expect(response.content).toMatch(/Task ID: `task-[^`]+`/);
    expect(enqueueAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "prompt-message-1",
        guildId: "g",
        channelId: "c",
        userId: "u",
        title: "Fix warm task updates",
        request: "make warm runtime task updates reliable",
        discordResponseChannelId: "c",
        discordResponseMessageId: undefined
      })
    );
  });

  it("delivers a valid rich presentation from the single current-turn output collector", async () => {
    const components = [{
      type: "action_row",
      components: [{
        type: "button",
        label: "Short summary",
        style: "primary",
        action: { type: "continue", prompt: "Give me the short summary." },
      }],
    }];
    const chat = vi.fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [{
          id: "compose",
          name: "composeDiscordResponse",
          argumentsText: JSON.stringify({ components: JSON.stringify(components) }),
        }],
      })
      .mockResolvedValueOnce({
        content: "Pick one:",
        model: "router-model",
        raw: {},
        toolCalls: [],
      });
    const ctx = presentationTestContext(chat);

    const response = await handleAgentRequest(ctx, "Give me a Discord button for a short summary");

    expect(response.content).toBe("Pick one:");
    expect(response.discordPresentation).toEqual(expect.objectContaining({
      version: 1,
      audience: "requester",
      components,
    }));
    expect(ctx.turnOutput?.presentation).toBe(response.discordPresentation);
  });

  it("cannot claim rich controls were sent after presentation validation failed", async () => {
    const wireComponents = [{
      type: 1,
      components: [{ type: 2, style: 1, label: "One", custom_id: "one" }],
    }];
    const chat = vi.fn()
      .mockResolvedValueOnce({
        content: "",
        model: "router-model",
        raw: {},
        toolCalls: [{
          id: "compose-invalid",
          name: "composeDiscordResponse",
          argumentsText: JSON.stringify({ components: JSON.stringify(wireComponents) }),
        }],
      })
      .mockResolvedValueOnce({
        content: "Here are the clickable buttons.",
        model: "router-model",
        raw: {},
        toolCalls: [],
      });
    const ctx = presentationTestContext(chat);

    const response = await handleAgentRequest(ctx, "Give me a Discord button example");

    expect(response.discordPresentation).toBeUndefined();
    expect(response.content).toContain("couldn't create the interactive Discord components");
    expect(response.content).not.toContain("clickable buttons");
    const secondRequest = (chat.mock.calls as any[])[1]?.[0];
    expect(secondRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("Canonical valid example"),
      }),
    ]));
    expect(ctx.repo.recordTraceEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "agent.rich_presentation_guard.blocked",
    }));
  });

  it("audits failed agent requests before surfacing the error to Discord", async () => {
    const auditTool = vi.fn(async () => undefined);
    const ctx = {
      config: { maxReplyChars: 1800 },
      repo: { auditTool },
      openRouter: {
        chat: vi.fn(async () => {
          throw new Error("model unavailable");
        })
      },
      github: {},
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"]
    } as unknown as ToolContext;

    await expect(handleAgentRequest(ctx, "tell me a story")).rejects.toThrow("model unavailable");
    expect(auditTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "agentError",
        argumentsSummary: "tell me a story",
        error: "model unavailable"
      })
    );
  });

  it("does not force an empty RNG call for another member's deferred future wager", async () => {
    const chat = vi.fn(async () => ({
      content: "I can’t reserve a cross-user future wager. Use a current bot-run game instead.",
      model: "router-model",
      raw: {},
      toolCalls: [],
    }));
    const ctx = {
      config: {
        maxReplyChars: 1800,
        toolsetScoping: true,
        openRouter: {},
        payments: { walletEnabled: true, userWalletsEnabled: true },
      },
      repo: {
        auditTool: vi.fn(async () => undefined),
        recordTraceEvent: vi.fn(async () => undefined),
      },
      openRouter: { chat },
      guildId: "g",
      channelId: "c",
      userId: "u",
      userDisplayName: "User",
      visibleChannelIds: ["c"],
      sessionMessages: [],
      requestId: "deferred-wager-request",
      requestMessageId: "deferred-wager-request",
    } as unknown as ToolContext;

    const response = await handleAgentRequest(
      ctx,
      "bet $0.25 that another member's three-digit number tomorrow is in range, remember it and settle after they roll",
    );

    expect(response.content).toContain("cross-user future wager");
    expect(chat).toHaveBeenCalledOnce();
    expect((chat.mock.calls as any[])[0]?.[0]?.toolChoice).not.toEqual({
      type: "function",
      function: { name: "drawRandom" },
    });
  });
});

function replyChainWithContent(content: string) {
  const ancestor = {
    messageId: "ancestor",
    channelId: "c",
    guildId: "g",
    authorId: "u",
    authorDisplayName: "User",
    authorIsBot: false,
    content,
    attachmentSummaries: [],
    attachments: [],
    createdAt: null,
    url: null,
  };
  return {
    ...ancestor,
    messageId: "parent",
    rootMessageId: "ancestor",
    content: "please try this media",
    chain: [ancestor],
  };
}

function fakeAgentRuntimeContext() {
  return {
    agentRuntime: {
      appendMessage: vi.fn(async () => undefined),
      createExecution: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined),
      updateExecution: vi.fn(async () => undefined)
    },
    agentRuntimeSession: {
      sessionId: "agent-session-channel",
      traceId: "prompt-message-1",
      threadKey: "discord:g:c",
      guildId: "g",
      channelId: "c",
      userId: "u",
      title: "Channel session",
      request: "test request",
      requestedBy: "User",
      status: "running",
      harness: "in-process",
      model: null,
      provider: null,
      harnessThreadId: null,
      metadata: {},
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date()
    },
    agentRuntimeExecutionId: "agent-execution-prompt",
    requestId: "prompt-message-1"
  };
}

function presentationTestContext(chat: ReturnType<typeof vi.fn>) {
  return {
    config: {
      maxReplyChars: 1800,
      toolsetScoping: true,
      openRouter: {},
      discord: { premiumSkuIds: [] },
      payments: { walletEnabled: false, userWalletsEnabled: false },
    },
    repo: {
      auditTool: vi.fn(async () => undefined),
      recordTraceEvent: vi.fn(async () => undefined),
    },
    openRouter: { chat },
    guildId: "g",
    channelId: "c",
    userId: "u",
    userDisplayName: "User",
    visibleChannelIds: ["c"],
    sessionMessages: [],
    requestId: "presentation-request",
    requestMessageId: "presentation-request",
  } as unknown as ToolContext;
}

function codeUpdateTestConfig() {
  return {
    maxReplyChars: 1800,
    github: { repository: "example/discord-ai-agent", token: "test-token" },
    openRouter: { codegenModel: "z-ai/glm-5.2" },
    execution: { codegenBackend: "local-process", codegenHarness: "opencode", taskSigningSecret: "test-secret" }
  };
}

function channelTopicCandidate(content: string, embedding: number[]) {
  return {
    channelId: "stonks",
    channelName: "stonks",
    messageId: `m-${content}`,
    authorUsername: "alice",
    normalizedContent: content,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    embedding,
    channelMessageCount: 1000
  };
}

function agentSearchResult(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "m1",
    guildId: "g",
    channelId: "c",
    authorId: "alice",
    authorUsername: "alice",
    content: "I have a job interview tomorrow",
    normalizedContent: "I have a job interview tomorrow",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    score: 1,
    link: "https://discord.com/channels/g/c/m1",
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function playlistEntry(index: number, name: string, artists: string, addedAt: string) {
  return {
    added_at: `${addedAt}T00:00:00Z`,
    is_local: false,
    item: {
      id: `track-${index}`,
      name,
      type: "track",
      duration_ms: 180000,
      explicit: false,
      artists: artists.split(",").map((artist) => ({ name: artist.trim() })),
      album: { name: `Album ${index}` },
      external_urls: { spotify: `https://open.spotify.com/track/track-${index}` }
    }
  };
}
