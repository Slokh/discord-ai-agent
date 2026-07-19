import { coreToolContracts } from "./core.js";
import { presentationToolContracts } from "./presentation.js";
import { discordResolverHistoryToolContracts } from "./discord-resolvers-history.js";
import { discordContextFileToolContracts } from "./discord-context-files.js";
import { discordStatsSummaryToolContracts } from "./discord-stats-summaries.js";
import { imageToolContracts } from "./image.js";
import { generatedDataToolContracts } from "./generated-data.js";
import { skillDiagnosticToolContracts } from "./skills-diagnostics.js";
import { runtimeAdminToolContracts } from "./runtime-admin.js";
import { codegenToolContracts } from "./codegen.js";
import { discordActionToolContracts } from "./discord-actions.js";
import { randomWagerActionToolContracts } from "./random-wager-actions.js";
import { walletUserToolContracts } from "./wallet-user.js";
import { walletAdminToolContracts } from "./wallet-admin.js";
import { spotifyCollectionToolContracts } from "./spotify-collections.js";
import { spotifyCatalogToolContracts } from "./spotify-catalog.js";
import { TOOL_NAMES } from "../toolDefinition.js";

const unorderedToolContracts = [
  ...coreToolContracts,
  ...presentationToolContracts,
  ...discordResolverHistoryToolContracts,
  ...discordContextFileToolContracts,
  ...discordStatsSummaryToolContracts,
  ...imageToolContracts,
  ...generatedDataToolContracts,
  ...skillDiagnosticToolContracts,
  ...runtimeAdminToolContracts,
  ...codegenToolContracts,
  ...discordActionToolContracts,
  ...randomWagerActionToolContracts,
  ...walletUserToolContracts,
  ...walletAdminToolContracts,
  ...spotifyCollectionToolContracts,
  ...spotifyCatalogToolContracts,
];

const contractByName = new Map(unorderedToolContracts.map((contract) => [contract.name, contract]));
if (contractByName.size !== unorderedToolContracts.length) throw new Error("Duplicate local tool contracts are not allowed.");
const unknownContracts = [...contractByName.keys()].filter((name) => !TOOL_NAMES.includes(name));
if (unknownContracts.length) throw new Error(`Unknown local tool contracts: ${unknownContracts.join(", ")}.`);

export const localToolContracts = TOOL_NAMES.map((name) => {
  const contract = contractByName.get(name);
  if (!contract) throw new Error(`Missing tool contract ${name}.`);
  return contract;
});
