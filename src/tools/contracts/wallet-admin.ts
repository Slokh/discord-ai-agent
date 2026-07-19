import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const walletAdminToolContracts = [
  defineTool({
    name: "adminTransferWalletFunds",
    description:
      "Perform an explicit payment-admin rebalancing or corrective transfer between any two managed wallets in the current Discord server: bot to user, user to bot, or user to user. Never accepts an external address. Use only when the bot owner or payment ops requester explicitly asks to rebalance, fund, reimburse, revert, or correct wallet state. Both user endpoints must be resolved to Discord IDs first. A reason is mandatory and the requester remains durably attributed.",
    userVisible: true,
    mutates: true,
    group: "external",
    category: "ops",
    toolClass: "ops",
    outputContract: ["admin-attributed source and destination", "confirmed USD amount and transaction hash", "fresh balances", "recorded reason"],
    examples: ["@ai move $5 from the bot wallet to @friend because their payout failed", "@ai return $2 from @friend to the bot as a correction"],
    permissionRequirements: ["owner_or_ops_allowlist", "explicit_user_request", "verified_managed_endpoints", "required_reason"],
    auditEvents: ["tool_audit_logs", "wallet.transfer.reserved", "wallet.transfer.confirmed"],
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["user", "bot"] },
        sourceUserId: { type: "string", description: "Required when source=user." },
        destination: { type: "string", enum: ["user", "bot"] },
        destinationUserId: { type: "string", description: "Required when destination=user." },
        amountUsd: { type: "number", description: "Positive USD amount to transfer." },
        reason: { type: "string", description: "Required concise reason for the administrative transfer." }
      },
      required: ["source", "destination", "amountUsd", "reason"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "reconcileWalletTransfers",
    description:
      "Reconcile pending or uncertain managed-wallet transfers against Tempo and expire stale wager reservations. Use only when an authorized payment admin explicitly asks to reconcile or repair wallet state. Routine reconciliation runs automatically.",
    userVisible: true,
    mutates: true,
    group: "external",
    category: "ops",
    toolClass: "ops",
    outputContract: ["checked, confirmed, and failed transfer counts", "remaining uncertain state"],
    examples: ["@ai reconcile pending wallet transfers"],
    permissionRequirements: ["owner_or_ops_allowlist", "explicit_user_request", "configured_wallet_runtime"],
    auditEvents: ["tool_audit_logs", "wallet.reconciliation.completed"],
    parameters: { type: "object", properties: {}, additionalProperties: false }
  }),
] satisfies ToolRegistryEntry[];
