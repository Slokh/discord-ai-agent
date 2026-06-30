import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as k8s from "@kubernetes/client-node";
import type { AppConfig } from "../config/env.js";
import { assertExecutionConfig } from "../config/env.js";
import type { DiscordAiAgentRepository, SandboxRunRecord, WarmSandboxRecord } from "../db/repositories.js";
import { resolveGitHubTaskToken } from "../github/appToken.js";
import { slugify } from "../util/text.js";
import { taskBearerToken } from "./token.js";
import type { AgentTaskJob, AgentTaskStartResult } from "./types.js";

export type ExecutionContext = {
  progress?: (event: { step: string; message: string; metadata?: Record<string, unknown> }) => Promise<void> | void;
};

export type ExecutionBackend = {
  name: string;
  start: (job: AgentTaskJob, context?: ExecutionContext) => Promise<AgentTaskStartResult>;
};

export type ObservedSandboxRun = {
  status: "running" | "succeeded" | "failed" | "gone";
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type KubernetesExecutionClients = {
  batch: Pick<k8s.BatchV1Api, "createNamespacedJob" | "readNamespacedJob" | "deleteNamespacedJob">;
  core: Pick<
    k8s.CoreV1Api,
    | "createNamespacedSecret"
    | "replaceNamespacedSecret"
    | "deleteNamespacedSecret"
    | "createNamespacedConfigMap"
    | "replaceNamespacedConfigMap"
    | "deleteNamespacedConfigMap"
    | "createNamespacedPod"
    | "readNamespacedPod"
    | "deleteNamespacedPod"
  >;
  exec?: Pick<k8s.Exec, "exec">;
};

type WarmSandboxStore = Pick<
  DiscordAiAgentRepository,
  | "upsertWarmSandbox"
  | "listWarmSandboxes"
  | "countWarmSandboxes"
  | "markWarmSandboxReady"
  | "claimReadyWarmSandbox"
  | "heartbeatWarmSandbox"
  | "releaseWarmSandbox"
  | "markWarmSandboxFailed"
  | "listExpiredWarmSandboxLeases"
>;

export class KubernetesExecutionBackend implements ExecutionBackend {
  readonly name = "kubernetes-sandbox";

  private readonly batch: KubernetesExecutionClients["batch"];
  private readonly core: KubernetesExecutionClients["core"];
  private readonly exec?: Pick<k8s.Exec, "exec">;
  private readonly warmStore?: WarmSandboxStore;

  constructor(
    private readonly config: AppConfig,
    clients?: KubernetesExecutionClients,
    options: { warmStore?: WarmSandboxStore } = {}
  ) {
    this.warmStore = options.warmStore;
    if (clients) {
      this.batch = clients.batch;
      this.core = clients.core;
      this.exec = clients.exec;
      return;
    }
    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromDefault();
    this.batch = kubeConfig.makeApiClient(k8s.BatchV1Api);
    this.core = kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.exec = new k8s.Exec(kubeConfig);
  }

  async start(job: AgentTaskJob, context: ExecutionContext = {}): Promise<AgentTaskStartResult> {
    const warmResult = await this.startWarmPod(job, context);
    if (warmResult) return warmResult;
    return this.startColdJob(job, context);
  }

  async reconcileWarmPool(): Promise<void> {
    const warmPool = this.config.execution.kubernetes.warmPool;
    if (!warmPool.enabled || warmPool.size <= 0 || !this.warmStore || !this.exec) return;
    const repoKey = this.warmRepoKey();
    await this.reconcileWarmSandboxes(repoKey);
    await this.ensureWarmPoolCapacity(repoKey, {});
  }

  private async startColdJob(job: AgentTaskJob, context: ExecutionContext = {}): Promise<AgentTaskStartResult> {
    assertExecutionConfig(this.config);
    const sandboxRunId = `run-${randomUUID()}`;
    const name = kubernetesName(`agent-task-${slugify(job.title)}-${job.taskId.slice(-8)}`);
    const namespace = this.config.execution.kubernetes.namespace;
    const token = taskBearerToken({ taskId: job.taskId, secret: this.config.execution.taskSigningSecret });
    const githubToken = await resolveGitHubTaskToken(this.config);
    const labels = {
      "app.kubernetes.io/name": "discord-ai-agent",
      "app.kubernetes.io/component": "sandbox",
      "discord-ai-agent/task-id": job.taskId,
      "discord-ai-agent/sandbox-run-id": sandboxRunId
    };
    const secretName = `${name}-secret`;
    const configMapName = `${name}-config`;

    await context.progress?.({
      step: "sandbox_prepare",
      message: "Preparing an isolated Kubernetes sandbox for the code change.",
      metadata: { namespace, jobName: name, sandboxRunId }
    });
    try {
      await this.createSecret(namespace, secretName, labels, {
        GITHUB_TOKEN: githubToken,
        OPENROUTER_API_KEY: this.config.openRouter.apiKey,
        AGENT_TASK_TOKEN: token
      });
      await this.createConfigMap(namespace, configMapName, labels, {
        TASK_ID: job.taskId,
        TRACE_ID: job.traceId ?? job.taskId,
        SANDBOX_RUN_ID: sandboxRunId,
        TASK_TITLE: job.title,
        TASK_REQUEST: job.request,
        REQUESTED_BY: job.requestedBy,
        CONTROL_PLANE_INTERNAL_URL: this.config.execution.controlPlaneInternalUrl,
        GITHUB_REPOSITORY: this.config.github.repository,
        GITHUB_BASE_BRANCH: this.config.github.baseBranch,
        OPENROUTER_CHAT_MODEL: this.config.openRouter.chatModel,
        SANDBOX_CACHE_DIR: this.config.execution.kubernetes.cacheDir,
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

    return { sandboxRunId, backendJobName: name };
  }

  private async startWarmPod(job: AgentTaskJob, context: ExecutionContext): Promise<AgentTaskStartResult | undefined> {
    const warmPool = this.config.execution.kubernetes.warmPool;
    if (!warmPool.enabled || warmPool.size <= 0 || !this.warmStore || !this.exec) return undefined;
    assertExecutionConfig(this.config);

    const namespace = this.config.execution.kubernetes.namespace;
    const repoKey = this.warmRepoKey();
    await context.progress?.({
      step: "warm_pool_prepare",
      message: "Checking for a reusable Kubernetes sandbox.",
      metadata: { namespace, repoKey, warmPoolSize: warmPool.size }
    });

    try {
      await this.reconcileWarmSandboxes(repoKey);
      await this.ensureWarmPoolCapacity(repoKey, context);

      for (let attempt = 0; attempt < Math.max(1, warmPool.size); attempt += 1) {
        const warm = await this.warmStore.claimReadyWarmSandbox({
          repoKey,
          taskId: job.taskId,
          leaseOwner: job.requestedBy || job.userId || "agent-task",
          leaseSeconds: warmPool.leaseSeconds
        });
        if (!warm) break;

        if (!(await this.warmPodIsUsable(warm))) {
          await this.warmStore.markWarmSandboxFailed({
            sandboxId: warm.sandboxId,
            error: "Warm sandbox pod is not running or ready.",
            metadata: { repoKey, podName: warm.podName }
          });
          continue;
        }

        const sandboxRunId = `run-${randomUUID()}`;
        await context.progress?.({
          step: "warm_pool_hit",
          message: "Reusing a warm Kubernetes sandbox.",
          metadata: {
            namespace: warm.namespace,
            podName: warm.podName,
            sandboxRunId,
            warmSandboxId: warm.sandboxId,
            repoKey
          }
        });

        try {
          await this.launchTaskInWarmPod({ job, warm, sandboxRunId });
          return {
            sandboxRunId,
            backendJobName: warm.podName ?? "",
            metadata: {
              warmPool: "hit",
              warmSandboxId: warm.sandboxId,
              podName: warm.podName,
              repoKey
            }
          };
        } catch (error) {
          await this.deletePod(warm.namespace ?? namespace, warm.podName ?? "").catch(() => undefined);
          await this.warmStore.markWarmSandboxFailed({
            sandboxId: warm.sandboxId,
            error: conciseError(error),
            metadata: { repoKey, podName: warm.podName, launchFailed: true }
          });
          await context.progress?.({
            step: "warm_pool_launch_failed",
            message: "Warm sandbox launch failed; falling back to a cold Kubernetes job.",
            metadata: { warmSandboxId: warm.sandboxId, error: conciseError(error) }
          });
          return undefined;
        }
      }

      await context.progress?.({
        step: "warm_pool_miss",
        message: "No ready warm sandbox is available; falling back to a cold Kubernetes job.",
        metadata: { namespace, repoKey, warmPoolSize: warmPool.size }
      });
    } catch (error) {
      await context.progress?.({
        step: "warm_pool_unavailable",
        message: "Warm sandbox pool is unavailable; falling back to a cold Kubernetes job.",
        metadata: { namespace, repoKey, error: conciseError(error) }
      });
    }
    return undefined;
  }

  private async reconcileWarmSandboxes(repoKey: string) {
    if (!this.warmStore) return;

    const expired = await this.warmStore.listExpiredWarmSandboxLeases(50);
    await Promise.all(
      expired
        .filter((warm) => warm.repoKey === repoKey)
        .map(async (warm) => {
          if (warm.namespace && warm.podName) await this.deletePod(warm.namespace, warm.podName).catch(() => undefined);
          await this.warmStore!.markWarmSandboxFailed({
            sandboxId: warm.sandboxId,
            error: "Warm sandbox lease expired.",
            metadata: { repoKey, podName: warm.podName, expiredLeaseTaskId: warm.leaseTaskId }
          });
        })
    );

    const records = await this.warmStore.listWarmSandboxes({ repoKey, statuses: ["creating", "ready"], limit: 50 });
    await Promise.all(
      records.map(async (warm) => {
        if (!warm.namespace || !warm.podName) {
          await this.warmStore!.markWarmSandboxFailed({ sandboxId: warm.sandboxId, error: "Warm sandbox is missing pod identity." });
          return;
        }
        if (warm.status === "ready" && warmSandboxIdleExpired(warm, this.config.execution.kubernetes.warmPool.idleTtlSeconds)) {
          await this.deletePod(warm.namespace, warm.podName).catch(() => undefined);
          await this.warmStore!.markWarmSandboxFailed({
            sandboxId: warm.sandboxId,
            error: "Warm sandbox exceeded idle TTL.",
            metadata: { repoKey, podName: warm.podName }
          });
          return;
        }
        const pod = await this.readPod(warm.namespace, warm.podName).catch(async (error) => {
          if (isKubernetesNotFound(error)) {
            await this.warmStore!.markWarmSandboxFailed({
              sandboxId: warm.sandboxId,
              error: "Warm sandbox pod disappeared.",
              metadata: { repoKey, podName: warm.podName }
            });
            return null;
          }
          throw error;
        });
        if (!pod) return;
        const phase = pod.status?.phase ?? "Unknown";
        if (phase === "Failed" || phase === "Succeeded") {
          await this.warmStore!.markWarmSandboxFailed({
            sandboxId: warm.sandboxId,
            error: `Warm sandbox pod is terminal: ${phase}.`,
            metadata: { repoKey, podName: warm.podName, phase }
          });
          return;
        }
        if (isWarmPodReady(pod)) {
          await this.warmStore!.markWarmSandboxReady({
            sandboxId: warm.sandboxId,
            metadata: { repoKey, podName: warm.podName, phase }
          });
        }
      })
    );
  }

  private async ensureWarmPoolCapacity(repoKey: string, context: ExecutionContext) {
    if (!this.warmStore) return;
    const warmPool = this.config.execution.kubernetes.warmPool;
    const activeCount = await this.warmStore.countWarmSandboxes({ repoKey, statuses: ["creating", "ready", "leased"] });
    const missing = Math.max(0, warmPool.size - activeCount);
    for (let index = 0; index < missing; index += 1) {
      await this.createWarmSandboxPod(repoKey, context);
    }
  }

  private async createWarmSandboxPod(repoKey: string, context: ExecutionContext) {
    if (!this.warmStore) return;
    const sandboxId = `warm-${randomUUID()}`;
    const namespace = this.config.execution.kubernetes.namespace;
    const podName = kubernetesName(`warm-${sandboxId.slice(5, 13)}-${slugify(this.config.github.repository)}`);
    const labels = {
      "app.kubernetes.io/name": "discord-ai-agent",
      "app.kubernetes.io/component": "sandbox",
      "discord-ai-agent/sandbox-role": "warm-pool",
      "discord-ai-agent/warm-sandbox-id": sandboxId,
      "discord-ai-agent/repo": kubernetesName(repoKey)
    };

    await this.warmStore.upsertWarmSandbox({
      sandboxId,
      backend: this.name,
      repoKey,
      namespace,
      podName,
      image: this.config.execution.kubernetes.sandboxImage,
      status: "creating",
      metadata: { repoKey }
    });

    try {
      await this.core.createNamespacedPod({
        namespace,
        body: this.warmPodManifest({ name: podName, namespace, labels })
      });
      await context.progress?.({
        step: "warm_pool_seed",
        message: "Created a warm Kubernetes sandbox pod.",
        metadata: { namespace, podName, warmSandboxId: sandboxId, repoKey }
      });
    } catch (error) {
      await this.warmStore.markWarmSandboxFailed({
        sandboxId,
        error: conciseError(error),
        metadata: { repoKey, podName }
      });
      throw error;
    }
  }

  private async launchTaskInWarmPod(input: { job: AgentTaskJob; warm: WarmSandboxRecord; sandboxRunId: string }) {
    const namespace = input.warm.namespace;
    const podName = input.warm.podName;
    if (!namespace || !podName) throw new Error("Warm sandbox is missing namespace or pod name.");
    const env = await this.warmTaskEnv(input.job, input.sandboxRunId, input.warm.sandboxId);
    const envFile = Object.entries(env)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
      .join("\n");
    const safeTaskId = kubernetesName(input.job.taskId);
    const launchScript = [
      "set -eu",
      `env_file="/tmp/discord-ai-agent-${safeTaskId}.env"`,
      `log_file="/tmp/discord-ai-agent-${safeTaskId}.log"`,
      'cat > "$env_file"',
      'chmod 600 "$env_file"',
      'nohup /bin/sh -lc \'. "$1"; rm -f "$1"; node dist/src/execution/sandboxRunner.js; exit $?\' sh "$env_file" > "$log_file" 2>&1 &',
      'printf "started\\n"'
    ].join("\n");
    await this.execWarmPod(namespace, podName, launchScript, `${envFile}\n`);
    await this.warmStore?.heartbeatWarmSandbox({
      sandboxId: input.warm.sandboxId,
      taskId: input.job.taskId,
      leaseSeconds: this.config.execution.kubernetes.warmPool.leaseSeconds
    });
  }

  private async warmTaskEnv(job: AgentTaskJob, sandboxRunId: string, warmSandboxId: string): Promise<Record<string, string>> {
    assertExecutionConfig(this.config);
    const token = taskBearerToken({ taskId: job.taskId, secret: this.config.execution.taskSigningSecret });
    const githubToken = await resolveGitHubTaskToken(this.config);
    return {
      TASK_ID: job.taskId,
      TRACE_ID: job.traceId ?? job.taskId,
      SANDBOX_RUN_ID: sandboxRunId,
      WARM_SANDBOX_ID: warmSandboxId,
      TASK_TITLE: job.title,
      TASK_REQUEST: job.request,
      REQUESTED_BY: job.requestedBy,
      CONTROL_PLANE_INTERNAL_URL: this.config.execution.controlPlaneInternalUrl,
      GITHUB_REPOSITORY: this.config.github.repository,
      GITHUB_BASE_BRANCH: this.config.github.baseBranch,
      OPENROUTER_CHAT_MODEL: this.config.openRouter.chatModel,
      SANDBOX_CACHE_DIR: this.config.execution.kubernetes.cacheDir,
      SANDBOX_STARTED_AT_MS: String(Date.now()),
      GITHUB_TOKEN: githubToken,
      OPENROUTER_API_KEY: this.config.openRouter.apiKey,
      AGENT_TASK_TOKEN: token
    };
  }

  private async execWarmPod(namespace: string, podName: string, script: string, stdinText: string) {
    if (!this.exec) throw new Error("Kubernetes exec client is not configured.");
    const stdout = writableStringBuffer();
    const stderr = writableStringBuffer();
    let resolveStatus: (status: k8s.V1Status | undefined) => void = () => undefined;
    const statusPromise = new Promise<k8s.V1Status | undefined>((resolve) => {
      resolveStatus = resolve;
    });
    const socket = await this.exec.exec(
      namespace,
      podName,
      "sandbox",
      ["/bin/sh", "-lc", script],
      stdout.writable,
      stderr.writable,
      Readable.from([stdinText]),
      false,
      (status) => resolveStatus(status)
    );
    const closePromise = new Promise<undefined>((resolve) => {
      const maybeSocket = socket as { once?: (event: string, callback: () => void) => void };
      maybeSocket.once?.("close", () => resolve(undefined));
    });
    const status = await Promise.race([statusPromise, closePromise, sleep(15_000).then(() => undefined)]);
    const output = stdout.value();
    if (status && status.status && status.status !== "Success") {
      throw new Error(`Warm sandbox exec failed: ${status.message ?? status.reason ?? status.status} ${stderr.value()}`.trim());
    }
    if (!output.includes("started")) {
      throw new Error(`Warm sandbox exec did not confirm task launch: ${stderr.value() || output || "no output"}`);
    }
  }

  private async warmPodIsUsable(warm: WarmSandboxRecord) {
    if (!warm.namespace || !warm.podName) return false;
    const pod = await this.readPod(warm.namespace, warm.podName).catch(() => null);
    return pod ? isWarmPodReady(pod) : false;
  }

  private warmRepoKey() {
    return `${this.config.github.repository}#${this.config.github.baseBranch}`.toLowerCase();
  }

  async observeRun(run: SandboxRunRecord): Promise<ObservedSandboxRun> {
    const warmSandboxId = stringMetadata(run.metadata, "warmSandboxId");
    if (warmSandboxId) return this.observeWarmRun(run, warmSandboxId);

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

  private async observeWarmRun(run: SandboxRunRecord, warmSandboxId: string): Promise<ObservedSandboxRun> {
    if (!run.namespace || !run.backendJobName) {
      return { status: "gone", reason: "Warm sandbox run is missing Kubernetes namespace or pod name." };
    }
    if (run.startedAt) {
      const elapsedSeconds = Math.floor((Date.now() - run.startedAt.getTime()) / 1000);
      if (elapsedSeconds > this.config.execution.kubernetes.taskTimeoutSeconds) {
        return {
          status: "failed",
          reason: "Warm sandbox task exceeded the configured timeout.",
          metadata: { warmSandboxId, elapsedSeconds, timeoutSeconds: this.config.execution.kubernetes.taskTimeoutSeconds }
        };
      }
    }

    try {
      const pod = await this.readPod(run.namespace, run.backendJobName);
      const phase = pod.status?.phase ?? "Unknown";
      if (phase === "Failed" || phase === "Succeeded") {
        return {
          status: "failed",
          reason: `Warm sandbox pod is terminal: ${phase}.`,
          metadata: { warmSandboxId, phase }
        };
      }
      return { status: "running", metadata: { warmSandboxId, phase, ready: isWarmPodReady(pod) } };
    } catch (error) {
      if (isKubernetesNotFound(error)) return { status: "gone", reason: "Warm sandbox pod was not found.", metadata: { warmSandboxId } };
      throw error;
    }
  }

  async cleanupRun(run: SandboxRunRecord): Promise<void> {
    if (!run.namespace || !run.backendJobName) return;
    const warmSandboxId = stringMetadata(run.metadata, "warmSandboxId");
    if (warmSandboxId) {
      await this.warmStore?.releaseWarmSandbox({
        sandboxId: warmSandboxId,
        taskId: run.taskId,
        status: "ready",
        metadata: {
          sandboxRunId: run.sandboxRunId,
          taskStatus: run.taskStatus,
          backendJobName: run.backendJobName
        }
      });
      return;
    }
    await Promise.all([
      this.deleteJob(run.namespace, run.backendJobName),
      this.deleteSecret(run.namespace, `${run.backendJobName}-secret`),
      this.deleteConfigMap(run.namespace, `${run.backendJobName}-config`)
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
    const volumeMounts = k8sConfig.cachePvcName
      ? [
          {
            name: "sandbox-cache",
            mountPath: k8sConfig.cacheDir
          }
        ]
      : undefined;
    const volumes = k8sConfig.cachePvcName
      ? [
          {
            name: "sandbox-cache",
            persistentVolumeClaim: { claimName: k8sConfig.cachePvcName }
          }
        ]
      : undefined;
    return {
      metadata: {
        name: input.name,
        namespace: input.namespace,
        labels: input.labels
      },
      spec: {
        activeDeadlineSeconds: k8sConfig.taskTimeoutSeconds,
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
                },
                ...(volumeMounts ? { volumeMounts } : {})
              }
            ],
            ...(volumes ? { volumes } : {})
          }
        }
      }
    };
  }

  private warmPodManifest(input: { name: string; namespace: string; labels: Record<string, string> }): k8s.V1Pod {
    const k8sConfig = this.config.execution.kubernetes;
    const volumeMounts = k8sConfig.cachePvcName
      ? [
          {
            name: "sandbox-cache",
            mountPath: k8sConfig.cacheDir
          }
        ]
      : undefined;
    const volumes = k8sConfig.cachePvcName
      ? [
          {
            name: "sandbox-cache",
            persistentVolumeClaim: { claimName: k8sConfig.cachePvcName }
          }
        ]
      : undefined;
    return {
      metadata: {
        name: input.name,
        namespace: input.namespace,
        labels: input.labels
      },
      spec: {
        restartPolicy: "Never",
        serviceAccountName: k8sConfig.serviceAccountName,
        terminationGracePeriodSeconds: 10,
        containers: [
          {
            name: "sandbox",
            image: k8sConfig.sandboxImage,
            imagePullPolicy: k8sConfig.imagePullPolicy,
            command: ["/bin/sh", "-lc", "trap 'exit 0' TERM INT; while true; do sleep 3600 & wait $!; done"],
            resources: {
              requests: { cpu: k8sConfig.cpuRequest, memory: k8sConfig.memoryRequest },
              limits: { cpu: k8sConfig.cpuLimit, memory: k8sConfig.memoryLimit }
            },
            ...(volumeMounts ? { volumeMounts } : {})
          }
        ],
        ...(volumes ? { volumes } : {})
      }
    };
  }

  private async readPod(namespace: string, name: string) {
    return this.core.readNamespacedPod({ namespace, name });
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

  private async deletePod(namespace: string, name: string) {
    if (!namespace || !name) return;
    try {
      await this.core.deleteNamespacedPod({ namespace, name, propagationPolicy: "Background" });
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

function isWarmPodReady(pod: k8s.V1Pod) {
  if (pod.status?.phase !== "Running") return false;
  const containerStatuses = pod.status.containerStatuses ?? [];
  const sandbox = containerStatuses.find((status) => status.name === "sandbox");
  return sandbox ? Boolean(sandbox.ready) : true;
}

function warmSandboxIdleExpired(warm: WarmSandboxRecord, idleTtlSeconds: number) {
  const lastActiveAt = warm.lastUsedAt ?? warm.createdAt;
  return Date.now() - lastActiveAt.getTime() > idleTtlSeconds * 1000;
}

function writableStringBuffer(maxChars = 8_000) {
  let value = "";
  return {
    writable: new Writable({
      write(chunk, _encoding, callback) {
        value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (value.length > maxChars) value = value.slice(value.length - maxChars);
        callback();
      }
    }),
    value: () => value
  };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function conciseError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function stringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function kubernetesName(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return normalized || "agent-task";
}
