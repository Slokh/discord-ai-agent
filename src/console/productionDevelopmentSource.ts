import type { DashboardSnapshotSource } from "./server.js";

type KubernetesReader = () => Promise<unknown>;

export function createProductionDevelopmentSource(input: {
  production: DashboardSnapshotSource;
  readKubernetes: KubernetesReader;
}): DashboardSnapshotSource {
  return {
    activityDetail: (detail) => input.production.activityDetail(detail),
    activityPage: (request) => {
      if (!input.production.activityPage) throw new Error("Production Console does not provide activity pages.");
      return input.production.activityPage(request);
    },
    overview: async ({ revision }) => {
      if (!input.production.overview) throw new Error("Production Console does not provide an overview.");
      const overview = await input.production.overview({ revision });
      const summary = record(overview.summary);
      if (summary?.serviceTelemetryAvailable === true) return overview;

      const services = servicesFromKubernetes(await input.readKubernetes());
      if (!services.length) return overview;
      return {
        ...overview,
        services,
        summary: {
          ...summary,
          healthyServices: services.filter((service) => service.status === "healthy").length,
          serviceCount: services.length,
          serviceTelemetryAvailable: true,
          serviceTelemetrySource: "kubernetes",
        },
      };
    },
  };
}

export function servicesFromKubernetes(payload: unknown) {
  const items = record(payload)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((value) => {
    const item = record(value);
    if (!item || (item.kind != null && item.kind !== "Deployment")) return [];
    const metadata = record(item.metadata);
    const labels = record(metadata?.labels);
    const component = text(labels?.["app.kubernetes.io/component"]);
    if (!component) return [];
    const spec = record(item.spec);
    const status = record(item.status);
    const desired = count(spec?.replicas);
    const ready = count(status?.readyReplicas);
    const updated = count(status?.updatedReplicas);
    const available = count(status?.availableReplicas);
    const revision = deploymentRevision(spec);
    const health = desired > 0 && ready >= desired && updated >= desired && available >= desired
      ? "healthy"
      : ready > 0
        ? "degraded"
        : "offline";
    return [{
      component,
      status: health,
      instances: ready,
      desiredInstances: desired,
      revision,
      startedAt: null,
      lastSeenAt: null,
      source: "kubernetes",
    }];
  }).sort((left, right) => componentOrder(left.component) - componentOrder(right.component));
}

function deploymentRevision(spec: Record<string, unknown> | null) {
  const template = record(spec?.template);
  const podSpec = record(record(template?.spec));
  const containers = podSpec?.containers;
  const container = Array.isArray(containers) ? record(containers[0]) : null;
  const environment = container?.env;
  if (Array.isArray(environment)) {
    for (const entry of environment) {
      const variable = record(entry);
      if (variable?.name === "APP_REVISION") return text(variable.value);
    }
  }
  const image = text(container?.image);
  return image?.split(":").at(-1) ?? null;
}

function componentOrder(component: string) {
  const order = ["bot", "worker", "api", "console"].indexOf(component);
  return order === -1 ? Number.MAX_SAFE_INTEGER : order;
}

function record(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function count(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
