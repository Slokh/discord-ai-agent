import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDeploymentStability } from "./deploymentHealth.js";

type Runner = (command: string, args: string[]) => string;

export async function rollbackRelease(input: {
  helmRevision: number;
  namespace?: string;
  release?: string;
  stabilitySeconds?: number;
  runner?: Runner;
  verify?: typeof verifyDeploymentStability;
}) {
  const namespace = input.namespace ?? "discord-ai-agent";
  const release = input.release ?? "discord-ai-agent";
  const runner = input.runner ?? run;
  const values = JSON.parse(runner("helm", [
    "get", "values", release,
    "--namespace", namespace,
    "--revision", String(input.helmRevision),
    "--output", "json",
  ])) as Record<string, unknown>;
  const expectedRevision = revisionFromHelmValues(values);
  runner("helm", [
    "rollback", release, String(input.helmRevision),
    "--namespace", namespace,
    "--wait",
    "--wait-for-jobs",
    "--timeout", "10m",
    "--cleanup-on-fail",
    "--force-conflicts",
  ]);
  const health = await (input.verify ?? verifyDeploymentStability)({
    namespace,
    release,
    expectedRevision,
    stabilitySeconds: input.stabilitySeconds ?? 30,
  });
  return { release, namespace, helmRevision: input.helmRevision, expectedRevision, health };
}

export function revisionFromHelmValues(values: Record<string, unknown>) {
  const config = record(values.config);
  const image = record(values.image);
  const revision = stringValue(config.appRevision) || stringValue(image.tag);
  if (!revision) throw new Error("Target Helm revision does not declare config.appRevision or image.tag.");
  return revision;
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
  const helmRevision = Number(values.get("to"));
  if (!Number.isSafeInteger(helmRevision) || helmRevision < 1) throw new Error("--to must be a positive Helm revision number.");
  const stabilitySeconds = Number(values.get("stability-seconds") ?? 30);
  if (!Number.isFinite(stabilitySeconds) || stabilitySeconds < 0) throw new Error("--stability-seconds must be non-negative.");
  return {
    helmRevision,
    namespace: values.get("namespace"),
    release: values.get("release"),
    stabilitySeconds,
  };
}

function run(command: string, args: string[]) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  rollbackRelease(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
