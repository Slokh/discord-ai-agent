import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const discordActionToolContracts = [
  defineTool({
    name: "undoConversationTurns",
    category: "discord",
    toolClass: "memory",
    examples: ["@ai undo that"],
    description:
      "Undo the agent's most recent reply turns in the current Discord channel by removing them from persistent memory and, when possible, deleting the bot reply messages. Use when the user asks to undo, forget, delete, or remove the agent's previous response.",
    mutates: true,
    group: "discord-action",
    parameters: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of recent agent turns to undo. Defaults to 1 and is capped by the tool."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "addDiscordReaction",
    examples: ["@ai add 👍 to https://discord.com/channels/11111/22222/33333"],
    description:
      "Add the bot's reaction to one existing Discord message the current requester can view. Omit messageIdOrUrl to react naturally to the current request, including one culturally fitting learned custom emote. Supply a full Discord message URL or current-channel message ID only when the current request asks to react to another message; resolve a described target with retrieval tools first. Accepts one Unicode emoji or an exact custom-emoji mention available in the current server.",
    mutates: true,
    group: "discord-action",
    category: "discord",
    toolClass: "ops",
    outputContract: ["emoji added", "target Discord message link", "whether Discord accepted the reaction", "failure reason for hidden messages, invalid emoji, missing permissions, or rate limits"],
    permissionRequirements: ["explicit_user_request_or_current_request_social_response", "requester_visible_discord_channels", "tool_audit_log"],
    parameters: {
      type: "object",
      properties: {
        messageIdOrUrl: {
          type: "string",
          description: "Omit for the current request message. Otherwise, use an exact Discord message ID in the current channel or a full visible Discord message URL."
        },
        emoji: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
          description: "Exactly one Unicode emoji (including a joined or skin-tone sequence) or one exact current-server custom emoji mention such as <:party:123>."
        }
      },
      required: ["emoji"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "createDiscordPoll",
    examples: ["@ai make a poll: what day should we play, Friday or Saturday?"],
    description:
      "Create a native Discord poll in the current channel using Discord's poll message API (v10). Use this when the user asks to schedule, vote, pick a time, choose between options, run a straw poll, or create any poll-like question with multiple answers. Discord native polls render in the channel and let members click an answer. The bot must have Send Messages permission in the channel. Supports up to 10 answer options; duration defaults to 24 hours and is capped at 168 hours per Discord limits; allow_multiselect defaults to true since scheduling polls usually allow multiple answers.",
    mutates: true,
    group: "discord-action",
    category: "discord",
    toolClass: "ops",
    outputContract: ["poll question", "answer options posted", "duration hours", "allow multiselect", "Discord message link", "failure reason when the bot lacks permission or input is invalid"],
    permissionRequirements: ["explicit_user_request", "tool_audit_log"],
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
          description: "The poll question text shown above the answer options. Discord caps poll question text at 300 characters."
        },
        answers: {
          type: "array",
          items: { type: "string", minLength: 1, pattern: "\\S" },
          description: "Poll answer options. Provide between 1 and 10 options. Each answer is capped at 55 characters by Discord. Order is preserved."
        },
        durationHours: {
          type: "number",
          description: "How long the poll stays open, in hours. Defaults to 24 and is capped at 168 (7 days) per Discord limits."
        },
        allowMultiselect: {
          type: "boolean",
          description: "Whether members can select multiple answers. Defaults to true for scheduling use cases; set false for single-choice polls."
        }
      },
      required: ["question", "answers"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "createDiscordEmoji",
    examples: ["@ai upload this image as a server emoji named nacho_wizard", "@ai make this an emote named nacho_wizard"],
    description:
      "Create a custom emoji (also called an emote) in the current Discord server from an image URL or a context image (generated image, uploaded attachment, or reply-chain image). Use when the user explicitly asks to upload, add, create, or turn something into a server/custom emoji or emote. The image is normalized to a 128x128 WebP with transparent padding under Discord's 256 KiB limit; existing source backgrounds are never falsely treated as transparency. Generated sources require verified alpha by default and fail before upload when they are opaque. Short animations are preserved when they fit and otherwise flatten safely. The bot must have Create Expressions permission, and the requester must be the bot owner or ops-allowlisted.",
    mutates: true,
    group: "discord-action",
    accessPolicy: "ops",
    category: "discord",
    toolClass: "ops",
    outputContract: ["created emoji name and mention", "source image label", "normalized dimensions and size", "animation preservation status", "failure reason for invalid images, missing permission, rate limits, or full emoji slots"],
    permissionRequirements: ["explicit_user_request", "ops_allowlist", "tool_audit_log"],
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
          description: "Name for the custom emoji. It will be normalized to 2-32 lowercase letters, numbers, or underscores. Do not include surrounding colons."
        },
        imageUrl: {
          type: "string",
          description: "Optional direct http(s) or data: image URL. If omitted, the tool uses the latest generated image, then an image from the current request or reply chain."
        },
        messageIdOrUrl: {
          type: "string",
          description: "Optional Discord message ID or URL whose permission-visible image attachment should be used."
        },
        useContextImage: {
          type: "boolean",
          description: "Whether to fall back to images in the current request or reply chain. Defaults to true."
        },
        requireTransparent: {
          type: "boolean",
          description: "Require real alpha transparency and refuse an opaque source before upload. Defaults to true for generated images and false for other sources."
        }
      },
      required: ["name"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "updateBotAvatar",
    examples: ["@ai change your avatar to this image: https://example.com/avatar.png"],
    description:
      "Update the bot's own Discord profile avatar using an image URL or a context image (generated image, uploaded attachment, or reply-chain image). Uses the Discord Modify Current User API (PATCH /users/@me with a base64 data-URI avatar). Requires the bot token from environment config. Use this when the user asks to change, set, or update the bot's avatar/profile picture. Discord accepts PNG, JPEG, WebP, or GIF avatars; large or unsupported images are rejected before the API call. Handle rate limits, permission errors, and invalid image URLs gracefully.",
    mutates: true,
    group: "discord-action",
    accessPolicy: "ops",
    category: "discord",
    toolClass: "ops",
    outputContract: ["image source label", "Discord avatar update status", "new avatar URL when available", "failure reason when the image is invalid, rate-limited, or unauthorized"],
    parameters: {
      type: "object",
      properties: {
        imageUrl: {
          type: "string",
          description: "Optional direct image URL to use as the new avatar. Accepts http(s) URLs or data: image URIs. If omitted, the tool falls back to a generated image, then the current request attachment, then reply-chain/message attachments."
        },
        messageIdOrUrl: {
          type: "string",
          description: "Optional Discord message ID or message URL whose visible image attachments should be used as the avatar source."
        },
        useContextImage: {
          type: "boolean",
          description: "Whether to fall back to images attached to the current request or replied-to chain when imageUrl is omitted. Defaults to true."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "drawRandom",
    description:
      "Draw provably fair random outcomes using a commit-reveal RNG. ALWAYS use this tool instead of inventing results whenever a request involves chance or randomness. Outcomes are computed in code from committed entropy and the requesting Discord message id. Translate the request into the typed draw schema; application code does not classify the prompt. A wallet-backed game reserves its wager only when the typed wager object is present. Opening standard blackjack uses exactly 3 cards and later hit/stand draws set wagerAction. Standard-game payouts, requester ownership, structured fairness, balances, exposure, and settlement remain deterministic. Never use transferWalletFunds for a wager. A proof footer is appended automatically; report drawn results exactly.",
    mutates: true,
    group: "discord-action",
    category: "generation",
    toolClass: "generation",
    outputContract: [
      "drawn outcome values computed in code (never model-invented)",
      "session id, nonce, and commitment for verification",
      "automatic proof footer on the Discord reply",
      "failure reason when parameters are invalid"
    ],
    examples: [
      "@ai deal me a blackjack hand",
      "@ai roll 2d6",
      "@ai flip a coin",
      "@ai pick someone from alice, bob, carol"
    ],
    permissionRequirements: ["tool_audit_log"],
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["integers", "dice", "coin", "pick", "shuffle", "cards"],
          description:
            "What to draw: integers (uniform in [min, max]), dice (count dice with sides), coin (heads/tails), pick (choose count winners from options), shuffle (reorder options), cards (deal count cards from the conversation's shoe without replacement)."
        },
        count: {
          type: "number",
          description: "How many values to draw: integers, dice, coins, picks, or cards. Defaults to 1. Max 100."
        },
        min: { type: "number", description: "Smallest integer, inclusive. Required for kind integers." },
        max: { type: "number", description: "Largest integer, inclusive. Required for kind integers." },
        sides: { type: "number", description: "Number of die faces for kind dice. Defaults to 6." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Candidate items for kind pick or shuffle. Between 2 and 100 non-empty strings."
        },
        deckCount: {
          type: "number",
          description: "Number of 52-card decks in the shoe for kind cards (1-8). Changing it mid-session reshuffles a new shoe. Defaults to the current shoe or 1."
        },
        reason: {
          type: "string",
          description: "Short label for what this draw decides (e.g. 'player hand', 'dealer upcard', 'raffle winner'). Shown in the proof footer and stored for verification."
        },
        wagerAction: {
          type: "string",
          enum: ["hit", "stand"],
          description: "Typed standard-blackjack continuation action. Supply only when continuing an active blackjack wager; code persists this token with the verified card draw."
        },
        wager: {
          type: "object",
          description:
            "Optional wallet-backed wager for the CURRENT REQUESTER only. Decide authorization from the current request, never another member or stale context. Supply interactionMode; if maxPayoutUsd exceeds stakeUsd, also supply a structured rule. Code validates fairness and all wallet invariants before funds or entropy move.",
          properties: {
            playerUserId: { type: "string", minLength: 1, pattern: "\\S", description: "Discord user ID of the current requester whose wallet is at risk. Must exactly match Current Discord requester; third-party wagers are rejected." },
            stakeUsd: { type: "number", description: "Positive USD-denominated stake taken from the user's game wallet." },
            maxPayoutUsd: { type: "number", description: "Maximum possible total payout in USD, including returned stake." },
            game: { type: "string", minLength: 1, pattern: "\\S", description: "Short generic game identifier, such as slots, roulette, dice, or blackjack." },
            interactionMode: { type: "string", enum: ["automatic", "player_decisions"], description: "Choose automatic when no player decision remains after the draw; choose player_decisions only for a genuine persisted next move." },
            rule: {
              type: "object",
              description: "Optional machine-checkable player win rule for deterministic fairness validation.",
              properties: {
                kind: { type: "string", enum: ["coin_side", "sum", "any_match", "all_distinct"] },
                side: { type: "string", enum: ["heads", "tails"] },
                operator: { type: "string", enum: [">=", ">", "<=", "<", "="] },
                target: { type: "number" },
              },
              required: ["kind"],
              additionalProperties: false,
            }
          },
          required: ["playerUserId", "stakeUsd", "maxPayoutUsd", "game", "interactionMode"],
          additionalProperties: false
        }
      },
      required: ["kind"],
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
