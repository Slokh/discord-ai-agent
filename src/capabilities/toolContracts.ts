import { coreToolContracts } from "../tools/contracts/core.js";
import { userSettingsToolContracts } from "../tools/contracts/user-settings.js";
import { discordResolverHistoryToolContracts } from "../tools/contracts/discord-resolvers-history.js";
import { discordContextFileToolContracts } from "../tools/contracts/discord-context-files.js";
import { discordStatsSummaryToolContracts } from "../tools/contracts/discord-stats-summaries.js";
import { imageToolContracts } from "../tools/contracts/image.js";
import { generatedDataToolContracts } from "../tools/contracts/generated-data.js";
import { discordActionToolContracts } from "../tools/contracts/discord-actions.js";
import { randomWagerActionToolContracts } from "../tools/contracts/random-wager-actions.js";
import { walletUserToolContracts } from "../tools/contracts/wallet-user.js";
import { walletAdminToolContracts } from "../tools/contracts/wallet-admin.js";
import { externalResearchToolContracts } from "../tools/contracts/external-research.js";
import { MUTATING_TOOL_NAMES, TOOL_NAMES, type ToolName, type ToolRegistryEntry } from "../tools/toolDefinition.js";

const definitions = [
  ...coreToolContracts,
  ...userSettingsToolContracts,
  ...discordResolverHistoryToolContracts,
  ...discordContextFileToolContracts,
  ...discordStatsSummaryToolContracts,
  ...imageToolContracts,
  ...generatedDataToolContracts,
  ...discordActionToolContracts,
  ...randomWagerActionToolContracts,
  ...walletUserToolContracts,
  ...walletAdminToolContracts,
  ...externalResearchToolContracts,
];

const byName = new Map(definitions.map((tool) => [tool.name, tool]));
if (byName.size !== definitions.length) throw new Error("Duplicate local tool contracts are not allowed.");
const knownNames = new Set<string>(TOOL_NAMES);
const unknownContracts = definitions.map((tool) => tool.name).filter((name) => !knownNames.has(name));
if (unknownContracts.length) throw new Error(`Unknown local tool contracts: ${unknownContracts.join(", ")}.`);
const mutatingNames = new Set<ToolName>(MUTATING_TOOL_NAMES);
const mutationDrift = definitions
  .filter((tool) => tool.mutates !== mutatingNames.has(tool.name))
  .map((tool) => tool.name);
if (mutationDrift.length) throw new Error(`Tool mutation taxonomy drift: ${mutationDrift.join(", ")}.`);


export const installedToolContracts: readonly ToolRegistryEntry[] = Object.freeze(
  TOOL_NAMES.map((name) => requiredContract(name)),
);

function requiredContract(name: ToolName): ToolRegistryEntry {
  const contract = byName.get(name);
  if (!contract) throw new Error(`Missing tool contract ${name}.`);
  return contract;
}
