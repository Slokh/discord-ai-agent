import fs from "node:fs/promises";
import type { DiscordBugReportDisposition } from "../db/types.js";

export type BugReportResult = { disposition: DiscordBugReportDisposition; summary: string };

const DISPOSITIONS = new Set<DiscordBugReportDisposition>([
  "confirmed_fixed", "confirmed_unfixed", "expected_behavior", "not_reproducible", "already_fixed", "insufficient_evidence"
]);

export async function readBugReportResult(path: string): Promise<BugReportResult | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
    const disposition = parsed.disposition as DiscordBugReportDisposition;
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!DISPOSITIONS.has(disposition) || !summary) return null;
    return { disposition, summary: summary.slice(0, 1_000) };
  } catch {
    return null;
  }
}
