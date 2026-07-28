import { durationMs, logger } from "../util/logger.js";

export type OpenRouterModel = {
  id: string;
  name: string;
  canonicalSlug?: string;
};

type OpenRouterCatalogRequest = (
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  options: { method: "GET"; maxAttempts: number; signal?: AbortSignal },
) => Promise<any>;

const OPENROUTER_MODEL_CATALOG_TIMEOUT_MS = 10_000;
const MAX_OPENROUTER_MODELS = 5_000;

export async function fetchOpenRouterModels(
  request: OpenRouterCatalogRequest,
  signal?: AbortSignal,
): Promise<OpenRouterModel[]> {
  const startedAt = Date.now();
  const json = await request(
    "/models",
    {},
    OPENROUTER_MODEL_CATALOG_TIMEOUT_MS,
    { method: "GET", maxAttempts: 2, signal },
  );
  const models = (Array.isArray(json.data) ? json.data : [])
    .slice(0, MAX_OPENROUTER_MODELS)
    .flatMap(modelFromCatalogEntry);
  logger.info(
    {
      provider: "openrouter",
      operation: "list_models",
      modelCount: models.length,
      durationMs: durationMs(startedAt),
    },
    "OpenRouter model catalog response",
  );
  return models;
}

function modelFromCatalogEntry(value: unknown): OpenRouterModel[] {
  if (!value || typeof value !== "object") return [];
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) return [];
  return [{
    id,
    name: typeof entry.name === "string" && entry.name.trim()
      ? entry.name.trim()
      : id,
    canonicalSlug: typeof entry.canonical_slug === "string"
      ? entry.canonical_slug
      : undefined,
  }];
}
