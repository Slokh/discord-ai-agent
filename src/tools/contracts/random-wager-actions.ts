import { userWalletsAvailable } from "../../capabilities/wallets.js";
import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const randomWagerActionToolContracts = [
  defineTool({
    name: "awaitRandomWagerAction",
    examples: ["@ai hit"],
    description:
      "Pause an active wallet-backed game and persist everything needed for the original player to continue it in later Discord replies. Use only when the game has a real unresolved gameplay decision, and again after each non-final action. If the verified draw already produced a terminal win, loss, or push, call settleRandomWager immediately instead; never invent confirm, acknowledge, resolve, or settle as a player action. State must include the full public game state, prior outcomes needed for verification, unused pre-drawn outcomes or RNG cursor information, rules, and any totals needed to continue without guessing. allowedActions must list the exact gameplay choices accepted next. On a later reply, use the state version injected into context as expectedVersion, apply only the requester's selected allowed action, then either persist the next state or settle a final outcome. Never create another wager for the same game.",
    mutates: true,
    group: "discord-action",
    available: userWalletsAvailable,
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
          items: { type: "string", minLength: 1, pattern: "\\S" },
          description: "One to twelve normalized player choices accepted next. Standard blackjack supports only hit and stand so its settlement can be computed deterministically."
        },
        prompt: { type: "string", minLength: 1, pattern: "\\S", description: "Short conversational question asking the player for their next decision." }
      },
      required: ["expectedVersion", "state", "allowedActions", "prompt"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "settleRandomWager",
    examples: ["@ai settle the wager from that draw"],
    description:
      "Settle the active wallet-backed wager in this player's scoped Discord game session exactly once. For standard blackjack and coinflip, pass no arguments: code derives the payout and outcome from durable RNG draws and persisted decisions. For a custom game, provide the payout fields after applying its stated rules. Use awaitRandomWagerAction only while a genuine gameplay decision remains; never invent confirmation as an action or pause a terminal outcome.",
    mutates: true,
    group: "discord-action",
    available: userWalletsAvailable,
    category: "generation",
    toolClass: "generation",
    outputContract: ["validated total payout", "net transfer status", "settlement calculation"],
    permissionRequirements: ["wallet_owner", "reserved_wager", "tool_audit_log"],
    auditEvents: ["wallet.wager.settled", "wallet.transfer.confirmed"],
    parameters: {
      type: "object",
      properties: {
        payoutUsd: { type: "number", description: "Custom games only: total USD payout including returned stake; 0 means a full loss." },
        outcome: {
          type: "string",
          enum: ["player_win", "player_loss", "push"],
          description: "Custom games only: final result from the player's perspective."
        },
        resolutionSource: {
          type: "string",
          enum: ["verified_randomness", "player_decision"],
          description: "Custom games only: verified_randomness for an automatic result, otherwise player_decision."
        },
        explanation: { type: "string", minLength: 1, pattern: "\\S", description: "Custom games only: concise calculation from draw through final outcome." }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "revealRandomness",
    description:
      "Reveal the secret server seed of a provably fair RNG session so anyone can verify that every draw matched the published SHA-256 commitment. Use when a user asks to verify fairness, reveal the seed, check the RNG, or finish a game session. A reply targets that reply chain's session; a standalone request targets the requester's most recently used active session in the channel. Ends the selected session and automatically publishes a fresh commitment for future draws in that reply chain. Report the revealed values exactly; the proof footer repeats them verbatim.",
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
