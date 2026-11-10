import { userWalletsAvailable } from "../../capabilities/wallets.js";
import { defineTool, installToolsWhen, type ToolRegistryEntry } from "../toolDefinition.js";

export const walletAdminToolContracts = installToolsWhen(userWalletsAvailable, [
  defineTool({
    name: "getWalletFeeSummary",
    description:
      "Read an authoritative server-wide total of network fees for confirmed managed-wallet transfers. Fetches current Tempo receipts for durable transfer hashes, computes fee-token charges using Tempo's receipt gas values, and states that the AI treasury sponsored member transfers. Use whenever an authorized payment admin asks about historical gas, fee, or transaction costs; never estimate from transfer count.",
    mutates: false,
    group: "external",
    accessPolicy: "strict_ops",
    category: "ops",
    toolClass: "ops",
    outputContract: ["receipt-backed total USD fees", "covered confirmed-transfer count", "unavailable receipt count", "fee sponsorship attribution"],
    examples: ["@ai how much have we spent on gas for all wallet transfers?"],
    permissionRequirements: ["owner_or_ops_allowlist", "configured_wallet_runtime", "confirmed_receipts"],
    auditEvents: ["tool_audit_logs"],
    parameters: { type: "object", properties: {}, additionalProperties: false }
  }),
] satisfies ToolRegistryEntry[]);
