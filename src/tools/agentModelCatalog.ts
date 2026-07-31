import type { AppConfig } from "../config/env.js";
import type { OpenRouterClient } from "../models/openrouter.js";
import { normalizeOpenRouterModelId } from "./agentModelId.js";

export type AgentModelResolution =
  | { ok: true; model: string }
  | {
    ok: false;
    reason: "invalid" | "not_found" | "ambiguous" | "catalog_unavailable";
    candidates?: string[];
  };

const NANOCODEX_MODELS = [
  { id: "openai/gpt-5.6-sol", aliases: ["sol", "gpt 5.6 sol", "gpt-5.6-sol"] },
  { id: "openai/gpt-5.6-luna", aliases: ["luna", "gpt 5.6 luna", "gpt-5.6-luna"] },
] as const;

/** Resolve only models implemented by the embedded NanoCodex runtime. */
export async function resolveAgentModel(
  target: string,
  _input: {
    config: AppConfig;
    openRouter: Pick<OpenRouterClient, "listModels">;
    signal?: AbortSignal;
  },
): Promise<AgentModelResolution> {
  const exact = normalizeOpenRouterModelId(target);
  if (exact) {
    const model = NANOCODEX_MODELS.find((candidate) => candidate.id.toLowerCase() === exact.toLowerCase());
    return model ? { ok: true, model: model.id } : { ok: false, reason: "not_found" };
  }
  const needle = searchable(target);
  if (needle.length < 3) return { ok: false, reason: "invalid" };
  const matches = NANOCODEX_MODELS.filter((candidate) =>
    [candidate.id, ...candidate.aliases].some((alias) => searchable(alias) === needle)
  );
  if (matches.length === 0) return { ok: false, reason: "not_found" };
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", candidates: matches.map((candidate) => candidate.id) };
  }
  return { ok: true, model: matches[0]!.id };
}

function searchable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
