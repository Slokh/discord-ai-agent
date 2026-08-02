import { randomUUID } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import type { AppConfig } from "../config/env.js";
import { assertExecutionConfig } from "../config/env.js";
import type { SandboxRunRecord } from "../db/repositories.js";
import { resolveGitHubTaskToken } from "./githubAuth.js";
import { slugify } from "../util/text.js";
import { taskBearerToken } from "./token.js";
import type { AgentTaskJob, AgentTaskStartResult } from "./types.js";

export type ExecutionContext = {
  sandboxId?: string | null;
  progress?: (event: { step: string; message: string; metadata?: Record<string, unknown> }) => Promise<void> | void;
  recordSandboxRun?: (run: AgentTaskStartResult) => Promise<void> | void;
};

export type ExecutionBackend = {
  name: string;
  start: (job: AgentTaskJob, context?: ExecutionContext) => Promise<AgentTaskStartResult>;
  observeRun: (run: SandboxRunRecord) => Promise<ObservedSandboxRun>;
  cleanupRun: (run: SandboxRunRecord) => Promise<void>;
};

export type ObservedSandboxRun = {
  status: "running" | "succeeded" | "failed" | "gone";
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type KubernetesExecutionClients = {
  batch: Pick<k8s.BatchV1Api, "createNamespacedJob" | "readNamespacedJob" | "deleteNamespacedJob"> & Partial<Pick<k8s.BatchV1Api, "listNamespacedJob">>;
  core: Pick<
    k8s.CoreV1Api,
    | "createNamespacedSecret"
    | "replaceNamespacedSecret"
    | "deleteNamespacedSecret"
    | "createNamespacedConfigMap"
    | "replaceNamespacedConfigMap"
    | "deleteNamespacedConfigMap"
  > &
    Partial<Pick<k8s.CoreV1Api, "listNamespacedSecret" | "listNamespacedConfigMap">>;
};

export function createExecutionBackend(config: AppConfig): ExecutionBackend {
  return new KubernetesExecutionBackend(config);
}

export class KubernetesExecutionBackend implements ExecutionBackend {
  readonly name = "kubernetes-sandbox";

  private readonly batch: KubernetesExecutionClients["batch"];
  private readonly core: KubernetesExecutionClients["core"];

  constructor(
    private readonly config: AppConfig,
    clients?: KubernetesExecutionClients
  ) {
    if (clients) {
      this.batch = clients.batch;
      this.core = clients.core;
      return;
    }
    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromDefault();
    this.batch = kubeConfig.makeApiClient(k8s.BatchV1Api);
    this.core = kubeConfig.makeApiClient(k8s.CoreV1Api);
  }

  async start(job: AgentTaskJob, context: ExecutionContext = {}): Promise<AgentTaskStartResult> {
    assertExecutionConfig(this.config);
    const sandboxRunId = `run-${randomUUID()}`;
    const name = kubernetesName(`agent-task-${slugify(job.taskId)}`);
    const namespace = this.config.execution.kubernetes.namespace;
    const token = taskBearerToken({ taskId: job.taskId, sandboxRunId, secret: this.config.execution.taskSigningSecret });
    const githubToken = await resolveGitHubTaskToken(this.config);
    const labels = {
      "app.kubernetes.io/name": "discord-ai-agent",
      "app.kubernetes.io/component": "sandbox",
      "discord-ai-agent/task-id": job.taskId,
      "discord-ai-agent/sandbox-run-id": sandboxRunId
    };
    const secretName = `${name}-secret`;
    const configMapName = `${name}-config`;
    const startResult = { sandboxRunId, backendJobName: name, namespace, image: this.config.execution.kubernetes.sandboxImage };

    await context.progress?.({
      step: "sandbox_prepare",
      message: "Preparing an isolated Kubernetes sandbox for the code change.",
      metadata: { namespace, jobName: name, sandboxRunId }
    });
    await context.recordSandboxRun?.(startResult);
    try {
      await this.createSecret(namespace, secretName, labels, {
        GITHUB_TOKEN: githubToken,
        OPENROUTER_API_KEY: this.config.openRouter.apiKey,
        AGENT_TASK_TOKEN: token,
        AGENT_TASK_SIGNATURE_SECRET: this.config.execution.taskSigningSecret
      });
      await this.createConfigMap(namespace, configMapName, labels, {
        TASK_ID: job.taskId,
        TASK_TYPE: job.taskType,
        TRACE_ID: job.traceId ?? job.taskId,
        SANDBOX_RUN_ID: sandboxRunId,
        TASK_TITLE: job.title,
        TASK_REQUEST: job.request,
        BUG_REPORT_RESULT_PATH: `/tmp/${job.taskId}-bug-report-result.json`,
        REQUESTED_BY: job.requestedBy,
        TARGET_BRANCH: job.targetBranch ?? "",
        TARGET_PULL_REQUEST_NUMBER: job.targetPullRequestNumber == null ? "" : String(job.targetPullRequestNumber),
        TARGET_PULL_REQUEST_URL: job.targetPullRequestUrl ?? "",
        CONTROL_PLANE_INTERNAL_URL: this.config.execution.controlPlaneInternalUrl,
        GITHUB_REPOSITORY: this.config.github.repository,
        GITHUB_BASE_BRANCH: this.config.github.baseBranch,
        OPENROUTER_BASE_URL: this.config.openRouter.baseUrl,
        OPENROUTER_CODEGEN_MODEL: this.config.openRouter.codegenModel,
        SANDBOX_CACHE_DIR: "/tmp/discord-ai-agent-cache",
        SANDBOX_STARTED_AT_MS: String(Date.now())
      });

      await context.progress?.({
        step: "sandbox_start",
        message: "Starting the Kubernetes sandbox job.",
        metadata: { namespace, jobName: name, image: this.config.execution.kubernetes.sandboxImage }
      });
      await this.batch.createNamespacedJob({
        namespace,
        body: this.jobManifest({ name, namespace, labels })
      });
    } catch (error) {
      await Promise.all([
        this.deleteSecret(namespace, secretName).catch(() => undefined),
        this.deleteConfigMap(namespace, configMapName).catch(() => undefined)
      ]);
      throw error;
    }

    return startResult;
  }

  async observeRun(run: SandboxRunRecord): Promise<ObservedSandboxRun> {
    if (!run.namespace || !run.backendJobName) {
      return { status: "gone", reason: "Sandbox run is missing Kubernetes namespace or Job name." };
    }

    try {
      const response = await this.batch.readNamespacedJob({ namespace: run.namespace, name: run.backendJobName });
      const job = response;
      const conditions = job.status?.conditions ?? [];
      const failed = conditions.find((condition) => condition.type === "Failed" && condition.status === "True");
      if (failed || (job.status?.failed ?? 0) > 0) {
        return {
          status: "failed",
          reason: failed?.message ?? failed?.reason ?? "Kubernetes Job failed.",
          metadata: { failed: job.status?.failed ?? null, succeeded: job.status?.succeeded ?? null }
        };
      }
      const complete = conditions.find((condition) => condition.type === "Complete" && condition.status === "True");
      if (complete || (job.status?.succeeded ?? 0) > 0) {
        return {
          status: "succeeded",
          reason: complete?.message ?? complete?.reason ?? "Kubernetes Job completed.",
          metadata: { failed: job.status?.failed ?? null, succeeded: job.status?.succeeded ?? null }
        };
      }
      return {
        status: "running",
        metadata: {
          active: job.status?.active ?? null,
          failed: job.status?.failed ?? null,
          succeeded: job.status?.succeeded ?? null
        }
      };
    } catch (error) {
      if (isKubernetesNotFound(error)) return { status: "gone", reason: "Kubernetes Job was not found." };
      throw error;
    }
  }

  async cleanupRun(run: SandboxRunRecord): Promise<void> {
    if (!run.namespace || !run.backendJobName) return;
    await Promise.all([
      this.deleteJob(run.namespace, run.backendJobName),
      this.deleteSecret(run.namespace, `${run.backendJobName}-secret`),
      this.deleteConfigMap(run.namespace, `${run.backendJobName}-config`)
    ]);
  }

  async sweepOrphanResources(knownTaskIds: Set<string>): Promise<void> {
    const namespace = this.config.execution.kubernetes.namespace;
    const selector = "app.kubernetes.io/name=discord-ai-agent,app.kubernetes.io/component=sandbox";
    if (!this.batch.listNamespacedJob || !this.core.listNamespacedSecret || !this.core.listNamespacedConfigMap) return;
    const [jobs, secrets, configMaps] = await Promise.all([
      this.batch.listNamespacedJob({ namespace, labelSelector: selector }),
      this.core.listNamespacedSecret({ namespace, labelSelector: selector }),
      this.core.listNamespacedConfigMap({ namespace, labelSelector: selector })
    ]);
    await Promise.all([
      ...(jobs.items ?? [])
        .filter((item) => isOrphanTaskLabel(item.metadata?.labels?.["discord-ai-agent/task-id"], knownTaskIds))
        .map((item) => (item.metadata?.name ? this.deleteJob(namespace, item.metadata.name) : undefined)),
      ...(secrets.items ?? [])
        .filter((item) => isOrphanTaskLabel(item.metadata?.labels?.["discord-ai-agent/task-id"], knownTaskIds))
        .map((item) => (item.metadata?.name ? this.deleteSecret(namespace, item.metadata.name) : undefined)),
      ...(configMaps.items ?? [])
        .filter((item) => isOrphanTaskLabel(item.metadata?.labels?.["discord-ai-agent/task-id"], knownTaskIds))
        .map((item) => (item.metadata?.name ? this.deleteConfigMap(namespace, item.metadata.name) : undefined))
    ]);
  }

  private async createSecret(namespace: string, name: string, labels: Record<string, string>, data: Record<string, string>) {
    const body = {
      metadata: { name, labels },
      type: "Opaque",
      stringData: data
    };
    try {
      await this.core.createNamespacedSecret({ namespace, body });
    } catch (error) {
      if (!isKubernetesConflict(error)) throw error;
      await this.core.replaceNamespacedSecret({ namespace, name, body });
    }
  }

  private async createConfigMap(namespace: string, name: string, labels: Record<string, string>, data: Record<string, string>) {
    const body = {
      metadata: { name, labels },
      data
    };
    try {
      await this.core.createNamespacedConfigMap({ namespace, body });
    } catch (error) {
      if (!isKubernetesConflict(error)) throw error;
      await this.core.replaceNamespacedConfigMap({ namespace, name, body });
    }
  }

  private jobManifest(input: { name: string; namespace: string; labels: Record<string, string> }): k8s.V1Job {
    const k8sConfig = this.config.execution.kubernetes;
    return {
      metadata: {
        name: input.name,
        namespace: input.namespace,
        labels: input.labels
      },
      spec: {
        activeDeadlineSeconds: this.config.execution.sandbox.taskTimeoutSeconds,
        backoffLimit: 0,
        ttlSecondsAfterFinished: k8sConfig.ttlSecondsAfterFinished,
        template: {
          metadata: { labels: input.labels },
          spec: {
            restartPolicy: "Never",
            serviceAccountName: k8sConfig.serviceAccountName,
            containers: [
              {
                name: "sandbox",
                image: k8sConfig.sandboxImage,
                imagePullPolicy: k8sConfig.imagePullPolicy,
                command: ["node", "dist/src/execution/sandboxRunner.js"],
                envFrom: [
                  { configMapRef: { name: `${input.name}-config` } },
                  { secretRef: { name: `${input.name}-secret` } }
                ],
                resources: {
                  requests: { cpu: k8sConfig.cpuRequest, memory: k8sConfig.memoryRequest },
                  limits: { cpu: k8sConfig.cpuLimit, memory: k8sConfig.memoryLimit }
                }
              }
            ]
          }
        }
      }
    };
  }

  private async deleteJob(namespace: string, name: string) {
    try {
      await this.batch.deleteNamespacedJob({ namespace, name, propagationPolicy: "Background" });
    } catch (error) {
      if (!isKubernetesNotFound(error)) throw error;
    }
  }

  private async deleteSecret(namespace: string, name: string) {
    try {
      await this.core.deleteNamespacedSecret({ namespace, name });
    } catch (error) {
      if (!isKubernetesNotFound(error)) throw error;
    }
  }

  private async deleteConfigMap(namespace: string, name: string) {
    try {
      await this.core.deleteNamespacedConfigMap({ namespace, name });
    } catch (error) {
      if (!isKubernetesNotFound(error)) throw error;
    }
  }
}

function isKubernetesConflict(error: unknown) {
  return kubernetesErrorStatus(error) === 409;
}

function isKubernetesNotFound(error: unknown) {
  return kubernetesErrorStatus(error) === 404;
}

function isOrphanTaskLabel(taskId: string | undefined, knownTaskIds: Set<string>) {
  return Boolean(taskId && !knownTaskIds.has(taskId));
}

function kubernetesErrorStatus(error: unknown) {
  if (typeof error !== "object" || error == null) return undefined;
  const candidate = error as {
    code?: unknown;
    statusCode?: unknown;
    response?: { statusCode?: unknown; status?: unknown };
    body?: { code?: unknown };
  };
  return Number(candidate.code ?? candidate.statusCode ?? candidate.response?.statusCode ?? candidate.response?.status ?? candidate.body?.code);
}

function kubernetesName(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/^-+|-+$/g, "");
  return normalized || "agent-task";
}
