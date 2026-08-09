import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDeploymentStability } from "./deploymentHealth.js";
import { rollbackRelease } from "./rollbackRelease.js";

export type PostDeployStage = "deployment_health" | "capability_canary" | "console_health" | "private_regressions" | "stability" | "promotion";
export type PostDeployVerificationResult = {
  status: "passed" | "rolled_back" | "verification_failed" | "rollback_failed";
  expectedRevision: string;
  failedStage: PostDeployStage | null;
  attempts: Partial<Record<PostDeployStage, number>>;
  rollbackRevision: number | null;
  rollbackExpectedRevision: string | null;
  error: string | null;
};

export async function verifyReleaseWithRecovery(input: {
  expectedRevision: string;
  previousHelmRevision?: number | null;
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  verifyHealth: (stabilitySeconds: number) => Promise<void>;
  verifyCapabilities: () => Promise<void>;
  verifyConsole: () => Promise<void>;
  verifyPrivateRegressions: () => Promise<void>;
  promote: () => Promise<void>;
  rollback: (helmRevision: number) => Promise<{ expectedRevision: string }>;
  recordFailureDetection?: (input: { failedStage: PostDeployStage }) => Promise<void>;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<PostDeployVerificationResult> {
  const attempts = Math.max(1, Math.min(3, Math.trunc(input.attempts ?? 2)));
  const retryDelayMs = Math.max(0, Math.trunc(input.retryDelayMs ?? 5_000));
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempted: Partial<Record<PostDeployStage, number>> = {};
  const stages: Array<[PostDeployStage, () => Promise<void>]> = [
    ["deployment_health", () => input.verifyHealth(0)],
    ["capability_canary", input.verifyCapabilities],
    ["console_health", input.verifyConsole],
    ["private_regressions", input.verifyPrivateRegressions],
    ["stability", () => input.verifyHealth(30)],
    ["promotion", input.promote],
  ];
  let failedStage: PostDeployStage | null = null;
  let error: string | null = null;
  for (const [stage, operation] of stages) {
    const result = await retryStage(stage, operation, attempts, attempted, retryDelayMs, sleep, input.onEvent);
    if (!result.ok) {
      failedStage = stage;
      error = result.error;
      break;
    }
  }
  if (!failedStage) {
    return result("passed", input.expectedRevision, null, attempted, null, null, null);
  }

  const detectionRecorded = await recordFailureDetection(input, failedStage);

  const rollbackRevision = positiveInteger(input.previousHelmRevision);
  if (!rollbackRevision) {
    return result("verification_failed", input.expectedRevision, failedStage, attempted, null, null, error);
  }
  input.onEvent?.({ stage: "rollback", status: "started", helmRevision: rollbackRevision });
  try {
    const rollback = await input.rollback(rollbackRevision);
    input.onEvent?.({ stage: "rollback", status: "passed", helmRevision: rollbackRevision, expectedRevision: rollback.expectedRevision });
    if (!detectionRecorded) await recordFailureDetection(input, failedStage);
    return result("rolled_back", input.expectedRevision, failedStage, attempted, rollbackRevision, rollback.expectedRevision, error);
  } catch (rollbackError) {
    const rollbackMessage = message(rollbackError);
    input.onEvent?.({ stage: "rollback", status: "failed", helmRevision: rollbackRevision, error: rollbackMessage });
    if (!detectionRecorded) await recordFailureDetection(input, failedStage);
    return result("rollback_failed", input.expectedRevision, failedStage, attempted, rollbackRevision, null, `${error}; rollback failed: ${rollbackMessage}`);
  }
}

async function recordFailureDetection(
  input: {
    recordFailureDetection?: (input: { failedStage: PostDeployStage }) => Promise<void>;
    onEvent?: (event: Record<string, unknown>) => void;
  },
  failedStage: PostDeployStage,
) {
  if (!input.recordFailureDetection) return true;
  try {
    await input.recordFailureDetection({ failedStage });
    input.onEvent?.({ stage: "improvement_detection", status: "passed", failedStage });
    return true;
  } catch {
    input.onEvent?.({ stage: "improvement_detection", status: "failed", failedStage });
    return false;
  }
}

async function retryStage(
  stage: PostDeployStage,
  operation: () => Promise<void>,
  attempts: number,
  attempted: Partial<Record<PostDeployStage, number>>,
  retryDelayMs: number,
  sleep: (milliseconds: number) => Promise<void>,
  onEvent?: (event: Record<string, unknown>) => void,
) {
  let lastError = "unknown failure";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attempted[stage] = attempt;
    onEvent?.({ stage, status: "started", attempt, attempts });
    try {
      await operation();
      onEvent?.({ stage, status: "passed", attempt, attempts });
      return { ok: true as const };
    } catch (error) {
      lastError = message(error);
      onEvent?.({ stage, status: "failed", attempt, attempts, error: lastError });
      if (attempt < attempts && retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  return { ok: false as const, error: lastError };
}

function result(
  status: PostDeployVerificationResult["status"],
  expectedRevision: string,
  failedStage: PostDeployStage | null,
  attempts: Partial<Record<PostDeployStage, number>>,
  rollbackRevision: number | null,
  rollbackExpectedRevision: string | null,
  error: string | null,
): PostDeployVerificationResult {
  return { status, expectedRevision, failedStage, attempts, rollbackRevision, rollbackExpectedRevision, error };
}

function positiveInteger(value: number | null | undefined) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** `eval --safe-summary` emits only aggregate counts, so it is safe in CI logs. */
export function privateEvalFailureMessage(error: unknown) {
  const stdout = error && typeof error === "object" && "stdout" in error
    ? (error as { stdout?: unknown }).stdout
    : null;
  const summary = typeof stdout === "string" ? stdout.trim() : Buffer.isBuffer(stdout) ? stdout.toString("utf8").trim() : "";
  return summary ? `${message(error)}; safe eval summary: ${summary}` : message(error);
}

function command(command: string, args: string[], timeout = 120_000) {
  return execFileSync(command, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "inherit"] }).trim();
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyReleaseWithRecovery({
    expectedRevision: args.expectedRevision,
    previousHelmRevision: args.previousHelmRevision,
    attempts: args.attempts,
    verifyHealth: async (stabilitySeconds) => {
      await verifyDeploymentStability({
        namespace: args.namespace,
        release: args.release,
        expectedRevision: args.expectedRevision,
        stabilitySeconds,
      });
    },
    verifyCapabilities: async () => {
      for (const component of ["api", "bot", "worker", "console"]) {
        command("kubectl", ["--namespace", args.namespace, "rollout", "status", `deployment/${args.release}-${component}`, "--timeout=2m"]);
      }
      const allowed = command("kubectl", [
        "auth", "can-i", "create", "jobs.batch", "--namespace", args.namespace,
        `--as=system:serviceaccount:${args.namespace}:${args.release}-worker`,
      ]);
      if (allowed !== "yes") throw new Error("Worker service account cannot create sandbox Jobs.");
      command("kubectl", [
        "--namespace", args.namespace, "exec", `deployment/${args.release}-worker`, "--",
        "node", "dist/scripts/postDeployCanary.js",
      ], 8 * 60_000);
    },
    verifyConsole: async () => {
      const healthArgs = [
        "--namespace", args.namespace, "exec", `deployment/${args.release}-console`, "--",
        "node", "dist/scripts/consoleHealth.js",
        "--revision", args.expectedRevision,
        "--internal-url", "http://127.0.0.1:8081",
      ];
      if (args.consolePublicUrl) healthArgs.push("--public-url", args.consolePublicUrl);
      command("kubectl", healthArgs);
    },
    verifyPrivateRegressions: async () => {
      command("kubectl", [
        "--namespace", args.namespace, "exec", `deployment/${args.release}-worker`, "--",
        "node", "dist/scripts/exportImprovementEvals.js",
      ]);
      try {
        command("kubectl", [
          "--namespace", args.namespace, "exec", `deployment/${args.release}-worker`, "--",
          "node", "dist/scripts/eval.js", "--private-only", "--safe-summary",
          "--record-improvement-results",
        ], 8 * 60_000);
      } catch (error) {
        throw new Error(privateEvalFailureMessage(error), { cause: error });
      }
    },
    promote: async () => {
      command("kubectl", [
        "--namespace", args.namespace, "exec", `deployment/${args.release}-worker`, "--",
        "node", "dist/scripts/markReleaseVerified.js", "--revision", args.expectedRevision,
        "--deployment-id", args.deploymentId,
      ]);
    },
    rollback: (helmRevision) => rollbackRelease({
      helmRevision,
      namespace: args.namespace,
      release: args.release,
      stabilitySeconds: 30,
    }),
    recordFailureDetection: async ({ failedStage }) => {
      const isEvalFailure = failedStage === "private_regressions";
      const source = isEvalFailure ? "eval_detection" : "deployment_detection";
      const stableCode = isEvalFailure ? "private-regression-suite" : `post-deploy-${failedStage}`;
      const summary = isEvalFailure
        ? `Private regression verification failed for revision ${args.expectedRevision}.`
        : `Post-deploy ${failedStage.replaceAll("_", " ")} verification failed for revision ${args.expectedRevision}.`;
      command("kubectl", [
        "--namespace", args.namespace, "exec", `deployment/${args.release}-worker`, "--",
        "node", "dist/scripts/improve.js", "--target", "production", "--confirm-production", "detect",
        "--source", source,
        "--source-id", `post-deploy:${args.deploymentId}:${failedStage}`,
        "--stable-code", stableCode,
        "--summary", summary,
        "--classification", isEvalFailure ? "defect" : "external_incident",
        "--severity", "high",
        "--domain", isEvalFailure ? "evals" : "deployment",
        "--scope", "deployment",
        "--revision", args.expectedRevision,
      ]);
    },
    onEvent: (event) => process.stderr.write(`${JSON.stringify({ type: "release_verification", ...event })}\n`),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
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
  const deploymentId = values.get("deployment-id");
  if (!deploymentId) throw new Error("--deployment-id is required.");
  const previous = values.get("previous-helm-revision");
  const previousHelmRevision = previous ? Number(previous) : null;
  if (previous && !positiveInteger(previousHelmRevision)) throw new Error("--previous-helm-revision must be a positive integer.");
  const attempts = Number(values.get("attempts") ?? 2);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) throw new Error("--attempts must be between 1 and 3.");
  return {
    expectedRevision,
    deploymentId,
    previousHelmRevision,
    attempts,
    namespace: values.get("namespace") ?? "discord-ai-agent",
    release: values.get("release") ?? "discord-ai-agent",
    consolePublicUrl: values.get("console-public-url") ?? null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${message(error)}\n`);
    process.exitCode = 1;
  });
}
