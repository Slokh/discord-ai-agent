import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_COMPONENTS = ["api", "bot", "worker", "console"] as const;

type Component = typeof REQUIRED_COMPONENTS[number];
type KubernetesList = { items?: unknown[] };

export type DeploymentHealth = {
  healthy: boolean;
  revision: string;
  components: Array<{
    component: Component;
    desired: number;
    ready: number;
    updated: number;
    available: number;
    restarts: number;
  }>;
  issues: string[];
};

export function evaluateDeploymentHealth(
  payload: KubernetesList,
  input: { release: string; expectedRevision: string },
): DeploymentHealth {
  const items = Array.isArray(payload.items) ? payload.items.filter(isRecord) : [];
  const deployments = items.filter((item) => item.kind === "Deployment");
  const pods = items.filter((item) => item.kind === "Pod" && !record(item.metadata).deletionTimestamp);
  const issues: string[] = [];
  const components = REQUIRED_COMPONENTS.map((component) => {
    const expectedName = `${input.release}-${component}`;
    const deployment = deployments.find((item) => record(item.metadata).name === expectedName);
    if (!deployment) {
      issues.push(`Missing deployment ${expectedName}.`);
      return { component, desired: 0, ready: 0, updated: 0, available: 0, restarts: 0 };
    }
    const metadata = record(deployment.metadata);
    const spec = record(deployment.spec);
    const status = record(deployment.status);
    const template = record(spec.template);
    const podSpec = record(template.spec);
    const container = records(podSpec.containers).find((value) => value.name === component) ?? records(podSpec.containers)[0];
    const env = records(container?.env);
    const revision = stringValue(env.find((entry) => entry.name === "APP_REVISION")?.value);
    const image = stringValue(container?.image);
    const desired = numberValue(spec.replicas);
    const ready = numberValue(status.readyReplicas);
    const updated = numberValue(status.updatedReplicas);
    const available = numberValue(status.availableReplicas);
    const unavailable = numberValue(status.unavailableReplicas);
    const generation = numberValue(metadata.generation);
    const observedGeneration = numberValue(status.observedGeneration);
    if (desired < 1) issues.push(`${expectedName} has no desired replicas.`);
    if (ready !== desired || updated !== desired || available !== desired || unavailable !== 0) {
      issues.push(`${expectedName} is not fully ready (desired=${desired}, updated=${updated}, ready=${ready}, available=${available}, unavailable=${unavailable}).`);
    }
    if (observedGeneration < generation) issues.push(`${expectedName} has not observed generation ${generation}.`);
    if (revision !== input.expectedRevision) issues.push(`${expectedName} reports revision ${revision || "missing"}.`);
    if (imageTag(image) !== input.expectedRevision) issues.push(`${expectedName} image does not match ${input.expectedRevision}.`);

    const currentPods = pods.filter((pod) => {
      const labels = record(record(pod.metadata).labels);
      const podContainers = records(record(pod.spec).containers);
      const podContainer = podContainers.find((value) => value.name === component) ?? podContainers[0];
      return labels["app.kubernetes.io/component"] === component && imageTag(stringValue(podContainer?.image)) === input.expectedRevision;
    });
    if (currentPods.length !== desired) issues.push(`${expectedName} has ${currentPods.length} current pod(s), expected ${desired}.`);
    let restarts = 0;
    for (const pod of currentPods) {
      const statuses = records(record(pod.status).containerStatuses);
      const containerStatus = statuses.find((value) => value.name === component) ?? statuses[0];
      restarts += numberValue(containerStatus?.restartCount);
      if (containerStatus?.ready !== true) issues.push(`${stringValue(record(pod.metadata).name) || expectedName} is not ready.`);
    }
    if (restarts > 0) issues.push(`${expectedName} current pods restarted ${restarts} time(s).`);
    return { component, desired, ready, updated, available, restarts };
  });
  return { healthy: issues.length === 0, revision: input.expectedRevision, components, issues };
}

export async function verifyDeploymentStability(input: {
  namespace: string;
  release: string;
  expectedRevision: string;
  stabilitySeconds: number;
  intervalMs?: number;
  readSnapshot?: () => KubernetesList;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const readSnapshot = input.readSnapshot ?? (() => kubernetesSnapshot(input.namespace, input.release));
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const intervalMs = Math.max(250, Math.trunc(input.intervalMs ?? 5_000));
  const checks = Math.max(1, Math.ceil(Math.max(0, input.stabilitySeconds) * 1_000 / intervalMs) + 1);
  let health: DeploymentHealth | null = null;
  for (let check = 0; check < checks; check += 1) {
    health = evaluateDeploymentHealth(readSnapshot(), { release: input.release, expectedRevision: input.expectedRevision });
    if (!health.healthy) throw new Error(health.issues.join("\n"));
    if (check + 1 < checks) await sleep(intervalMs);
  }
  return health!;
}

function kubernetesSnapshot(namespace: string, release: string): KubernetesList {
  const stdout = execFileSync("kubectl", [
    "--namespace", namespace,
    "get", "deployments,pods",
    "-l", `app.kubernetes.io/instance=${release}`,
    "-o", "json",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(stdout) as KubernetesList;
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[++index];
    if (!name || !value) throw new Error(`Missing value for --${name || arg}`);
    values.set(name, value);
  }
  const expectedRevision = values.get("revision");
  if (!expectedRevision) throw new Error("--revision is required.");
  return {
    namespace: values.get("namespace") ?? "discord-ai-agent",
    release: values.get("release") ?? "discord-ai-agent",
    expectedRevision,
    stabilitySeconds: numberArgument(values.get("stability-seconds") ?? "30", "stability-seconds"),
  };
}

function numberArgument(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative number.`);
  return parsed;
}

function imageTag(image: string) {
  const digestless = image.split("@", 1)[0] ?? "";
  const lastSegment = digestless.slice(digestless.lastIndexOf("/") + 1);
  const colon = lastSegment.lastIndexOf(":");
  return colon >= 0 ? lastSegment.slice(colon + 1) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  verifyDeploymentStability(parseArgs(process.argv.slice(2)))
    .then((health) => process.stdout.write(`${JSON.stringify(health)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
