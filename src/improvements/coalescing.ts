import { createHash } from "node:crypto";
import type { ImprovementClassification, ImprovementPrivacy } from "../db/types.js";

export function improvementFingerprint(input: {
  guildId?: string | null;
  scope: string;
  privacy: ImprovementPrivacy;
  owningDomain?: string | null;
  classification?: ImprovementClassification | null;
  summary: string;
  stableCode?: string | null;
}) {
  const normalized = [
    input.guildId?.trim() || "global",
    input.scope.trim().toLowerCase(),
    input.privacy,
    normalizeToken(input.owningDomain) || "unknown",
    input.classification ?? "unknown",
    normalizeToken(input.stableCode) || normalizeSummary(input.summary),
  ].join("\0");
  return createHash("sha256").update(normalized).digest("hex");
}

export function normalizeImprovementTitle(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

function normalizeSummary(value: string) {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b\d{8,}\b/g, "<id>")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 24)
    .join(" ");
}

function normalizeToken(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") ?? "";
}
