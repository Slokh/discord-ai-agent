import { coreToolContracts } from "./core.js";
import { presentationToolContracts } from "./presentation.js";
import { discordRetrievalPart1ToolContracts } from "./discord-retrieval-1.js";
import { discordRetrievalPart2ToolContracts } from "./discord-retrieval-2.js";
import { discordRetrievalPart3ToolContracts } from "./discord-retrieval-3.js";
import { imageToolContracts } from "./image.js";
import { generatedDataToolContracts } from "./generated-data.js";
import { opsPart1ToolContracts } from "./ops-1.js";
import { opsPart2ToolContracts } from "./ops-2.js";
import { codegenToolContracts } from "./codegen.js";
import { discordActionPart1ToolContracts } from "./discord-action-1.js";
import { discordActionPart2ToolContracts } from "./discord-action-2.js";
import { externalPart1ToolContracts } from "./external-1.js";
import { externalPart2ToolContracts } from "./external-2.js";
import { spotifyPart1ToolContracts } from "./spotify-1.js";
import { spotifyPart2ToolContracts } from "./spotify-2.js";
import { TOOL_NAMES } from "../toolDefinition.js";

const unorderedToolContracts = [
  ...coreToolContracts,
  ...presentationToolContracts,
  ...discordRetrievalPart1ToolContracts,
  ...discordRetrievalPart2ToolContracts,
  ...discordRetrievalPart3ToolContracts,
  ...imageToolContracts,
  ...generatedDataToolContracts,
  ...opsPart1ToolContracts,
  ...opsPart2ToolContracts,
  ...codegenToolContracts,
  ...discordActionPart1ToolContracts,
  ...discordActionPart2ToolContracts,
  ...externalPart1ToolContracts,
  ...externalPart2ToolContracts,
  ...spotifyPart1ToolContracts,
  ...spotifyPart2ToolContracts,
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
