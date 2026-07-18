import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const externalPart1ToolContracts = [
  defineTool({
    name: "getWalletBalance",
    description:
      "Read a current USD wallet balance. Use owner=requester for 'my/mine' and unqualified balance requests; use owner=bot for 'your/yours', the bot, or the bot treasury. Use owner=user with a resolved userId for another member; owner/ops can always do this, and every member can when WALLET_BALANCES_PUBLIC=true. Another member without a wallet is reported as $0 without creating one. ALWAYS call this instead of answering from memory whenever the user asks about a wallet, balance, bankroll, casino funds, or available money. Existing wallet balances are verified live onchain against USDC.e and presented simply as $ or USD.",
    userVisible: true,
    mutates: false,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["verified current USD balance", "public managed-wallet address", "Tempo network", "onchain verification timestamp"],
    examples: ["@ai balance", "@ai what's my bankroll?", "@ai what's your balance?"],
    permissionRequirements: ["configured_wallet_runtime", "requester_scope", "public_balance_directory_or_owner_ops_for_other_users"],
    auditEvents: ["tool_audit_logs", "wallet.provision.*"],
    parameters: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          enum: ["requester", "bot", "user"],
          description: "Whose wallet to read. Defaults to the requester when user wallets are enabled, otherwise the bot. Use bot for your/the bot's balance. user requires userId and public balance visibility or payment-admin permission."
        },
        userId: {
          type: "string",
          description: "Discord user ID or mention when owner=user. Resolve names with findDiscordUsers first."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "listWalletBalances",
    description:
      "List the managed wallet directory for this Discord server. ALWAYS use this for plural or server-wide balance or address requests. Use view=balances for 'every user's balance', view=addresses for wallet-address questions, and view=both only when both were explicitly requested. Balance views include the shared AI treasury plus only member wallets with a verified non-$0 balance; $0, unavailable, and missing member wallets are summarized but omitted. Address-only views include the AI and every existing member wallet without repeating balances or creating wallets. This directory is available to owner/ops, or to every member when WALLET_BALANCES_PUBLIC=true.",
    userVisible: true,
    mutates: false,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["requested balances, addresses, or both", "shared AI treasury", "only verified non-$0 rows for balance views", "only existing wallets for address-only views", "compact Markdown table"],
    examples: ["@ai what's the balance of every user in this server?", "@ai can I get their wallet addresses?"],
    permissionRequirements: ["configured_user_wallet_runtime", "live_discord_member_roster", "public_balance_directory_or_owner_ops"],
    auditEvents: ["tool_audit_logs", "wallet.directory.read"],
    parameters: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["balances", "addresses", "both"],
          description: "Directory fields to return. Use addresses for address-only questions to avoid repeating balances; use both only when explicitly requested. Defaults to balances."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "getWagerHistory",
    description:
      "Read the current requester's canonical real-USD wager ledger, including verified RNG draws, settlement outcomes, stakes, payouts, net results, explanations, and originating Discord request links. ALWAYS use this instead of Discord history or agent memory when the user asks about their past bets, wagers, casino games, wins/losses, payouts, or coin-flip/dice/card results. Optionally filter by a short game term such as coin, blackjack, dice, or roulette. This is requester-scoped and read-only; never infer settled results from chat messages when this tool is available.",
    userVisible: true,
    mutates: false,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["requester-scoped canonical wager entries", "verified RNG draw", "settlement outcome", "stake, payout, and net USD", "originating Discord request link"],
    examples: ["@ai what were the results of my coin flips?", "@ai show my recent blackjack wins and losses"],
    permissionRequirements: ["configured_user_wallet_runtime", "requester_scope"],
    auditEvents: ["tool_audit_logs", "wallet.wager_history.read"],
    parameters: {
      type: "object",
      properties: {
        game: { type: "string", description: "Optional short game-name filter such as coin, blackjack, dice, or roulette." },
        limit: { type: "number", description: "Maximum recent entries. Defaults to 20 and is capped at 50." },
      },
      additionalProperties: false,
    },
  }),

  defineTool({
    name: "transferWalletFunds",
    description:
      "Transfer real USD out of the current Discord requester's managed wallet. The only allowed destinations are another verified Discord user's managed wallet or the shared bot wallet; arbitrary blockchain addresses are never accepted. Use only when the current prompt explicitly asks to send, pay, tip, give, deposit, return, or transfer money; never use this to charge or settle a game wager. The source, amount or explicit entire-balance request, and destination are parsed again from the current requester prompt and remain authoritative even if model arguments differ. A destination can be an ID, mention, username, or display name: pass the provided name directly and the tool will resolve it safely, so do not ask the user for an ID or mention. Ambiguous names fail without transferring. The bot wallet sponsors the network fee. Returns the confirmed transaction and fresh source/destination balances.",
    userVisible: true,
    mutates: true,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["confirmed USD amount and managed endpoints", "transaction hash and status", "fresh source and destination balances"],
    examples: ["@ai send $2 to @friend", "@ai transfer $1 back to the bot", "@ai send my balance to the bot"],
    permissionRequirements: ["explicit_user_request", "requester_scope", "verified_managed_destination", "sufficient_onchain_balance"],
    auditEvents: ["tool_audit_logs", "wallet.transfer.reserved", "wallet.transfer.confirmed"],
    parameters: {
      type: "object",
      properties: {
        destination: { type: "string", enum: ["user", "bot"], description: "Managed destination type." },
        destinationUserId: { type: "string", description: "Required for destination=user. Discord ID, mention, username, or display name; plain names are resolved safely by the tool." },
        amountUsd: { type: "number", description: "Positive USD amount to transfer." }
      },
      required: ["destination", "amountUsd"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "requestStarterFunds",
    description:
      "Fallback recheck for the current Discord requester's automatic starter funding. Before model/tool selection, the request lifecycle normally tops any verified live balance below the configured starter amount up to that target, so users do not need special wording and tiny dust balances cannot block play. Use this tool only to retry an explicit starter/refill request when automatic funding did not complete. Balances already at or above the target are ineligible; requester and destination are immutable, concurrent requests are guarded, arbitrary amounts are not accepted, and the result includes fresh user/AI balances plus a confirmed transaction.",
    userVisible: true,
    mutates: true,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["eligibility from verified requester balance", "fixed starter amount", "confirmed transaction", "fresh requester and AI balances"],
    examples: ["@ai I'm at $0, can I get $1 to play again?"],
    permissionRequirements: ["explicit_user_request", "requester_scope", "verified_below_starter_balance", "configured_wallet_runtime"],
    auditEvents: ["tool_audit_logs", "wallet.transfer.reserved", "wallet.transfer.confirmed"],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
