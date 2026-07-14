import type { RunKind } from "./types.js";
import type { StatusFilter } from "./runInbox.js";

export type DetailTab = "overview" | "timeline" | "models" | "compare" | "terminal" | "artifacts" | "raw";
export type HistoryMode = "push" | "replace";
export type ConsoleUrlState = {
  runId: string;
  tab: DetailTab;
  filter: StatusFilter;
  kind: RunKind | "all";
  query: string;
  includeEmbeddings: boolean;
};

export const statusFilters = ["all", "active", "attention", "queued", "running", "failed", "no_changes", "cancelled", "succeeded", "done"] as const;
export const runKinds = ["all", "codegen", "discord", "crawl", "embedding", "prompt", "workflow", "ops"] as const;
const detailTabIds: DetailTab[] = ["overview", "timeline", "models", "compare", "terminal", "artifacts", "raw"];
const managedSearchParams = new Set(["tab", "status", "filter", "kind", "q", "embeddings", "includeEmbeddings"]);

export function readConsoleUrlState(): ConsoleUrlState {
  const search = new URLSearchParams(window.location.search);
  const kind = parseKind(search.get("kind"));
  return normalizeConsoleUrlState({
    runId: runIdFromLocation(),
    tab: parseTab(search.get("tab")),
    filter: parseStatusFilter(search.get("status") ?? search.get("filter")),
    kind,
    query: search.get("q") ?? "",
    includeEmbeddings: search.get("embeddings") === "1" || search.get("includeEmbeddings") === "1" || kind === "embedding",
  });
}

export function normalizeConsoleUrlState(state: ConsoleUrlState): ConsoleUrlState {
  const includeEmbeddings = state.includeEmbeddings || state.kind === "embedding";
  return { ...state, includeEmbeddings, kind: !includeEmbeddings && state.kind === "embedding" ? "all" : state.kind };
}

export function writeConsoleUrlState(state: ConsoleUrlState, mode: HistoryMode) {
  const params = new URLSearchParams(window.location.search);
  for (const key of managedSearchParams) params.delete(key);
  if (state.tab !== "overview") params.set("tab", state.tab);
  if (state.filter !== "all") params.set("status", state.filter);
  if (state.kind !== "all") params.set("kind", state.kind);
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.includeEmbeddings) params.set("embeddings", "1");
  const path = state.runId ? `${runsRoutePrefix()}/${encodeURIComponent(state.runId)}` : runsRoutePrefix();
  const nextUrl = `${path}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === nextUrl) return;
  if (mode === "replace") window.history.replaceState(null, "", nextUrl);
  else window.history.pushState(null, "", nextUrl);
}

export function runHref(runId: string, tab: DetailTab = "overview") {
  const params = new URLSearchParams(window.location.search);
  for (const key of managedSearchParams) params.delete(key);
  if (tab !== "overview") params.set("tab", tab);
  return `${runsRoutePrefix()}/${encodeURIComponent(runId)}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
}

export function parseTab(value: string | null): DetailTab {
  if (value === "calls" || value === "debugger") return "models";
  return detailTabIds.includes(value as DetailTab) ? value as DetailTab : "overview";
}

function runIdFromLocation() {
  const match = window.location.pathname.match(/^\/(?:console\/)?runs\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]!) : "";
}

function runsRoutePrefix() { return window.location.pathname.startsWith("/console/") ? "/console/runs" : "/runs"; }
function parseStatusFilter(value: string | null): StatusFilter { return statusFilters.includes(value as StatusFilter) ? value as StatusFilter : "all"; }
function parseKind(value: string | null): RunKind | "all" { return runKinds.includes(value as RunKind | "all") ? value as RunKind | "all" : "all"; }
