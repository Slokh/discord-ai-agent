import { cleanResponse } from "../../tools/responseFormatting.js";
import type { AgentResponse } from "../../tools/types.js";

export function cleanAgentResponse(response: AgentResponse, maxChars: number): AgentResponse {
  return { ...response, content: cleanResponse(response.content, maxChars) };
}

export function stringArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stringArgumentPreservingEmpty(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  return typeof value === "string" ? value.trim() : undefined;
}

export function stringArrayArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return strings.length > 0 ? strings : undefined;
}

export function enumArgument<const T extends string>(args: Record<string, unknown> | undefined, key: string, values: readonly T[]): T | undefined {
  const value = stringArgument(args, key);
  return value && values.includes(value as T) ? (value as T) : undefined;
}

export function numberArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function booleanArgument(args: Record<string, unknown> | undefined, key: string) {
  const value = args?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value)) return true;
    if (/^(false|no|0)$/i.test(value)) return false;
  }
  return undefined;
}

export function recordArgument(args: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = args?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
