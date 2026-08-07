import type { DashboardSnapshotSource } from "./server.js";
import { Agent, fetch as fetchWithDispatcher } from "undici";

type FetchSnapshot = (input: string, init?: RequestInit) => Promise<Response>;

export function createProductionSnapshotSource(input: {
  baseUrl: string;
  fetchSnapshot?: FetchSnapshot;
}): DashboardSnapshotSource {
  const fetchSnapshot = input.fetchSnapshot ?? loopbackFetch();
  const baseUrl = normalizedBaseUrl(input.baseUrl);
  const snapshotUrl = new URL("/api/snapshot", baseUrl).toString();

  return {
    snapshot: async () => {
      const response = await fetchSnapshot(snapshotUrl, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Production console returned HTTP ${response.status}.`);
      const payload: unknown = await response.json();
      if (!isRecord(payload)) throw new Error("Production console returned an invalid snapshot.");
      if (payload.environment !== "production") {
        throw new Error("Refusing to label a non-production snapshot as production.");
      }
      if (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) {
        throw new Error(`Unsupported production snapshot schema ${String(payload.schemaVersion ?? "missing")}.`);
      }
      return payload;
    },
    activityDetail: async ({ kind, id }) => {
      const url = new URL(`/api/activity/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, baseUrl).toString();
      const response = await fetchSnapshot(url, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Production console returned HTTP ${response.status}.`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || payload.schemaVersion !== 1) {
        throw new Error("Production console returned an invalid activity detail.");
      }
      return payload;
    },
  };
}

function loopbackFetch(): FetchSnapshot {
  const dispatcher = new Agent({
    connections: 1,
    pipelining: 1,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 60_000,
  });
  return (url, init) => fetchWithDispatcher(url, {
    ...init,
    dispatcher,
  } as Parameters<typeof fetchWithDispatcher>[1]) as unknown as Promise<Response>;
}

function normalizedBaseUrl(value: string) {
  const url = new URL(value);
  if (!isLoopback(url.hostname)) throw new Error("Production snapshots must arrive through a loopback tunnel.");
  return url;
}

function isLoopback(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
