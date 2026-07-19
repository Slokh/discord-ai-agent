import type { AppConfig } from "../config/env.js";
import type { ToolRegistryEntry } from "./registry.js";

const deploymentToolCache = new Map<string, ToolRegistryEntry>();

/** Narrow a canonical tool contract to capabilities available in this deployment. */
export function toolForDeployment(tool: ToolRegistryEntry, config: AppConfig): ToolRegistryEntry {
  const key = `${tool.name}|wallet:${Boolean(config.payments?.userWalletsEnabled)}|premium:${(config.discord?.premiumSkuIds ?? []).join(",")}`;
  const cached = deploymentToolCache.get(key);
  if (cached) return cached;
  const scoped = scopeToolForDeployment(tool, config);
  deploymentToolCache.set(key, scoped);
  return scoped;
}

function scopeToolForDeployment(tool: ToolRegistryEntry, config: AppConfig): ToolRegistryEntry {
  if (tool.name === "composeDiscordResponse") {
    const premiumSkuIds = config.discord?.premiumSkuIds ?? [];
    return {
      ...tool,
      description: `${tool.description} Premium button SKUs available in this deployment: ${premiumSkuIds.length ? premiumSkuIds.join(", ") : "none"}.`,
      parameters: scopePremiumButtonSchema(tool.parameters, premiumSkuIds) as ToolRegistryEntry["parameters"],
    };
  }
  if (tool.name !== "drawRandom" || config.payments?.userWalletsEnabled) return tool;
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return tool;
  const withoutWager = { ...properties } as Record<string, unknown>;
  delete withoutWager.wager;
  return { ...tool, parameters: { ...tool.parameters, properties: withoutWager } };
}

function scopePremiumButtonSchema(value: unknown, skuIds: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => scopePremiumButtonSchema(item, skuIds)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const properties = object.properties as Record<string, unknown> | undefined;
  const style = properties?.style as { enum?: unknown[] } | undefined;
  if (style?.enum?.length === 1 && style.enum[0] === "premium") {
    if (!skuIds.length) return undefined;
    return {
      ...object,
      properties: {
        ...properties,
        skuId: { type: "string", enum: skuIds, description: "A premium SKU configured for this Discord application." },
      },
    };
  }
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, scopePremiumButtonSchema(child, skuIds)]));
}
