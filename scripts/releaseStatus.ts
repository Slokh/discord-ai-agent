import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

type CommandResult = { ok: true; stdout: string } | { ok: false; error: string };
type Runner = (command: string, args: string[]) => CommandResult;

type Deployment = {
  name: string;
  revision: string | null;
  image: string | null;
  ready: number;
  desired: number;
};

export type ReleaseStatus = {
  generatedAt: string;
  branch: string | null;
  pullRequest: Record<string, unknown> | null;
  checks: Array<Record<string, unknown>>;
  helm: Record<string, unknown> | null;
  deployments: Deployment[];
  deployedRevision: string | null;
  revisionsAligned: boolean;
  rolloutReady: boolean;
  deploymentRun: Record<string, unknown> | null;
  quality: Record<string, unknown> | null;
  tasks: Record<string, unknown> | null;
  warnings: string[];
};

export function collectReleaseStatus(input: {
  runner?: Runner;
  pr?: string;
  namespace?: string;
  release?: string;
} = {}): ReleaseStatus {
  const runner = input.runner ?? runOptional;
  const namespace = input.namespace ?? "discord-ai-agent";
  const release = input.release ?? "discord-ai-agent";
  const warnings: string[] = [];
  const branch = textResult(runner("git", ["branch", "--show-current"]), warnings, "git branch");
  const prResult = runner("gh", [
    "pr", "view", input.pr ?? branch ?? "", "--json",
    "number,url,title,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup",
  ]);
  const pullRequestRaw = jsonResult(prResult, warnings, "pull request");
  const checks = Array.isArray(pullRequestRaw?.statusCheckRollup)
    ? pullRequestRaw.statusCheckRollup as Array<Record<string, unknown>>
    : [];
  const pullRequest = pullRequestSummary(pullRequestRaw);
  const helm = helmSummary(jsonResult(
    runner("helm", ["status", release, "--namespace", namespace, "--output", "json"]),
    warnings,
    "Helm release",
  ));
  const deploymentPayload = jsonResult(
    runner("kubectl", [
      "--namespace", namespace, "get", "deployments",
      "-l", "app.kubernetes.io/name=discord-ai-agent", "-o", "json",
    ]),
    warnings,
    "Kubernetes deployments",
  );
  const deployments = deploymentsFromKubernetes(deploymentPayload);
  const revisions = new Set(deployments.map((deployment) => deployment.revision).filter(Boolean));
  const deployedRevision = revisions.size === 1 ? [...revisions][0] ?? null : null;
  const revisionsAligned = deployments.length > 0 && revisions.size === 1;
  const rolloutReady = deployments.length > 0
    && deployments.every((deployment) => deployment.desired > 0 && deployment.ready === deployment.desired);
  if (!revisionsAligned) warnings.push("Application roles do not report one deployed revision.");
  if (!rolloutReady) warnings.push("One or more application roles are not fully ready.");

  const deploymentRun = deployedRevision
    ? latestDeployRun(jsonArrayResult(runner("gh", [
        "run", "list", "--workflow", "Deploy EKS", "--commit", deployedRevision,
        "--limit", "5", "--json", "databaseId,status,conclusion,url,headSha,createdAt",
      ]), warnings, "deployment workflow"))
    : null;
  const workerName = deployments.find((deployment) => deployment.name === `${release}-worker`)?.name;
  const quality = deployedRevision && workerName
    ? jsonResult(runner("kubectl", [
        "--namespace", namespace, "exec", `deployment/${workerName}`, "--",
        "node", "dist/scripts/revisionQuality.js", "--revision", deployedRevision,
        "--hours", "48", "--compare",
      ]), warnings, "revision quality")
    : null;
  const taskSnapshot = workerName
    ? jsonResult(runner("kubectl", [
        "--namespace", namespace, "exec", `deployment/${workerName}`, "--",
        "node", "dist/scripts/agentTaskStatus.js", "--source", "db", "--json",
        "--limit", "20",
      ]), warnings, "task reconciliation")
    : null;
  const tasks = taskSummary(taskSnapshot);

  return {
    generatedAt: new Date().toISOString(),
    branch,
    pullRequest,
    checks,
    helm,
    deployments,
    deployedRevision,
    revisionsAligned,
    rolloutReady,
    deploymentRun,
    quality,
    tasks,
    warnings,
  };
}

export function deploymentsFromKubernetes(payload: Record<string, unknown> | null): Deployment[] {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as any;
    const containers = item.spec?.template?.spec?.containers;
    const container = Array.isArray(containers) ? containers[0] : null;
    const env = Array.isArray(container?.env) ? container.env : [];
    const revision = env.find((entry: any) => entry?.name === "APP_REVISION")?.value;
    return [{
      name: String(item.metadata?.name ?? "unknown"),
      revision: typeof revision === "string" && revision ? revision : null,
      image: typeof container?.image === "string" ? container.image : null,
      ready: numberValue(item.status?.readyReplicas),
      desired: numberValue(item.spec?.replicas),
    }];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function releaseStatusExitCode(status: ReleaseStatus) {
  const checksFailed = status.checks.some((check) =>
    ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(String(check.conclusion ?? check.state ?? "").toUpperCase()));
  const deploymentFailed = String(status.deploymentRun?.conclusion ?? "").toLowerCase() === "failure";
  const qualityFailed = (status.quality?.assessment as any)?.status === "fail";
  const taskRecoveryNeeded = Number(status.tasks?.staleActive ?? 0) > 0
    || Number(status.tasks?.pendingCleanup ?? 0) > 0;
  return checksFailed || deploymentFailed || qualityFailed || taskRecoveryNeeded
    || !status.revisionsAligned || !status.rolloutReady ? 1 : 0;
}

function latestDeployRun(runs: Array<Record<string, unknown>>) {
  return runs.sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")))[0] ?? null;
}

function pullRequestSummary(value: Record<string, any> | null): Record<string, unknown> | null {
  if (!value) return null;
  return {
    number: typeof value.number === "number" ? value.number : null,
    url: typeof value.url === "string" ? value.url : null,
    title: typeof value.title === "string" ? value.title : null,
    state: typeof value.state === "string" ? value.state : null,
    draft: value.isDraft === true,
    mergeState: typeof value.mergeStateStatus === "string" ? value.mergeStateStatus : null,
    base: typeof value.baseRefName === "string" ? value.baseRefName : null,
    head: typeof value.headRefName === "string" ? value.headRefName : null,
    headRevision: typeof value.headRefOid === "string" ? value.headRefOid : null,
  };
}

function helmSummary(value: Record<string, any> | null): Record<string, unknown> | null {
  if (!value) return null;
  const hooks = Array.isArray(value.hooks) ? value.hooks : value.info?.hooks;
  const migration = Array.isArray(hooks)
    ? hooks.find((hook: any) => hook?.kind === "Job" && hook?.last_run)
    : null;
  return {
    name: typeof value.name === "string" ? value.name : null,
    namespace: typeof value.namespace === "string" ? value.namespace : null,
    version: typeof value.version === "number" ? value.version : null,
    status: typeof value.info?.status === "string" ? value.info.status : null,
    lastDeployed: typeof value.info?.last_deployed === "string" ? value.info.last_deployed : null,
    migration: migration
      ? {
          name: typeof migration.name === "string" ? migration.name : null,
          phase: typeof migration.last_run?.phase === "string" ? migration.last_run.phase : null,
          completedAt: typeof migration.last_run?.completed_at === "string" ? migration.last_run.completed_at : null,
        }
      : null,
  };
}

function taskSummary(value: Record<string, any> | null): Record<string, unknown> | null {
  if (!value) return null;
  const activeSessions = array(value.activeAgentSessions);
  const activeTasks = array(value.activeTasks);
  const activeSandboxes = array(value.activeSandboxRuns);
  const pendingCleanup = array(value.pendingSandboxCleanup);
  return {
    activeSessions: activeSessions.length,
    activeTasks: activeTasks.length,
    activeSandboxes: activeSandboxes.length,
    pendingCleanup: pendingCleanup.length,
    staleActive: [...activeSessions, ...activeTasks, ...activeSandboxes]
      .filter((item) => item && typeof item === "object" && item.stale === true).length,
  };
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function jsonResult(result: CommandResult, warnings: string[], label: string): Record<string, any> | null {
  if (!result.ok) {
    warnings.push(`${label} unavailable: ${result.error}`);
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    warnings.push(`${label} returned invalid JSON.`);
    return null;
  }
}

function jsonArrayResult(result: CommandResult, warnings: string[], label: string): Array<Record<string, unknown>> {
  if (!result.ok) {
    warnings.push(`${label} unavailable: ${result.error}`);
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
  } catch {
    warnings.push(`${label} returned invalid JSON.`);
    return [];
  }
}

function textResult(result: CommandResult, warnings: string[], label: string) {
  if (result.ok) return result.stdout.trim() || null;
  warnings.push(`${label} unavailable: ${result.error}`);
  return null;
}

function runOptional(command: string, args: string[]): CommandResult {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        timeout: command === "kubectl" ? 30_000 : 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    const message = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    return { ok: false, error: message || (error instanceof Error ? error.message : String(error)) };
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const status = collectReleaseStatus({
    pr: argument("--pr"),
    namespace: argument("--namespace"),
    release: argument("--release"),
  });
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exitCode = releaseStatusExitCode(status);
}
