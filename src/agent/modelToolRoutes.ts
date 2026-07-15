import {
  toolByName,
  toolSupportsCsvFormat,
} from "../tools/registry.js";
import { previewText } from "../util/logger.js";
import type { AgentToolRoute } from "./routerShared.js";
import { parseToolArguments } from "./toolArguments.js";
import type { ForcedWalletBalanceOwner } from "./walletStatusGuard.js";

export function selectModelToolRoutes(
  toolCalls: Array<{ id: string; name: string; argumentsText: string }>,
): AgentToolRoute[] {
  const routes: AgentToolRoute[] = [];
  for (const call of toolCalls) {
    const tool = toolByName(call.name);
    if (!tool) continue;
    routes.push({
      id: call.id,
      name: tool.name,
      arguments: parseToolArguments(call.argumentsText),
      argumentsText: call.argumentsText,
    });
  }
  return routes;
}

export function coerceGeneratedCsvProducerRoutes(
  routes: AgentToolRoute[],
): AgentToolRoute[] {
  if (!routes.some((route) => route.name === "queryGeneratedCsv")) return routes;
  return routes.map((route) => {
    if (!toolSupportsCsvFormat(route.name)) return route;
    const existingFormat = typeof route.arguments?.format === "string"
      ? route.arguments.format.trim()
      : "";
    if (existingFormat) return route;
    const args = { ...(route.arguments ?? {}), format: "csv" };
    return { ...route, arguments: args, argumentsText: JSON.stringify(args) };
  });
}

export function bindForcedWalletBalanceOwner(
  routes: AgentToolRoute[],
  owner: ForcedWalletBalanceOwner | null,
): AgentToolRoute[] {
  if (!owner) return routes;
  return routes.map((route) => {
    if (route.name !== "getWalletBalance") return route;
    const args = { owner };
    return { ...route, arguments: args, argumentsText: JSON.stringify(args) };
  });
}

export function traceToolRequestMetadata(call: {
  id: string;
  name: string;
  argumentsText: string;
}) {
  return {
    id: call.id,
    name: call.name,
    argumentsText: previewText(call.argumentsText, 2_000),
  };
}
