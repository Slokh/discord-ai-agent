import { describe, expect, it, vi } from "vitest";
import { createProductionDevelopmentSource, servicesFromKubernetes } from "../../src/console/productionDevelopmentSource.js";
import { createProductionSnapshotSource } from "../../src/console/productionSnapshotSource.js";
import {
  parseOperatorConsoleOptions,
  requireProductionConfirmation,
  warmProductionConnection,
} from "../../scripts/operatorConsole.js";

describe("production operator console access", () => {
  it("streams a versioned production snapshot through loopback", async () => {
    const fetchSnapshot = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("/api/activity/")
        ? { schemaVersion: 1, kind: "conversation", story: { id: "runtime-execution-a" }, messages: [{ id: "message-a" }] }
        : { schemaVersion: 2, environment: "production", revision: "revision-a" },
    ), { status: 200 }));
    const source = createProductionSnapshotSource({
      baseUrl: "http://127.0.0.1:18081",
      fetchSnapshot,
    });

    await expect(source.snapshot({ revision: "ignored" })).resolves.toMatchObject({
      environment: "production",
      revision: "revision-a",
    });
    expect(fetchSnapshot).toHaveBeenCalledWith(
      "http://127.0.0.1:18081/api/snapshot",
      expect.objectContaining({ cache: "no-store" }),
    );
    await expect(source.activityDetail({ kind: "conversation", id: "runtime-execution-a", revision: "ignored" })).resolves.toMatchObject({
      kind: "conversation",
      story: { id: "runtime-execution-a" },
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
      fetchSnapshot: async () => new Response(JSON.stringify({ schemaVersion: 1, environment: "development" })),
    });
    await expect(localSource.snapshot({ revision: "ignored" })).rejects.toThrow("non-production");

    const incompatibleSource = createProductionSnapshotSource({
      baseUrl: "http://localhost:18081",
      fetchSnapshot: async () => new Response(JSON.stringify({ schemaVersion: 3, environment: "production" })),
    });
    await expect(incompatibleSource.snapshot({ revision: "ignored" })).rejects.toThrow("Unsupported");
    expect(() => createProductionSnapshotSource({ baseUrl: "https://console.example.com" })).toThrow("loopback");
  });

  it("makes production intent explicit", () => {
    expect(parseOperatorConsoleOptions(["--confirm-production", "--local-ui"])).toEqual({
      confirmed: true,
      localUi: true,
    });
    expect(() => requireProductionConfirmation({ confirmed: false, localUi: false })).toThrow("--confirm-production");
    expect(() => parseOperatorConsoleOptions(["--unknown"])).toThrow("Unknown");
  });

  it("warms the established production connection before opening the local UI", async () => {
    const snapshot = vi.fn(async () => ({ environment: "production" }));

    await warmProductionConnection({ snapshot });

    expect(snapshot).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledWith({ revision: "ignored" });
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
        snapshot: async () => ({
          environment: "production",
          services: [],
          summary: { serviceTelemetryAvailable: false, healthyServices: 0, serviceCount: 4 },
        }),
      },
      readKubernetes: async () => kubernetes,
    });

    const snapshot = await source.snapshot({ revision: "ignored" });

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
        snapshot: async () => ({
          services: [{ component: "worker", status: "healthy" }],
          summary: { serviceTelemetryAvailable: true, healthyServices: 1, serviceCount: 1 },
        }),
      },
      readKubernetes,
    });

    await expect(source.snapshot({ revision: "ignored" })).resolves.toMatchObject({
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
