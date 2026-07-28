import type { AppConfig } from "../config/env.js";
import type { OpenRouterClient, OpenRouterModel } from "../models/openrouter.js";
import { normalizeOpenRouterModelId } from "./agentModelId.js";

export type AgentModelResolution =
  | { ok: true; model: string }
  | {
    ok: false;
    reason: "invalid" | "not_found" | "ambiguous" | "catalog_unavailable";
    candidates?: string[];
  };

const CATALOG_CACHE_MS = 5 * 60_000;
const catalogCache = new WeakMap<object, { expiresAt: number; models: OpenRouterModel[] }>();

export async function resolveAgentModel(
  target: string,
  input: {
    config: AppConfig;
    openRouter: Pick<OpenRouterClient, "listModels">;
    signal?: AbortSignal;
  },
): Promise<AgentModelResolution> {
  const configured = configuredModels(input.config);
  const exactTarget = normalizeOpenRouterModelId(target);
  const configuredExact = exactTarget
    ? configured.find((model) => sameModelId(model.id, exactTarget))
    : undefined;
  if (configuredExact) return { ok: true, model: configuredExact.id };

  let catalog: OpenRouterModel[];
  try {
    catalog = await cachedCatalog(input.openRouter, input.signal);
  } catch {
    const configuredMatch = bestAliasMatch(target, configured);
    if (configuredMatch.ok) return configuredMatch;
    return {
      ok: false,
      reason: exactTarget ? "catalog_unavailable" : configuredMatch.reason,
      candidates: configuredMatch.candidates,
    };
  }

  const models = mergeModels(configured, catalog);
  if (exactTarget) {
    const exact = models.find((model) => sameModelId(model.id, exactTarget));
    return exact
      ? { ok: true, model: exact.id }
      : { ok: false, reason: "not_found" };
  }
  return bestAliasMatch(target, models);
}

function configuredModels(config: AppConfig): OpenRouterModel[] {
  const openRouter = config.openRouter;
  if (!openRouter) return [];
  const values = [
    openRouter.chatModel,
    openRouter.chatFallbackModel,
    openRouter.utilityModel,
    openRouter.codegenModel,
    openRouter.embeddingModel,
    openRouter.imageModel,
    openRouter.transcriptionModel,
  ];
  return values
    .map((value) => normalizeOpenRouterModelId(value))
    .filter((value): value is string => Boolean(value))
    .map((id) => ({ id, name: id }));
}

async function cachedCatalog(
  client: Pick<OpenRouterClient, "listModels">,
  signal?: AbortSignal,
): Promise<OpenRouterModel[]> {
  const key = client as object;
  const cached = catalogCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  const models = await client.listModels({ signal });
  catalogCache.set(key, { expiresAt: Date.now() + CATALOG_CACHE_MS, models });
  return models;
}

function bestAliasMatch(
  target: string,
  models: OpenRouterModel[],
): AgentModelResolution {
  const needle = searchable(target);
  if (needle.length < 3) return { ok: false, reason: "invalid" };
  const matches = models
    .map((model) => ({ model, score: aliasScore(needle, model) }))
    .filter((match) => match.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      Number(left.model.id.includes(":")) - Number(right.model.id.includes(":")) ||
      left.model.id.localeCompare(right.model.id));
  if (matches.length === 0) return { ok: false, reason: "not_found" };
  const best = matches[0]!;
  const tied = matches.filter((match) =>
    match.score === best.score &&
    match.model.id.includes(":") === best.model.id.includes(":"));
  if (tied.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      candidates: tied.slice(0, 5).map((match) => match.model.id),
    };
  }
  return { ok: true, model: best.model.id };
}

function aliasScore(needle: string, model: OpenRouterModel): number {
  const id = model.id.toLowerCase();
  const suffix = id.split("/").slice(1).join("/");
  const variants = new Set([
    searchable(id),
    searchable(suffix),
    searchable(model.name),
    searchable(suffix.replace(/^claude[-_.]?/i, "")),
    searchable(model.name.replace(/^[^:]+:\s*/i, "").replace(/^claude\s+/i, "")),
  ]);
  if (variants.has(needle)) return 100;
  if ([...variants].some((variant) => variant.endsWith(needle))) return 80;
  return 0;
}

function searchable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sameModelId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function mergeModels(left: OpenRouterModel[], right: OpenRouterModel[]): OpenRouterModel[] {
  const merged = new Map<string, OpenRouterModel>();
  for (const model of [...left, ...right]) {
    if (!normalizeOpenRouterModelId(model.id)) continue;
    const key = model.id.toLowerCase();
    if (!merged.has(key)) merged.set(key, model);
  }
  return [...merged.values()];
}
