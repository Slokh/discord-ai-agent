import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { KubernetesExecutionBackend, type KubernetesExecutionClients } from "../../src/execution/backend.js";
import type { AgentTaskJob } from "../../src/execution/types.js";
import type { SandboxRunRecord } from "../../src/db/repositories.js";

describe("KubernetesExecutionBackend", () => {
  it("cleans per-task secret and configmap when job creation fails", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: "sk-test",
        GITHUB_TOKEN: "github-token",
        GITHUB_REPOSITORY: "example/discord-ai-agent",
        TASK_SIGNING_SECRET: "task-secret",
        KUBERNETES_NAMESPACE: "discord-ai-agent"
      },
      async () => {
        const clients = fakeClients({
          createNamespacedJob: vi.fn(async () => {
            throw new Error("cluster refused job");
          })
        });
        const backend = new KubernetesExecutionBackend(loadConfig(), clients);

        await expect(backend.start(agentTask())).rejects.toThrow("cluster refused job");

        expect(clients.core.deleteNamespacedSecret).toHaveBeenCalledWith({
          namespace: "discord-ai-agent",
          name: "agent-task-update-the-readme-00005678-secret"
        });
        expect(clients.core.deleteNamespacedConfigMap).toHaveBeenCalledWith({
          namespace: "discord-ai-agent",
          name: "agent-task-update-the-readme-00005678-config"
        });
      }
    );
  });

  it("cleans prepared resources when configmap creation fails", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: "sk-test",
        GITHUB_TOKEN: "github-token",
        GITHUB_REPOSITORY: "example/discord-ai-agent",
        TASK_SIGNING_SECRET: "task-secret",
        KUBERNETES_NAMESPACE: "discord-ai-agent"
      },
      async () => {
        const clients = fakeClients(
          {},
          {
            createNamespacedConfigMap: vi.fn(async () => {
              throw new Error("configmap quota exceeded");
            })
          }
        );
        const backend = new KubernetesExecutionBackend(loadConfig(), clients);

        await expect(backend.start(agentTask())).rejects.toThrow("configmap quota exceeded");

        expect(clients.core.deleteNamespacedSecret).toHaveBeenCalledWith({
          namespace: "discord-ai-agent",
          name: "agent-task-update-the-readme-00005678-secret"
        });
        expect(clients.core.deleteNamespacedConfigMap).toHaveBeenCalledWith({
          namespace: "discord-ai-agent",
          name: "agent-task-update-the-readme-00005678-config"
        });
        expect(clients.batch.createNamespacedJob).not.toHaveBeenCalled();
      }
    );
  });

  it("mounts the sandbox cache PVC and passes cache env into task config", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: "sk-test",
        GITHUB_TOKEN: "github-token",
        GITHUB_REPOSITORY: "example/discord-ai-agent",
        TASK_SIGNING_SECRET: "task-secret",
        KUBERNETES_NAMESPACE: "discord-ai-agent",
        SANDBOX_CACHE_DIR: "/var/cache/discord-ai-agent",
        SANDBOX_CACHE_PVC_NAME: "discord-ai-agent-sandbox-cache"
      },
      async () => {
        const clients = fakeClients();
        const backend = new KubernetesExecutionBackend(loadConfig(), clients);

        await backend.start(agentTask());

        expect(clients.core.createNamespacedConfigMap).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              data: expect.objectContaining({
                SANDBOX_CACHE_DIR: "/var/cache/discord-ai-agent",
                SANDBOX_STARTED_AT_MS: expect.any(String)
              })
            })
          })
        );
        expect(clients.batch.createNamespacedJob).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              spec: expect.objectContaining({
                template: expect.objectContaining({
                  spec: expect.objectContaining({
                    volumes: [
                      {
                        name: "sandbox-cache",
                        persistentVolumeClaim: { claimName: "discord-ai-agent-sandbox-cache" }
                      }
                    ],
                    containers: [
                      expect.objectContaining({
                        volumeMounts: [
                          {
                            name: "sandbox-cache",
                            mountPath: "/var/cache/discord-ai-agent"
                          }
                        ]
                      })
                    ]
                  })
                })
              })
            })
          })
        );
      }
    );
  });

  it("launches a task in a claimed warm sandbox pod when the pool has capacity", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: "sk-test",
        GITHUB_TOKEN: "github-token",
        GITHUB_REPOSITORY: "example/discord-ai-agent",
        GITHUB_BASE_BRANCH: "main",
        TASK_SIGNING_SECRET: "task-secret",
        KUBERNETES_NAMESPACE: "discord-ai-agent",
        SANDBOX_WARM_POOL_ENABLED: "true",
        SANDBOX_WARM_POOL_SIZE: "1"
      },
      async () => {
        const clients = fakeClients();
        const exec = {
          exec: vi.fn(async (_namespace, _podName, _containerName, _command, stdout, _stderr, _stdin, _tty, statusCallback) => {
            stdout?.write("started\n");
            statusCallback?.({ status: "Success" });
            return { once: vi.fn() } as any;
          })
        };
        const warmStore = fakeWarmStore({
          countWarmSandboxes: vi.fn(async () => 1),
          claimReadyWarmSandbox: vi.fn(async () => warmSandbox())
        });
        const backend = new KubernetesExecutionBackend(loadConfig(), { ...clients, exec }, { warmStore });

        const result = await backend.start(agentTask());

        expect(result).toEqual(
          expect.objectContaining({
            backendJobName: "warm-pod-1",
            metadata: expect.objectContaining({ warmPool: "hit", warmSandboxId: "warm-1" })
          })
        );
        expect(exec.exec).toHaveBeenCalledWith(
          "discord-ai-agent",
          "warm-pod-1",
          "sandbox",
          expect.any(Array),
          expect.anything(),
          expect.anything(),
          expect.anything(),
          false,
          expect.any(Function)
        );
        expect(clients.batch.createNamespacedJob).not.toHaveBeenCalled();
        expect(clients.core.createNamespacedSecret).not.toHaveBeenCalled();
        expect(warmStore.heartbeatWarmSandbox).toHaveBeenCalledWith(
          expect.objectContaining({ sandboxId: "warm-1", taskId: "task-00005678" })
        );
      }
    );
  });

  it("releases warm sandboxes during cleanup instead of deleting job resources", async () => {
    const clients = fakeClients();
    const warmStore = fakeWarmStore();
    const backend = new KubernetesExecutionBackend(loadConfig(), clients, { warmStore });

    await backend.cleanupRun({
      ...sandboxRun(),
      backendJobName: "warm-pod-1",
      metadata: { warmSandboxId: "warm-1" }
    });

    expect(warmStore.releaseWarmSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "warm-1",
        taskId: "task-00005678",
        status: "ready"
      })
    );
    expect(clients.batch.deleteNamespacedJob).not.toHaveBeenCalled();
    expect(clients.core.deleteNamespacedSecret).not.toHaveBeenCalled();
    expect(clients.core.deleteNamespacedConfigMap).not.toHaveBeenCalled();
  });

  it("pre-warms sandbox pods during warm pool reconciliation", async () => {
    await withEnv(
      {
        GITHUB_REPOSITORY: "example/discord-ai-agent",
        GITHUB_BASE_BRANCH: "main",
        SANDBOX_WARM_POOL_ENABLED: "true",
        SANDBOX_WARM_POOL_SIZE: "1"
      },
      async () => {
        const clients = fakeClients();
        const warmStore = fakeWarmStore({ countWarmSandboxes: vi.fn(async () => 0) });
        const backend = new KubernetesExecutionBackend(
          loadConfig(),
          { ...clients, exec: { exec: vi.fn() } },
          { warmStore }
        );

        await backend.reconcileWarmPool();

        expect(warmStore.upsertWarmSandbox).toHaveBeenCalledWith(expect.objectContaining({ status: "creating" }));
        expect(clients.core.createNamespacedPod).toHaveBeenCalledWith(
          expect.objectContaining({
            namespace: "discord-ai-agent",
            body: expect.objectContaining({
              metadata: expect.objectContaining({
                labels: expect.objectContaining({ "discord-ai-agent/sandbox-role": "warm-pool" })
              })
            })
          })
        );
      }
    );
  });

  it("treats Kubernetes 404 response shapes as gone", async () => {
    const clients = fakeClients({
      readNamespacedJob: vi.fn(async () => {
        throw { response: { status: 404 } };
      })
    });
    const backend = new KubernetesExecutionBackend(loadConfig(), clients);

    await expect(backend.observeRun(sandboxRun())).resolves.toEqual({
      status: "gone",
      reason: "Kubernetes Job was not found."
    });
  });
});

function fakeClients(
  batchOverrides: Partial<KubernetesExecutionClients["batch"]> = {},
  coreOverrides: Partial<KubernetesExecutionClients["core"]> = {}
): KubernetesExecutionClients {
  return {
    batch: {
      createNamespacedJob: vi.fn(async () => ({})),
      readNamespacedJob: vi.fn(async () => ({ status: {} })),
      deleteNamespacedJob: vi.fn(async () => ({})),
      ...batchOverrides
    },
    core: {
      createNamespacedSecret: vi.fn(async () => ({})),
      replaceNamespacedSecret: vi.fn(async () => ({})),
      deleteNamespacedSecret: vi.fn(async () => ({})),
      createNamespacedConfigMap: vi.fn(async () => ({})),
      replaceNamespacedConfigMap: vi.fn(async () => ({})),
      deleteNamespacedConfigMap: vi.fn(async () => ({})),
      createNamespacedPod: vi.fn(async () => ({})),
      readNamespacedPod: vi.fn(async () => ({
        status: {
          phase: "Running",
          containerStatuses: [{ name: "sandbox", ready: true, image: "sandbox:latest", imageID: "sandbox:latest", restartCount: 0 }]
        }
      })),
      deleteNamespacedPod: vi.fn(async () => ({})),
      ...coreOverrides
    }
  };
}

function fakeWarmStore(overrides: Record<string, unknown> = {}) {
  return {
    upsertWarmSandbox: vi.fn(async () => warmSandbox()),
    listWarmSandboxes: vi.fn(async () => []),
    countWarmSandboxes: vi.fn(async () => 0),
    markWarmSandboxReady: vi.fn(async () => warmSandbox()),
    claimReadyWarmSandbox: vi.fn(async () => undefined),
    heartbeatWarmSandbox: vi.fn(async () => true),
    releaseWarmSandbox: vi.fn(async () => warmSandbox()),
    markWarmSandboxFailed: vi.fn(async () => warmSandbox({ status: "failed" })),
    listExpiredWarmSandboxLeases: vi.fn(async () => []),
    ...overrides
  } as any;
}

function warmSandbox(overrides: Record<string, unknown> = {}) {
  return {
    sandboxId: "warm-1",
    backend: "kubernetes-sandbox",
    repoKey: "example/discord-ai-agent#main",
    namespace: "discord-ai-agent",
    podName: "warm-pod-1",
    image: "discord-ai-agent-sandbox:latest",
    status: "ready",
    leaseTaskId: null,
    leaseOwner: null,
    leasedAt: null,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    lastUsedAt: null,
    metadata: {},
    lastError: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides
  };
}

async function withEnv(values: Record<string, string>, callback: () => Promise<void>) {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function agentTask(): AgentTaskJob {
  return {
    taskId: "task-00005678",
    traceId: "trace-1",
    taskType: "code_update",
    request: "Update the README.",
    title: "Update the README",
    requestedBy: "user-1",
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1"
  };
}

function sandboxRun(): SandboxRunRecord {
  return {
    sandboxRunId: "run-1",
    taskId: "task-00005678",
    taskStatus: "running",
    backend: "kubernetes-sandbox",
    namespace: "discord-ai-agent",
    backendJobName: "agent-task-update-the-readme-00005678",
    image: "sandbox:latest",
    status: "running",
    metadata: {},
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: null,
    cleanedUpAt: null,
    updatedAt: new Date("2026-01-01T00:00:01Z")
  };
}
