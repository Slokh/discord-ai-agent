import type { ActivityPageRequest, DashboardSnapshotSource } from "./server.js";
import { Agent, fetch as fetchWithDispatcher } from "undici";

type FetchSnapshot = (input: string, init?: RequestInit) => Promise<Response>;

export function createProductionSnapshotSource(input: {
  baseUrl: string;
  fetchSnapshot?: FetchSnapshot;
}): DashboardSnapshotSource {
  const fetchSnapshot = input.fetchSnapshot ?? loopbackFetch();
  const baseUrl = normalizedBaseUrl(input.baseUrl);
  return {
    overview: async () => read("/api/overview", 3, "overview"),
    activityPage: async (input) => {
      const url = new URL("/api/activity", baseUrl);
      applyActivityQuery(url, input);
      return read(url.toString(), 3, "activity index");
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
      if (!isRecord(payload) || payload.schemaVersion !== 2) {
        throw new Error("Production console returned an invalid activity detail.");
      }
      if (payload.environment !== "production") {
        throw new Error("Refusing to label non-production Console data as production.");
      }
      return payload;
    },
  };

  async function read(pathOrUrl: string, schemaVersion: number, label: string) {
      const url = pathOrUrl.startsWith("http") ? pathOrUrl : new URL(pathOrUrl, baseUrl).toString();
      const response = await fetchSnapshot(url, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Production console returned HTTP ${response.status}.`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || payload.schemaVersion !== schemaVersion) {
        throw new Error(`Production console returned an invalid ${label}.`);
      }
      if (payload.environment !== "production") throw new Error("Refusing to label non-production Console data as production.");
      return payload;
  }
}

function applyActivityQuery(url: URL, input: ActivityPageRequest) {
  if (input.cursor) url.searchParams.set("cursor", input.cursor);
  if (input.limit) url.searchParams.set("limit", String(input.limit));
  if (input.filter) url.searchParams.set("filter", input.filter);
  if (input.types?.length) url.searchParams.set("types", input.types.join(","));
  if (input.search) url.searchParams.set("search", input.search);
  if (input.selectedKind) url.searchParams.set("selectedKind", input.selectedKind);
  if (input.selectedId) url.searchParams.set("selectedId", input.selectedId);
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
