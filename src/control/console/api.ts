import { fixtureArtifact, fixtureRuns, fixtureSnapshots } from "./fixtures.js";
import type { RunListAggregate, RunListResponse, RunSnapshot, RunSummary } from "./types.js";

const useFixtures = import.meta.env.MODE === "fixture";

export async function fetchRunList(input: { includeEmbeddings?: boolean } = {}): Promise<RunListResponse> {
  if (useFixtures) {
    const runs = input.includeEmbeddings ? fixtureRuns : fixtureRuns.filter((run) => run.kind !== "embedding");
    return { runs, aggregate: aggregateRuns(runs), generatedAt: new Date().toISOString() };
  }
  const params = new URLSearchParams({
    limit: "200",
    includeEmbeddings: input.includeEmbeddings ? "1" : "0"
  });
  const response = await fetch(`/api/runs?${params}`, { credentials: "include" });
  if (!response.ok) throw new Error(`Failed to load runs (${response.status})`);
  const body = (await response.json()) as Partial<RunListResponse> & { runs: RunSummary[] };
  return {
    runs: body.runs,
    aggregate: body.aggregate ?? aggregateRuns(body.runs),
    generatedAt: body.generatedAt ?? new Date().toISOString()
  };
}

export async function fetchRuns(input: { includeEmbeddings?: boolean } = {}): Promise<RunSummary[]> {
  return (await fetchRunList(input)).runs;
}

export async function fetchRunSnapshot(runId: string): Promise<RunSnapshot> {
  if (useFixtures) {
    const snapshot = fixtureSnapshots.find((item) => item.run.runId === runId);
    if (!snapshot) throw new Error(`Fixture run ${runId} was not found`);
    return snapshot;
  }
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { credentials: "include" });
  if (!response.ok) throw new Error(`Failed to load run (${response.status})`);
  return (await response.json()) as RunSnapshot;
}

export async function fetchArtifact(runId: string, artifactId: string): Promise<string> {
  if (useFixtures) return fixtureArtifact(runId, artifactId);
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`, { credentials: "include" });
  if (!response.ok) throw new Error(`Failed to load artifact (${response.status})`);
  return response.text();
}

export async function resolveRunReference(query: string): Promise<{ run: RunSummary; messageId: string }> {
  if (useFixtures) {
    const messageId = extractDiscordMessageId(query);
    const snapshot = fixtureSnapshots.find((item) => item.run.runId === query.trim() || (messageId != null && item.run.messageId === messageId));
    if (!snapshot) throw new Error("No run matched that Discord message.");
    return { run: snapshot.run, messageId: messageId ?? snapshot.run.messageId ?? query.trim() };
  }
  const params = new URLSearchParams({ query });
  const response = await fetch(`/api/runs/resolve?${params}`, { credentials: "include" });
  if (response.status === 404) throw new Error("No run matched that Discord message.");
  if (!response.ok) throw new Error(`Failed to resolve run (${response.status})`);
  return (await response.json()) as { run: RunSummary; messageId: string };
}

export function subscribeToRun(runId: string, onSnapshot: (snapshot: RunSnapshot) => void, onError: (error: Error) => void) {
  if (useFixtures) return () => undefined;
  let stopped = false;
  let events: EventSource | null = null;
  let reconnectTimer: number | null = null;
  let pollTimer: number | null = null;
  let reconnectAttempts = 0;

  const stopPolling = () => {
    if (pollTimer != null) window.clearInterval(pollTimer);
    pollTimer = null;
  };
  const poll = async () => {
    try {
      onSnapshot(await fetchRunSnapshot(runId));
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const startPolling = () => {
    if (pollTimer != null || stopped) return;
    void poll();
    pollTimer = window.setInterval(() => void poll(), 5_000);
  };
  const connect = () => {
    if (stopped) return;
    events = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`, { withCredentials: true });
    events.addEventListener("open", () => {
      reconnectAttempts = 0;
      stopPolling();
    });
    events.addEventListener("snapshot", (event) => {
      onSnapshot(JSON.parse((event as MessageEvent).data) as RunSnapshot);
    });
    events.onerror = () => {
      events?.close();
      events = null;
      if (stopped) return;
      startPolling();
      reconnectAttempts += 1;
      const retryMs = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempts, 5));
      onError(new Error(`Run stream disconnected; polling every 5s while reconnecting in ${Math.round(retryMs / 1000)}s.`));
      reconnectTimer = window.setTimeout(connect, retryMs);
    };
  };

  connect();
  return () => {
    stopped = true;
    events?.close();
    if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
    stopPolling();
  };
}

function extractDiscordMessageId(input: string): string | null {
  const value = input.trim();
  if (/^\d{15,25}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const channelsIndex = parts.indexOf("channels");
    const messageId = channelsIndex >= 0 ? parts[channelsIndex + 3] : parts.at(-1);
    if (messageId && /^\d{15,25}$/.test(messageId)) return messageId;
  } catch {
    // Fall through to pasted-text scan.
  }
  return value.match(/\d{15,25}/g)?.at(-1) ?? null;
}

function aggregateRuns(runs: RunSummary[]): RunListAggregate {
  return {
    total: runs.length,
    active: runs.filter((run) => !isTerminal(run.status)).length,
    attention: runs.filter((run) => run.status === "failed" || run.status === "cancelled" || run.status === "no_changes").length,
    terminal: runs.filter((run) => isTerminal(run.status)).length,
    byStatus: countBy(runs, (run) => run.status),
    byKind: countBy(runs, (run) => run.kind),
    codegenDiagnoses: countBy(
      runs
        .map((run) => codegenDiagnosisCategory(run.metadata.failureDiagnosis))
        .filter((category): category is string => Boolean(category)),
      (category) => category
    )
  };
}

function countBy<T>(items: T[], keyForItem: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyForItem(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => ({ name, count }));
}

function codegenDiagnosisCategory(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const category = (value as Record<string, unknown>).category;
  return typeof category === "string" && category.trim() ? category.trim() : null;
}

function isTerminal(status: RunSummary["status"]) {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
}
