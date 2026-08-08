import { describe, expect, it, vi } from "vitest";
import { createProductionDevelopmentSource, servicesFromKubernetes } from "../../src/console/productionDevelopmentSource.js";
import { createProductionSnapshotSource } from "../../src/console/productionSnapshotSource.js";
import {
  parseOperatorConsoleOptions,
  requireProductionConfirmation,
  warmProductionConnection,
} from "../../scripts/operatorConsole.js";
import { localReadOnlyDatabaseUrl } from "../../src/console/productionDatabaseTunnel.js";
import { productionDatabaseTunnelFailure } from "../../src/console/productionDatabaseTunnel.js";
import { consoleDatabaseUrl, requireConsoleDatabaseProvisionConfirmation } from "../../scripts/provisionConsoleDatabase.js";
import { EventEmitter } from "node:events";

describe("production operator console access", () => {
  it("streams versioned production Console resources through loopback", async () => {
    const fetchSnapshot = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("/api/activity/conversation/")
        ? { schemaVersion: 2, environment: "production", kind: "conversation", messages: [{ id: "message-a" }] }
        : url.includes("/api/activity")
          ? { schemaVersion: 3, environment: "production", active: [], recent: [] }
          : { schemaVersion: 3, environment: "production", revision: "revision-a" },
    ), { status: 200 }));
    const source = createProductionSnapshotSource({
      baseUrl: "http://127.0.0.1:18081",
      fetchSnapshot,
    });

    await expect(source.overview?.({ revision: "ignored" })).resolves.toMatchObject({
      environment: "production",
      revision: "revision-a",
    });
    expect(fetchSnapshot).toHaveBeenCalledWith(
      "http://127.0.0.1:18081/api/overview",
      expect.objectContaining({ cache: "no-store" }),
    );
    await expect(source.activityDetail({ kind: "conversation", id: "runtime-execution-a", revision: "ignored" })).resolves.toMatchObject({
      kind: "conversation",
      messages: [{ id: "message-a" }],
    });
    expect(fetchSnapshot).toHaveBeenCalledWith(
      "http://127.0.0.1:18081/api/activity/conversation/runtime-execution-a",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("rejects non-production, incompatible, and non-loopback sources", async () => {
    const localSource = createProductionSnapshotSource({
      baseUrl: "http://localhost:18081",
      fetchSnapshot: async () => new Response(JSON.stringify({ schemaVersion: 3, environment: "development" })),
    });
    await expect(localSource.overview?.({ revision: "ignored" })).rejects.toThrow("non-production");

    const incompatibleSource = createProductionSnapshotSource({
      baseUrl: "http://localhost:18081",
      fetchSnapshot: async () => new Response(JSON.stringify({ schemaVersion: 2, environment: "production" })),
    });
    await expect(incompatibleSource.overview?.({ revision: "ignored" })).rejects.toThrow("invalid overview");
    expect(() => createProductionSnapshotSource({ baseUrl: "https://console.example.com" })).toThrow("loopback");
  });

  it("makes production intent explicit", () => {
    expect(parseOperatorConsoleOptions(["--confirm-production", "--local-ui"])).toEqual({
      confirmed: true,
      localUi: true,
      localApi: false,
    });
    expect(parseOperatorConsoleOptions(["--confirm-production", "--local-api"])).toEqual({
      confirmed: true,
      localUi: false,
      localApi: true,
    });
    expect(() => requireProductionConfirmation({ confirmed: false, localUi: false, localApi: false })).toThrow("--confirm-production");
    expect(() => parseOperatorConsoleOptions(["--local-ui", "--local-api"])).toThrow("either");
    expect(() => parseOperatorConsoleOptions(["--unknown"])).toThrow("Unknown");
  });

  it("forces tunneled production database sessions to be local and read-only", () => {
    const source = "postgres://app:secret@production.internal:5432/app?sslmode=require";
    const local = new URL(localReadOnlyDatabaseUrl(source, 15432));

    expect(local.hostname).toBe("127.0.0.1");
    expect(local.port).toBe("15432");
    expect(local.searchParams.get("sslmode")).toBe("require");
    expect(local.searchParams.get("options")).toContain("default_transaction_read_only=on");
    expect(local.searchParams.get("options")).toContain("statement_timeout=30000");
  });

  it("treats an unexpected relay exit as a failed production database connection", async () => {
    const relay = new EventEmitter();
    const failure = productionDatabaseTunnelFailure([
      { child: relay as never, label: "production database relay" },
    ], () => false);

    relay.emit("exit", 1, null);

    await expect(failure).rejects.toThrow("production database relay disconnected unexpectedly");
  });

  it("provisions a distinct content-free Console credential only with explicit production confirmation", () => {
    expect(() => requireConsoleDatabaseProvisionConfirmation([])).toThrow("--confirm-production");
    expect(() => requireConsoleDatabaseProvisionConfirmation(["--confirm-production"])).not.toThrow();
    const url = new URL(consoleDatabaseUrl("postgres://app:old@production.internal/app", "new-secret"));
    expect(url.username).toBe("discord_ai_agent_console_readonly");
    expect(url.password).toBe("new-secret");
    expect(url.searchParams.get("options")).toContain("default_transaction_read_only=on");
  });

  it("warms the established production connection before opening the local UI", async () => {
    const overview = vi.fn(async () => ({ environment: "production" }));

    await warmProductionConnection({ overview });

    expect(overview).toHaveBeenCalledOnce();
    expect(overview).toHaveBeenCalledWith({ revision: "ignored" });
  });

  it("uses labelled Kubernetes readiness while the deployed heartbeat schema is unavailable", async () => {
    const kubernetes = {
      items: ["api", "bot", "worker"].map((component) => ({
        kind: "Deployment",
        metadata: { labels: { "app.kubernetes.io/component": component } },
        spec: {
          replicas: 1,
          template: { spec: { containers: [{ image: "registry/app:revision-a", env: [{ name: "APP_REVISION", value: "revision-a" }] }] } },
        },
        status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 },
      })),
    };
    const source = createProductionDevelopmentSource({
      production: {
        activityDetail: async () => null,
        overview: async () => ({
          environment: "production",
          services: [],
          summary: { serviceTelemetryAvailable: false, healthyServices: 0, serviceCount: 4 },
        }),
      },
      readKubernetes: async () => kubernetes,
    });

    const snapshot = await source.overview!({ revision: "ignored" });

    expect(snapshot.summary).toMatchObject({
      serviceTelemetryAvailable: true,
      serviceTelemetrySource: "kubernetes",
      healthyServices: 3,
      serviceCount: 3,
    });
    expect(snapshot.services).toEqual([
      expect.objectContaining({ component: "bot", status: "healthy", instances: 1, desiredInstances: 1 }),
      expect.objectContaining({ component: "worker", status: "healthy", instances: 1, desiredInstances: 1 }),
      expect.objectContaining({ component: "api", status: "healthy", instances: 1, desiredInstances: 1 }),
    ]);
  });

  it("keeps application heartbeats authoritative when they are available", async () => {
    const readKubernetes = vi.fn(async () => ({ items: [] }));
    const source = createProductionDevelopmentSource({
      production: {
        activityDetail: async () => null,
        overview: async () => ({
          services: [{ component: "worker", status: "healthy" }],
          summary: { serviceTelemetryAvailable: true, healthyServices: 1, serviceCount: 1 },
        }),
      },
      readKubernetes,
    });

    await expect(source.overview?.({ revision: "ignored" })).resolves.toMatchObject({
      summary: { healthyServices: 1, serviceCount: 1 },
    });
    expect(readKubernetes).not.toHaveBeenCalled();
  });

  it("projects degraded and stopped Kubernetes deployments without inventing health", () => {
    expect(servicesFromKubernetes({
      items: [{
        kind: "Deployment",
        metadata: { labels: { "app.kubernetes.io/component": "worker" } },
        spec: { replicas: 2, template: { spec: { containers: [{ image: "registry/app:revision-b" }] } } },
        status: { readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 },
      }, {
        kind: "Deployment",
        metadata: { labels: { "app.kubernetes.io/component": "api" } },
        spec: { replicas: 1, template: { spec: { containers: [{ image: "registry/app:revision-b" }] } } },
        status: {},
      }],
    })).toEqual([
      expect.objectContaining({ component: "worker", status: "degraded", instances: 1, desiredInstances: 2 }),
      expect.objectContaining({ component: "api", status: "offline", instances: 0, desiredInstances: 1 }),
    ]);
  });
});
