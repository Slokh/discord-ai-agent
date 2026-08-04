import { coreToolContracts } from "../tools/contracts/core.js";
import { presentationToolContracts } from "../tools/contracts/presentation.js";
import { discordResolverHistoryToolContracts } from "../tools/contracts/discord-resolvers-history.js";
import { discordContextFileToolContracts } from "../tools/contracts/discord-context-files.js";
import { discordStatsSummaryToolContracts } from "../tools/contracts/discord-stats-summaries.js";
import { imageToolContracts } from "../tools/contracts/image.js";
import { generatedDataToolContracts } from "../tools/contracts/generated-data.js";
import { skillDiagnosticToolContracts } from "../tools/contracts/skills-diagnostics.js";
import { improvementToolContracts } from "../tools/contracts/improvements.js";
import { runtimeAdminToolContracts } from "../tools/contracts/runtime-admin.js";
import { codegenToolContracts } from "../tools/contracts/codegen.js";
import { discordActionToolContracts } from "../tools/contracts/discord-actions.js";
import { randomWagerActionToolContracts } from "../tools/contracts/random-wager-actions.js";
import { walletUserToolContracts } from "../tools/contracts/wallet-user.js";
import { walletAdminToolContracts } from "../tools/contracts/wallet-admin.js";
import { spotifyCollectionToolContracts } from "../tools/contracts/spotify-collections.js";
import { spotifyCatalogToolContracts } from "../tools/contracts/spotify-catalog.js";
import { externalResearchToolContracts } from "../tools/contracts/external-research.js";
import { TOOL_NAMES, type ToolName, type ToolRegistryEntry } from "../tools/toolDefinition.js";

const definitions = [
  ...coreToolContracts,
  ...presentationToolContracts,
  ...discordResolverHistoryToolContracts,
  ...discordContextFileToolContracts,
  ...discordStatsSummaryToolContracts,
  ...imageToolContracts,
  ...generatedDataToolContracts,
  ...skillDiagnosticToolContracts,
  ...improvementToolContracts,
  ...runtimeAdminToolContracts,
  ...codegenToolContracts,
  ...discordActionToolContracts,
  ...randomWagerActionToolContracts,
  ...walletUserToolContracts,
  ...walletAdminToolContracts,
  ...spotifyCollectionToolContracts,
  ...spotifyCatalogToolContracts,
  ...externalResearchToolContracts,
];

const byName = new Map(definitions.map((tool) => [tool.name, tool]));
if (byName.size !== definitions.length) throw new Error("Duplicate local tool contracts are not allowed.");
const knownNames = new Set<string>(TOOL_NAMES);
const unknownContracts = definitions.map((tool) => tool.name).filter((name) => !knownNames.has(name));
if (unknownContracts.length) throw new Error(`Unknown local tool contracts: ${unknownContracts.join(", ")}.`);

export const installedToolContracts: readonly ToolRegistryEntry[] = Object.freeze(
  TOOL_NAMES.map((name) => requiredContract(name)),
);

function requiredContract(name: ToolName): ToolRegistryEntry {
  const contract = byName.get(name);
  if (!contract) throw new Error(`Missing tool contract ${name}.`);
  return contract;
}
