import type { FunctionToolDefinition, OpenRouterServerToolDefinition, ToolDefinition } from "../models/openrouter.js";
import type { ToolClass, ToolContract, ToolGroup, ToolName, ToolRegistryEntry } from "./toolDefinition.js";
import { localToolContracts } from "./contracts/index.js";
export { TOOL_GROUPS } from "./toolDefinition.js";
export type { ToolClass, ToolContract, ToolGroup, ToolName, ToolRegistryEntry } from "./toolDefinition.js";

export const toolRegistry: ToolRegistryEntry[] = [...localToolContracts];
const toolByNameIndex = new Map(toolRegistry.map((tool) => [tool.name, tool]));
const localDefinitionCache = new WeakMap<ToolRegistryEntry, FunctionToolDefinition>();
const localDefinitionListCache = new WeakMap<ToolRegistryEntry[], FunctionToolDefinition[]>();
const serverDefinitionListCache = new WeakMap<OpenRouterServerToolRegistryEntry[], OpenRouterServerToolDefinition[]>();
const combinedDefinitionCache = new WeakMap<object, WeakMap<object, ToolDefinition[]>>();

export type OpenRouterServerToolRegistryEntry = {
  type: OpenRouterServerToolDefinition["type"];
  description: string;
  toolClass: ToolClass;
  group: ToolGroup;
  outputContract: string[];
  userVisible: boolean;
  parameters?: OpenRouterServerToolDefinition["parameters"];
};

export const openRouterServerToolRegistry: OpenRouterServerToolRegistryEntry[] = [
  {
    type: "openrouter:web_search",
    description: "Search the public web for current or external information.",
    toolClass: "external",
    group: "external",
    outputContract: ["query", "current web result summaries", "source URLs when available"],
    userVisible: true
  },
  {
    type: "openrouter:web_fetch",
    description: "Fetch and read a specific public URL when the user provides one or web search finds one worth opening.",
    toolClass: "external",
    group: "external",
    outputContract: ["requested URL", "relevant fetched page content", "source URL"],
    userVisible: true
  },
  {
    type: "openrouter:datetime",
    description: "Get the current date and time for time-sensitive questions.",
    toolClass: "external",
    group: "external",
    outputContract: ["current date/time", "timezone or locale context when available"],
    userVisible: true
  }
];

export function localToolDefinitionsForModel(tools = toolRegistry): FunctionToolDefinition[] {
  const cachedList = localDefinitionListCache.get(tools);
  if (cachedList) return cachedList;
  const definitions = tools.map((tool) => {
    const cached = localDefinitionCache.get(tool);
    if (cached) return cached;
    const definition: FunctionToolDefinition = {
      type: "function",
      function: { name: tool.name, description: toolDescriptionForModel(tool), parameters: tool.parameters }
    };
    localDefinitionCache.set(tool, definition);
    return definition;
  });
  localDefinitionListCache.set(tools, definitions);
  return definitions;
}

export function openRouterServerToolDefinitionsForModel(tools = openRouterServerToolRegistry): OpenRouterServerToolDefinition[] {
  const cached = serverDefinitionListCache.get(tools);
  if (cached) return cached;
  const definitions = tools.map((tool) => ({
    type: tool.type,
    ...(tool.parameters ? { parameters: tool.parameters } : {})
  }));
  serverDefinitionListCache.set(tools, definitions);
  return definitions;
}

export function toolDefinitionsForModel(options: { localTools?: ToolRegistryEntry[]; serverTools?: OpenRouterServerToolRegistryEntry[] } = {}): ToolDefinition[] {
  const localTools = options.localTools ?? toolRegistry;
  const serverTools = options.serverTools ?? openRouterServerToolRegistry;
  let byServer = combinedDefinitionCache.get(localTools);
  if (!byServer) {
    byServer = new WeakMap();
    combinedDefinitionCache.set(localTools, byServer);
  }
  const cached = byServer.get(serverTools);
  if (cached) return cached;
  const definitions = [...localToolDefinitionsForModel(localTools), ...openRouterServerToolDefinitionsForModel(serverTools)];
  byServer.set(serverTools, definitions);
  return definitions;
}

export function toolByName(name: string): ToolRegistryEntry | undefined {
  return toolByNameIndex.get(name as ToolName);
}

function toolDescriptionForModel(tool: ToolRegistryEntry): string {
  const argumentExample = tool.argumentExamples[0];
  return [
    tool.description,
    `Tool class: ${tool.toolClass}. Returns: ${tool.outputContract.join("; ")}.`,
    argumentExample ? `Example arguments: ${JSON.stringify(argumentExample)}` : "",
  ].filter(Boolean).join("\n");
}

let cachedToolContracts: ToolContract[] | undefined;
export function toolContracts(): ToolContract[] {
  return cachedToolContracts ??= toolRegistry.map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: tool.category,
    toolClass: tool.toolClass,
    mutates: tool.mutates,
    userVisible: tool.userVisible,
    parameters: tool.parameters,
    whenToUse: tool.description,
    outputContract: tool.outputContract,
    permissionRequirements: tool.permissionRequirements,
    auditEvents: tool.auditEvents,
    examples: tool.examples,
    argumentExamples: tool.argumentExamples,
  }));
}

export function renderToolList(options: { localTools?: ToolRegistryEntry[]; serverTools?: OpenRouterServerToolRegistryEntry[] } = {}) {
  const localTools = options.localTools ?? toolRegistry;
  const serverTools = options.serverTools ?? openRouterServerToolRegistry;
  return [
    "Discord AI Agent tools:",
    ...localTools.filter((tool) => tool.userVisible).map((tool) => `- ${tool.name}: ${tool.description}`),
    ...serverTools
      .filter((tool) => tool.userVisible)
      .map((tool) => `- ${tool.type.replace("openrouter:", "")}: ${tool.description}`)
  ].join("\n");
}

export function toolSupportsCsvFormat(name: ToolName): boolean {
  const tool = toolByName(name);
  const properties = tool?.parameters.properties as Record<string, unknown> | undefined;
  const format = properties?.format as { enum?: unknown[] } | undefined;
  return Array.isArray(format?.enum) && format.enum.includes("csv");
}
