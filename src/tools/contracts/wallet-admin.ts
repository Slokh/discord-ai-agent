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
    name: "adminSetWalletStarterAmount",
    description:
      "Change this Discord server's durable starter-wallet target. When the same current prompt explicitly asks to sweep, reset, or rebalance every existing member wallet, also move each verified live balance to the new target using receipt-verified managed transfers; excess returns to the AI treasury and shortfalls are funded by it. Use only for an explicit owner/payment-ops request. The current prompt's stated amount and bulk-rebalance intent are parsed again in code and remain authoritative.",
    userVisible: true,
    mutates: true,
    group: "external",
    category: "ops",
    toolClass: "ops",
    outputContract: ["durable server starter amount", "existing wallet adjustment counts", "confirmed aggregate directions", "recorded reason"],
    examples: ["@ai set starter funds to $0.10 and move every existing user balance back to that amount"],
    permissionRequirements: ["owner_or_ops_allowlist", "explicit_current_request", "live_managed_balances", "required_reason"],
    auditEvents: ["tool_audit_logs", "wallet.starter_target.updated", "wallet.transfer.confirmed"],
    parameters: {
      type: "object",
      properties: {
        amountUsd: { type: "number", description: "New starter target stated in the current prompt." },
        rebalanceExisting: { type: "boolean", description: "True only when the current prompt explicitly requests all existing wallets be adjusted." },
        reason: { type: "string", description: "Required concise reason for the administrative change." }
      },
      required: ["amountUsd", "rebalanceExisting", "reason"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "getWalletFeeSummary",
    description:
      "Read an authoritative server-wide total of network fees for confirmed managed-wallet transfers. Fetches current Tempo receipts for durable transfer hashes, computes fee-token charges using Tempo's receipt gas values, and states that the AI treasury sponsored member transfers. Use whenever an authorized payment admin asks about historical gas, fee, or transaction costs; never estimate from transfer count.",
    userVisible: true,
    mutates: false,
    group: "external",
    category: "ops",
    toolClass: "ops",
    outputContract: ["receipt-backed total USD fees", "covered confirmed-transfer count", "unavailable receipt count", "fee sponsorship attribution"],
    examples: ["@ai how much have we spent on gas for all wallet transfers?"],
    permissionRequirements: ["owner_or_ops_allowlist", "configured_wallet_runtime", "confirmed_receipts"],
    auditEvents: ["tool_audit_logs"],
    parameters: { type: "object", properties: {}, additionalProperties: false }
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
