import { createServer, type Server } from "node:http";
import type { AppConfig } from "../config/env.js";
import { logger } from "../util/logger.js";
import { deriveOperatorActivity, retainOpenImprovementActivity, summarizeOperatorActivity } from "./activity.js";
import { deriveOperatorAttention } from "./attention.js";
import { dashboardClient } from "./client.js";
import { renderDashboardPage } from "./page.js";
import { dashboardReloadClient } from "./reloadClient.js";
import { dashboardStyles } from "./styles.js";

export type DashboardSnapshotSource = {
  snapshot(input: { revision: string }): Promise<Record<string, unknown>>;
  activityDetail(input: { kind: string; id: string; revision: string }): Promise<Record<string, unknown> | null>;
};

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
}): Promise<{ close: () => Promise<void>; server: Server }> {
  const reloadClients = new Set<import("node:http").ServerResponse>();
  let snapshotInFlight: Promise<Record<string, unknown>> | null = null;
  const activityDetailInFlight = new Map<string, Promise<Record<string, unknown> | null>>();
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? "/", "http://console.internal").pathname;
      if (request.method !== "GET") return send(response, 405, "text/plain; charset=utf-8", "Method not allowed");
      if (path === "/healthz") return send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
      if (path === "/api/snapshot") {
        snapshotInFlight ??= projectOperatorSnapshot(input).finally(() => {
          snapshotInFlight = null;
        });
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify(await snapshotInFlight));
      }
      const activityApi = path.match(/^\/api\/activity\/([^/]+)\/([^/]+)$/);
      if (activityApi) {
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
        if (!detail) return send(response, 404, "application/json; charset=utf-8", JSON.stringify({ error: "activity_not_found" }));
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify({
          ...detail,
          schemaVersion: 1,
          environment: input.sourceEnvironment ?? input.config.nodeEnv,
        }));
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
        return send(response, 200, "text/html; charset=utf-8", renderDashboardPage(input.liveReload, path.startsWith("/activity/")));
      }
      return send(response, 404, "text/plain; charset=utf-8", "Not found");
    } catch (error) {
      logger.error({ err: error }, "Operator console request failed");
      return send(response, 500, "application/json; charset=utf-8", JSON.stringify({ error: "snapshot_unavailable" }));
    }
  });
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

async function projectOperatorSnapshot(input: {
  config: AppConfig;
  repository: DashboardSnapshotSource;
  sourceEnvironment?: AppConfig["nodeEnv"];
}) {
  const snapshot = await input.repository.snapshot({ revision: input.config.appRevision });
  const attention = deriveOperatorAttention(snapshot, {
    stalledExecutionMs: input.config.chatTimeouts.hardMs + 60_000,
  });
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
  return {
    ...snapshot,
    summary: { ...summary, needsAttention: attention.length, activeActivity: activity.active.length },
    attention,
    activity,
    schemaVersion: 2,
    environment: input.sourceEnvironment ?? input.config.nodeEnv,
  };
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  contentType: string,
  body: string,
  cacheControl = "no-store",
) {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": contentType, "Cache-Control": cacheControl });
  response.end(body);
}
