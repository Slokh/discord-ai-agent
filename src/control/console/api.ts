import { fixtureArtifact, fixtureRuns, fixtureSnapshots } from "./fixtures.js";
import type { RunFeedback, RunListAggregate, RunListResponse, RunSnapshot, RunSummary } from "./types.js";

const useFixtures = import.meta.env.MODE === "fixture";

export type PaymentsSnapshot = {
  totals: {
    wallets?: number;
    wallet_errors?: number;
    transfers_pending?: number;
    wagers_open?: number;
  };
  wallets: Array<Record<string, unknown>>;
  transfers: Array<Record<string, unknown>>;
  wagers: Array<Record<string, unknown>>;
  health?: Array<Record<string, unknown>>;
  generatedAt: string;
};

export async function fetchPaymentsSnapshot(): Promise<PaymentsSnapshot> {
  if (useFixtures) {
    return { totals: {}, wallets: [], transfers: [], wagers: [], health: [], generatedAt: new Date().toISOString() };
  }
  const response = await fetch("/api/payments?limit=100", { credentials: "include" });
  if (!response.ok) throw new Error(`Failed to load payments (${response.status})`);
  return (await response.json()) as PaymentsSnapshot;
}

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

export async function fetchRunFeedback(runId: string): Promise<RunFeedback | null> {
  if (useFixtures) return null;
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/feedback`, { credentials: "include" });
  if (!response.ok) throw new Error(`Failed to load feedback (${response.status})`);
  return ((await response.json()) as { feedback: RunFeedback | null }).feedback;
}

export async function saveRunFeedback(input: { runId: string; rating: "good" | "bad"; note: string; expectedBehavior: string; captureEval: boolean }): Promise<RunFeedback> {
  if (useFixtures) return { ...input, note: input.note || null, expectedBehavior: input.expectedBehavior || null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const response = await fetch(`/api/runs/${encodeURIComponent(input.runId)}/feedback`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Failed to save feedback (${response.status})`);
  return ((await response.json()) as { feedback: RunFeedback }).feedback;
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
  let currentSnapshot: RunSnapshot | null = null;

  const stopPolling = () => {
    if (pollTimer != null) window.clearInterval(pollTimer);
    pollTimer = null;
  };
  const poll = async () => {
    try {
      currentSnapshot = await fetchRunSnapshot(runId);
      onSnapshot(currentSnapshot);
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
      currentSnapshot = JSON.parse((event as MessageEvent).data) as RunSnapshot;
      onSnapshot(currentSnapshot);
    });
    events.addEventListener("delta", (event) => {
      const delta = JSON.parse((event as MessageEvent).data) as RunSnapshotDelta;
      if (!currentSnapshot) {
        void poll();
        return;
      }
      currentSnapshot = applyRunSnapshotDelta(currentSnapshot, delta);
      onSnapshot(currentSnapshot);
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

export type RunSnapshotDelta = {
  run: RunSnapshot["run"];
  spans: RunSnapshot["spans"];
  events: RunSnapshot["events"];
  artifacts: RunSnapshot["artifacts"];
  agentTranscript: NonNullable<RunSnapshot["agentTranscript"]>;
  terminal: RunSnapshot["terminal"] | null;
  diagnostics: string[];
  raw: Record<string, unknown>;
  relatedRuns: RunSnapshot["relatedRuns"];
  generatedAt: string;
};

export function applyRunSnapshotDelta(current: RunSnapshot, delta: RunSnapshotDelta): RunSnapshot {
  return {
    ...current,
    run: delta.run,
    spans: appendUnique(current.spans, delta.spans, (item) => item.id),
    events: appendUnique(current.events, delta.events, (item) => item.id),
    artifacts: appendUnique(current.artifacts, delta.artifacts, (item) => item.artifactId),
    agentTranscript: appendUnique(current.agentTranscript ?? [], delta.agentTranscript, (item) => item.id),
    terminal: delta.terminal ?? current.terminal,
    diagnostics: delta.diagnostics,
    raw: delta.raw,
    relatedRuns: delta.relatedRuns,
    generatedAt: delta.generatedAt,
  };
}

function appendUnique<T>(current: T[], added: T[], id: (item: T) => string) {
  const existing = new Set(current.map(id));
  return [...current, ...added.filter((item) => !existing.has(id(item)))];
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
