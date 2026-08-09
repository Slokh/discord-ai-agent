import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { assertConsoleAuthConfig, type AppConfig } from "../config/env.js";
import { logger } from "../util/logger.js";
import { deriveOperatorActivity, retainOpenImprovementActivity, summarizeOperatorActivity, type ActivitySummary } from "./activity.js";
import { createDiscordConsoleAuthenticator, type ConsoleAuthenticator } from "./auth.js";
import { dashboardClient } from "./client.js";
import { renderDashboardPage } from "./page.js";
import { dashboardReloadClient } from "./reloadClient.js";
import { dashboardStyles } from "./styles.js";

export type DashboardSnapshotSource = {
  snapshot?(input: { revision: string }): Promise<Record<string, unknown>>;
  overview?(input: { revision: string }): Promise<Record<string, unknown>>;
  activityPage?(input: ActivityPageRequest & { revision: string }): Promise<Record<string, unknown>>;
  activityDetail(input: { kind: string; id: string; revision: string }): Promise<Record<string, unknown> | null>;
};

export type ActivityPageRequest = { cursor?: string | null; limit?: number; filter?: string; types?: string[]; search?: string | null; selectedKind?: string | null; selectedId?: string | null };

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export async function startOperatorConsole(input: {
  config: AppConfig;
  repository: DashboardSnapshotSource;
  sourceEnvironment?: AppConfig["nodeEnv"];
  liveReload?: boolean;
  authenticator?: ConsoleAuthenticator | null;
  allowLoopbackAuthBypass?: boolean;
}): Promise<{ close: () => Promise<void>; server: Server }> {
  if (input.config.nodeEnv === "production") assertConsoleAuthConfig(input.config);
  const authenticator = input.authenticator === undefined
    ? input.config.nodeEnv === "production" ? createDiscordConsoleAuthenticator(input.config.consoleAuth) : null
    : input.authenticator;
  const reloadClients = new Set<import("node:http").ServerResponse>();
  let projectionInFlight: Promise<ConsoleProjection> | null = null;
  const activityDetailInFlight = new Map<string, Promise<Record<string, unknown> | null>>();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://console.internal");
      const path = url.pathname;
      if (request.method !== "GET") return send(response, 405, "text/plain; charset=utf-8", "Method not allowed");
      if (path === "/healthz") return send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
      const loopbackBypass = input.allowLoopbackAuthBypass !== false && isLoopback(request.socket.remoteAddress);
      if (authenticator && !loopbackBypass) {
        const auth = await authenticator.authorize(request, response, url);
        if (auth === "handled") return;
        if (auth === "unauthorized") {
          if (path.startsWith("/api/")) {
            return send(response, 401, "application/json; charset=utf-8", JSON.stringify({ error: "authentication_required" }));
          }
          const returnTo = path === "/" || path === "/index.html" || /^\/activity\/[^/]+\/[^/]+$/.test(path)
            ? `${path}${url.search}`
            : "/";
          response.writeHead(302, { ...SECURITY_HEADERS, Location: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`, "Content-Length": 0 });
          response.end();
          return;
        }
      }
      if (path === "/api/overview") {
        const startedAt = performance.now();
        const overview = input.repository.overview
          ? await input.repository.overview({ revision: input.config.appRevision })
          : (await loadProjection()).overview;
        return sendJson(request, response, 200, {
          ...overview, schemaVersion: 3, environment: input.sourceEnvironment ?? input.config.nodeEnv,
        }, "overview", startedAt);
      }
      if (path === "/api/activity") {
        const startedAt = performance.now();
        const pageRequest = activityPageRequest(url);
        const page = input.repository.activityPage
          ? await input.repository.activityPage({ ...pageRequest, revision: input.config.appRevision })
          : paginateActivity((await loadProjection()).activity, pageRequest);
        return sendJson(request, response, 200, {
          ...page, schemaVersion: 3, environment: input.sourceEnvironment ?? input.config.nodeEnv,
        }, "activity_index", startedAt);
      }
      const activityApi = path.match(/^\/api\/activity\/([^/]+)\/([^/]+)$/);
      if (activityApi) {
        const startedAt = performance.now();
        const kind = decodeURIComponent(activityApi[1]!);
        const id = decodeURIComponent(activityApi[2]!);
        const detailKey = `${kind}:${id}`;
        let detailRequest = activityDetailInFlight.get(detailKey);
        if (!detailRequest) {
          detailRequest = input.repository.activityDetail({ kind, id, revision: input.config.appRevision }).finally(() => {
            if (activityDetailInFlight.get(detailKey) === detailRequest) activityDetailInFlight.delete(detailKey);
          });
          activityDetailInFlight.set(detailKey, detailRequest);
        }
        const detail = await detailRequest;
        if (!detail) return sendJson(request, response, 404, { error: "activity_not_found" }, "activity_detail", startedAt);
        return sendJson(request, response, 200, {
          ...detail,
          schemaVersion: 2,
          environment: input.sourceEnvironment ?? input.config.nodeEnv,
        }, "activity_detail", startedAt);
      }
      if (path === "/assets/styles.css") return send(response, 200, "text/css; charset=utf-8", dashboardStyles);
      if (path === "/assets/app.js") return send(response, 200, "text/javascript; charset=utf-8", dashboardClient);
      if (input.liveReload && path === "/assets/reload.js") {
        return send(response, 200, "text/javascript; charset=utf-8", dashboardReloadClient);
      }
      if (input.liveReload && path === "/__dev/reload") {
        response.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write("event: ready\ndata: {}\n\n");
        reloadClients.add(response);
        request.once("close", () => reloadClients.delete(response));
        return;
      }
      if (path === "/" || path === "/index.html" || /^\/activity\/[^/]+\/[^/]+$/.test(path)) {
        return send(response, 200, "text/html; charset=utf-8", renderDashboardPage(input.liveReload));
      }
      return send(response, 404, "text/plain; charset=utf-8", "Not found");
    } catch (error) {
      logger.error({ err: error }, "Operator console request failed");
      return send(response, 500, "application/json; charset=utf-8", JSON.stringify({ error: "snapshot_unavailable" }));
    }
  });
  const loadProjection = () => {
    projectionInFlight ??= projectConsoleProjection(input).finally(() => {
      projectionInFlight = null;
    });
    return projectionInFlight;
  };
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.config.consoleServer.port, input.config.consoleServer.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  logger.info({ host: input.config.consoleServer.host, port: input.config.consoleServer.port }, "Operator console is online");
  return {
    server,
    close: () => {
      for (const client of reloadClients) client.end();
      reloadClients.clear();
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function isLoopback(address: string | undefined) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

type ConsoleProjection = {
  overview: Record<string, unknown>;
  activity: { active: ActivitySummary[]; recent: ActivitySummary[] };
};

async function projectConsoleProjection(input: {
  config: AppConfig;
  repository: DashboardSnapshotSource;
  sourceEnvironment?: AppConfig["nodeEnv"];
}) {
  const startedAt = performance.now();
  if (!input.repository.snapshot) throw new Error("Console data source does not provide a local projection.");
  const snapshot = await input.repository.snapshot({ revision: input.config.appRevision });
  const projectedActivity = snapshot.activity && typeof snapshot.activity === "object" && !Array.isArray(snapshot.activity)
    ? snapshot.activity as Record<string, unknown>
    : null;
  const baseActivity = projectedActivity && Array.isArray(projectedActivity.active) && Array.isArray(projectedActivity.recent)
    ? { active: projectedActivity.active, recent: projectedActivity.recent }
    : deriveOperatorActivity(snapshot);
  const detailedActivity = retainOpenImprovementActivity(
    baseActivity as ReturnType<typeof deriveOperatorActivity>,
    snapshot.improvements,
  );
  const activity = summarizeOperatorActivity(detailedActivity as ReturnType<typeof deriveOperatorActivity>);
  const summary = snapshot.summary && typeof snapshot.summary === "object" && !Array.isArray(snapshot.summary)
    ? snapshot.summary as Record<string, unknown>
    : {};
  logger.info({
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    activeRows: activity.active.length,
    recentRows: activity.recent.length,
    serviceRows: Array.isArray(snapshot.services) ? snapshot.services.length : 0,
    producerRows: Array.isArray(snapshot.producers) ? snapshot.producers.length : 0,
  }, "Operator console projection completed");
  return { overview: {
    generatedAt: snapshot.generatedAt,
    revision: snapshot.revision,
    services: snapshot.services,
    producers: snapshot.producers,
    deployments: snapshot.deployments,
    summary: { ...summary, activeActivity: activity.active.length },
  }, activity };
}

function activityPageRequest(url: URL): ActivityPageRequest {
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 60));
  const types = (url.searchParams.get("types") ?? "").split(",").filter(Boolean);
  return {
    cursor: url.searchParams.get("cursor"), limit,
    filter: url.searchParams.get("filter") ?? "all",
    types,
    search: url.searchParams.get("search"),
    selectedKind: url.searchParams.get("selectedKind"),
    selectedId: url.searchParams.get("selectedId"),
  };
}

export function paginateActivity(activity: ConsoleProjection["activity"], input: ActivityPageRequest) {
  const allowedTypes = new Set(input.types?.length ? input.types : ["conversation", "improvement", "code_change"]);
  const search = input.search?.trim().toLowerCase() ?? "";
  const activeKeys = new Set(activity.active.map((story) => `${story.kind}:${story.id}`));
  const all = [...new Map([...activity.active, ...activity.recent].map((story) => [`${story.kind}:${story.id}`, story])).values()]
    .filter((story) => allowedTypes.has(story.kind))
    .filter((story) => !input.selectedId || story.id === input.selectedId && (!input.selectedKind || story.kind === input.selectedKind))
    .filter((story) => !search || [story.title, story.authorLabel, story.summary, story.status, story.branchName]
      .filter(Boolean).join(" ").toLowerCase().includes(search));
  const state = (story: ActivitySummary) => activityState(story, activeKeys.has(`${story.kind}:${story.id}`));
  const matches = (story: ActivitySummary, filter = input.filter) => filter === "all"
    || filter === "issues" && ["blocked", "failed"].includes(state(story))
    || state(story) === filter;
  const filtered = all.filter((story) => matches(story));
  const active = filtered.filter((story) => activeKeys.has(`${story.kind}:${story.id}`));
  const recent = filtered.filter((story) => !activeKeys.has(`${story.kind}:${story.id}`));
  const offset = decodeCursor(input.cursor);
  const limit = input.limit ?? 60;
  const page = recent.slice(offset, offset + limit);
  const counts = Object.fromEntries(["all", "running", "waiting", "issues", "done"].map((filter) => [
    filter, all.filter((story) => matches(story, filter)).length,
  ]));
  return {
    generatedAt: new Date(), active, recent: page, counts, total: filtered.length,
    nextCursor: offset + page.length < recent.length ? encodeCursor(offset + page.length) : null,
  };
}

function activityState(story: ActivitySummary, active: boolean) {
  if (active || story.workState === "active" || ["queued", "running"].includes(story.status)) return "running";
  if (story.workState === "waiting" || story.status === "delivery_pending") return "waiting";
  if (story.workState === "blocked") return "blocked";
  if (story.workState === "terminal") return "done";
  if (story.category === "failure" || story.tone === "danger" || story.tone === "warning") return "failed";
  return "done";
}

function encodeCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Number.isInteger(value.offset) && value.offset >= 0 ? value.offset : 0;
  } catch {
    return 0;
  }
}

function sendJson(
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
  endpoint: string,
  startedAt: number,
) {
  const body = JSON.stringify(value);
  const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
  logger.info({ endpoint, status, durationMs, responseBytes: Buffer.byteLength(body) }, "Operator console request completed");
  return send(response, status, "application/json; charset=utf-8", body, "no-store", request.headers["accept-encoding"]);
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  contentType: string,
  body: string,
  cacheControl = "no-store",
  acceptEncoding: string | undefined = undefined,
) {
  const headers: Record<string, string | number> = { ...SECURITY_HEADERS, "Content-Type": contentType, "Cache-Control": cacheControl, Vary: "Accept-Encoding" };
  let payload: string | Buffer = body;
  if (Buffer.byteLength(body) >= 1_024 && acceptEncoding?.includes("br")) {
    payload = brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } });
    headers["Content-Encoding"] = "br";
  } else if (Buffer.byteLength(body) >= 1_024 && acceptEncoding?.includes("gzip")) {
    payload = gzipSync(body, { level: 6 });
    headers["Content-Encoding"] = "gzip";
  }
  headers["Content-Length"] = Buffer.byteLength(payload);
  response.writeHead(status, headers);
  response.end(payload);
}
