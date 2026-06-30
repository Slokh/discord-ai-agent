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
