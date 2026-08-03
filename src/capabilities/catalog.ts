import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentPromptContribution, PreparedAgentCapability } from "../agent/capabilityRuntime.js";
import { installedToolContracts } from "./toolContracts.js";
export { installedToolContracts } from "./toolContracts.js";
import { coreToolHandlers } from "../tools/handlers/core.js";
import { discordRetrievalToolHandlers } from "../tools/handlers/discord-retrieval.js";
import { opsToolHandlers } from "../tools/handlers/ops.js";
import { discordActionToolHandlers } from "../tools/handlers/discord-action.js";
import { codegenToolHandlers } from "../tools/handlers/codegen.js";
import { imageToolHandlers } from "../tools/handlers/image.js";
import { generatedDataToolHandlers } from "../tools/handlers/generated-data.js";
import { spotifyToolHandlers } from "../tools/handlers/spotify.js";
import { walletToolHandlers } from "../tools/handlers/wallet.js";
import { externalResearchToolHandlers } from "../tools/handlers/external-research.js";
import {
  TOOL_NAMES_BY_CAPABILITY,
  type ToolName,
  type ToolRegistryEntry,
} from "../tools/toolDefinition.js";
import type { LocalToolHandler } from "../tools/handlers/types.js";
import { prepareAgentModelCapability } from "./agentModel.js";
import { prepareDiscordEmojiCapability } from "./discordEmoji.js";
import { freshDataPromptContribution } from "./freshData.js";
import { imageContextPromptContribution } from "./imageContext.js";
import { prepareRandomGameCapability } from "./randomGames.js";

export type CapabilityId = keyof typeof TOOL_NAMES_BY_CAPABILITY;

export type InstalledCapability = {
  id: CapabilityId;
  summary: string;
  tools: readonly ToolRegistryEntry[];
  handlers: Readonly<Partial<Record<ToolName, LocalToolHandler>>>;
  prepareTurn?: (ctx: ToolContext, userText: string) => Promise<PreparedAgentCapability> | PreparedAgentCapability;
};

type CapabilityDeclaration = Omit<InstalledCapability, "tools" | "handlers"> & {
  toolNames: readonly ToolName[];
};

export function defineCapability(declaration: CapabilityDeclaration): CapabilityDeclaration {
  if (!declaration.summary.trim()) throw new Error(`Capability ${declaration.id} must have a summary.`);
  if (new Set(declaration.toolNames).size !== declaration.toolNames.length) {
    throw new Error(`Capability ${declaration.id} declares duplicate tools.`);
  }
  return Object.freeze({ ...declaration, toolNames: Object.freeze([...declaration.toolNames]) });
}

const declarations: readonly CapabilityDeclaration[] = ([
  {
    id: "foundation",
    summary: "Stable agent instructions and repository skill loading.",
    toolNames: TOOL_NAMES_BY_CAPABILITY.foundation,
    prepareTurn: () => ({ promptContributions: [freshDataPromptContribution()] }),
  },
  {
    id: "discordContext",
    summary: "Permission-scoped Discord retrieval, memory, presentation, and server culture.",
    toolNames: TOOL_NAMES_BY_CAPABILITY.discordContext,
    prepareTurn: async (ctx, userText) => ({
      promptContributions: compactContributions(await prepareDiscordEmojiCapability(ctx, userText)),
    }),
  },
  {
    id: "images",
    summary: "Discord image inspection and provider-backed image generation.",
    toolNames: TOOL_NAMES_BY_CAPABILITY.images,
    prepareTurn: (ctx) => ({
      promptContributions: compactContributions(imageContextPromptContribution(ctx)),
    }),
  },
  {
    id: "generatedData",
    summary: "Deterministic reading and querying of turn-generated files and tables.",
    toolNames: TOOL_NAMES_BY_CAPABILITY.generatedData,
  },
  {
    id: "operations",
    summary: "Runtime diagnostics, deployment status, spend, and model administration.",
    toolNames: TOOL_NAMES_BY_CAPABILITY.operations,
    prepareTurn: async (ctx) => {
      const capability = await prepareAgentModelCapability(ctx);
      return {
        model: capability.model,
        promptContributions: compactContributions(capability.promptContribution),
      };
    },
  },
  {
    id: "codeUpdates",
    summary: "Durable repository diagnosis and isolated code-update tasks.",
    toolNames: TOOL_NAMES_BY_CAPABILITY.codeUpdates,
  },
  {
    id: "discordActions",
    summary: "Requester-authorized reversible Discord and bot-profile mutations.",
    toolNames: TOOL_NAMES_BY_CAPABILITY.discordActions,
  },
  {
    id: "randomGames",
    summary: "Provably fair randomness and exactly-once wager/game lifecycle.",
    toolNames: TOOL_NAMES_BY_CAPABILITY.randomGames,
    prepareTurn: async (ctx, userText) => {
      const game = await prepareRandomGameCapability(ctx, userText);
      return {
        promptContributions: compactContributions(game.promptContribution()),
        observeToolResult: (toolName, result) => game.observeToolResult(toolName, result),
        finalizeResponse: (response) => game.finalizeResponse(response),
        blocksTimeoutRecovery: () => game.blocksTimeoutRecovery(),
      };
    },
  },
  {
    id: "wallets",
    summary: "Live wallet reads, transfers, funding, fees, and reconciliation.",
    toolNames: TOOL_NAMES_BY_CAPABILITY.wallets,
  },
  {
    id: "spotify",
    summary: "Current Spotify catalog and collection inspection.",
    toolNames: TOOL_NAMES_BY_CAPABILITY.spotify,
  },
  {
    id: "externalResearch",
    summary: "Current public-web search, time, and page retrieval through the configured provider.",
    toolNames: TOOL_NAMES_BY_CAPABILITY.externalResearch,
  },
] satisfies readonly CapabilityDeclaration[]).map(defineCapability);

const handlerFamilies = [
  coreToolHandlers,
  discordRetrievalToolHandlers,
  opsToolHandlers,
  discordActionToolHandlers,
  codegenToolHandlers,
  imageToolHandlers,
  generatedDataToolHandlers,
  spotifyToolHandlers,
  walletToolHandlers,
  externalResearchToolHandlers,
] as const;
const handlerEntries = handlerFamilies.flatMap((family) => Object.entries(family));
const handlerNames = handlerEntries.map(([name]) => name);
if (new Set(handlerNames).size !== handlerNames.length) {
  throw new Error("Duplicate local tool handlers are not allowed.");
}
const knownToolNames = new Set<string>(Object.values(TOOL_NAMES_BY_CAPABILITY).flat());
const unknownHandlers = handlerNames.filter((name) => !knownToolNames.has(name));
if (unknownHandlers.length) throw new Error(`Unknown local tool handlers: ${unknownHandlers.join(", ")}.`);
const handlerDefinitions: Readonly<Partial<Record<ToolName, LocalToolHandler>>> = Object.fromEntries(handlerEntries);

const contractByName = new Map(installedToolContracts.map((tool) => [tool.name, tool]));

export const installedCapabilities: readonly InstalledCapability[] = declarations.map((declaration) => {
  const tools = declaration.toolNames.map((name) => requiredContract(name));
  const handlers = Object.fromEntries(
    declaration.toolNames.map((name) => [name, requiredHandler(name)]),
  ) as Partial<Record<ToolName, LocalToolHandler>>;
  return Object.freeze({
    id: declaration.id,
    summary: declaration.summary,
    tools: Object.freeze(tools),
    handlers: Object.freeze(handlers),
    ...(declaration.prepareTurn ? { prepareTurn: declaration.prepareTurn } : {}),
  });
});

export const installedToolHandlers: Readonly<Partial<Record<ToolName, LocalToolHandler>>> = Object.freeze(
  Object.assign({}, ...installedCapabilities.map((capability) => capability.handlers)),
);

function requiredContract(name: ToolName): ToolRegistryEntry {
  const contract = contractByName.get(name);
  if (!contract) throw new Error(`Capability catalog is missing contract ${name}.`);
  return contract;
}

function requiredHandler(name: ToolName): LocalToolHandler {
  const handler = handlerDefinitions[name];
  if (!handler) throw new Error(`Capability catalog is missing handler ${name}.`);
  return handler;
}

function compactContributions(
  contribution: AgentPromptContribution | undefined,
): AgentPromptContribution[] {
  return contribution ? [contribution] : [];
}

export async function prepareInstalledCapabilities(
  ctx: ToolContext,
  userText: string,
): Promise<PreparedAgentCapability[]> {
  return Promise.all(
    installedCapabilities.map((capability) => capability.prepareTurn?.(ctx, userText) ?? {}),
  );
}

export async function finalizeCapabilityResponse(
  prepared: readonly PreparedAgentCapability[],
  initial: AgentResponse,
): Promise<AgentResponse> {
  let response = initial;
  for (const capability of prepared) {
    if (capability.finalizeResponse) response = await capability.finalizeResponse(response);
  }
  return response;
}
