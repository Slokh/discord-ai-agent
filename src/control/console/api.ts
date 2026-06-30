import { fixtureArtifact, fixtureRuns, fixtureSnapshots } from "./fixtures.js";
import type { RunSnapshot, RunSummary } from "./types.js";

const useFixtures = import.meta.env.MODE === "fixture";

export async function fetchRuns(input: { includeEmbeddings?: boolean } = {}): Promise<RunSummary[]> {
  if (useFixtures) return input.includeEmbeddings ? fixtureRuns : fixtureRuns.filter((run) => run.kind !== "embedding");
  const params = new URLSearchParams({
    limit: "200",
    includeEmbeddings: input.includeEmbeddings ? "1" : "0"
  });
  const response = await fetch(`/api/runs?${params}`, { credentials: "include" });
  if (!response.ok) throw new Error(`Failed to load runs (${response.status})`);
  const body = (await response.json()) as { runs: RunSummary[] };
  return body.runs;
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
  const events = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`, { withCredentials: true });
  events.addEventListener("snapshot", (event) => {
    onSnapshot(JSON.parse((event as MessageEvent).data) as RunSnapshot);
  });
  events.onerror = () => {
    onError(new Error("Run stream disconnected; polling will continue."));
    events.close();
  };
  return () => events.close();
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
