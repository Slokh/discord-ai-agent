import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const randomWagerActionToolContracts = [
  defineTool({
    name: "awaitRandomWagerAction",
    examples: ["@ai hit"],
    description:
      "Pause an active wallet-backed game and persist everything needed for the original player to continue it in later Discord replies. Use only when the game has a real unresolved gameplay decision, and again after each non-final action. If the verified draw already produced a terminal win, loss, or push, call settleRandomWager immediately instead; never invent confirm, acknowledge, resolve, or settle as a player action. State must include the full public game state, prior outcomes needed for verification, unused pre-drawn outcomes or RNG cursor information, rules, and any totals needed to continue without guessing. allowedActions must list the exact gameplay choices accepted next. On a later reply, use the state version injected into context as expectedVersion, apply only the requester's selected allowed action, then either persist the next state or settle a final outcome. Never create another wager for the same game.",
    userVisible: false,
    mutates: true,
    group: "discord-action",
    category: "generation",
    toolClass: "generation",
    outputContract: ["new state version", "allowed player actions", "decision prompt", "reservation expiry behavior"],
    permissionRequirements: ["wallet_owner", "reserved_wager", "tool_audit_log"],
    auditEvents: ["wallet.wager.awaiting_action"],
    parameters: {
      type: "object",
      properties: {
        expectedVersion: { type: "number", description: "Current non-negative state version. Use 0 immediately after the initial draw." },
        state: {
          type: "object",
          description: "Complete bounded JSON game state required to continue deterministically on the next reply.",
          additionalProperties: true
        },
        allowedActions: {
          type: "array",
          items: { type: "string" },
          description: "One to twelve normalized player choices accepted next, such as hit, stand, hold, roll, or fold."
        },
        prompt: { type: "string", description: "Short conversational question asking the player for their next decision." }
      },
      required: ["expectedVersion", "state", "allowedActions", "prompt"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "settleRandomWager",
    examples: ["@ai settle the wager from that draw"],
    description:
      "Settle the active wallet-backed wager created by drawRandom in this player's scoped Discord game session. The runtime resolves the canonical wager automatically; never supply or repeat an internal wager id. Call this exactly once after applying the game's stated payout rules to exact provably fair results and all persisted player decisions. A nominally interactive game must settle immediately with resolutionSource=verified_randomness when its opening draw is already terminal, such as a natural blackjack; it spans replies through awaitRandomWagerAction only when a genuine gameplay decision remains. Never ask the player to confirm a completed outcome, and never use break-even merely because a decision is pending. payoutUsd is the total returned to the player, including returned stake: use 0 for a full loss and the original stake for an actual final break-even. outcome must agree with whether payoutUsd is above, below, or equal to the stake. Use resolutionSource=verified_randomness for an outcome completely determined by the draw and player_decision only when a persisted decision was resolved by a later reply. The service validates these facts before creating a transfer.",
    userVisible: false,
    mutates: true,
    group: "discord-action",
    category: "generation",
    toolClass: "generation",
    outputContract: ["validated total payout", "net transfer status", "settlement calculation"],
    permissionRequirements: ["wallet_owner", "reserved_wager", "tool_audit_log"],
    auditEvents: ["wallet.wager.settled", "wallet.transfer.confirmed"],
    parameters: {
      type: "object",
      properties: {
        payoutUsd: { type: "number", description: "Total USD payout including returned stake; 0 means the player loses the full stake." },
        outcome: {
          type: "string",
          enum: ["player_win", "player_loss", "push"],
          description: "Final result from the player's perspective. It must agree with payoutUsd relative to the reserved stake."
        },
        resolutionSource: {
          type: "string",
          enum: ["verified_randomness", "player_decision"],
          description: "Use verified_randomness for an automatic result; use player_decision only after a persisted interactive game receives a later player reply."
        },
        explanation: { type: "string", description: "Concise deterministic calculation from the draw result through the final outcome. It must not describe a pending decision or unfinished game." }
      },
      required: ["payoutUsd", "outcome", "resolutionSource", "explanation"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "revealRandomness",
    description:
      "Reveal the secret server seed of a provably fair RNG session so anyone can verify that every draw matched the published SHA-256 commitment. Use when a user asks to verify fairness, reveal the seed, check the RNG, or finish a game session. A reply targets that reply chain's session; a standalone request targets the requester's most recently used active session in the channel. Ends the selected session and automatically publishes a fresh commitment for future draws in that reply chain. Report the revealed values exactly; the proof footer repeats them verbatim.",
    userVisible: true,
    mutates: true,
    group: "discord-action",
    category: "generation",
    toolClass: "generation",
    outputContract: [
      "revealed server seed and its verified commitment",
      "client seed and per-draw outcomes",
      "verifier instructions",
      "next session commitment"
    ],
    examples: ["@ai reveal randomness", "@ai prove the blackjack deals were fair"],
    permissionRequirements: ["tool_audit_log"],
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
