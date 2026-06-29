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

function fakeClients(overrides: Partial<KubernetesExecutionClients["batch"]> = {}): KubernetesExecutionClients {
  return {
    batch: {
      createNamespacedJob: vi.fn(async () => ({})),
      readNamespacedJob: vi.fn(async () => ({ status: {} })),
      deleteNamespacedJob: vi.fn(async () => ({})),
      ...overrides
    },
    core: {
      createNamespacedSecret: vi.fn(async () => ({})),
      replaceNamespacedSecret: vi.fn(async () => ({})),
      deleteNamespacedSecret: vi.fn(async () => ({})),
      createNamespacedConfigMap: vi.fn(async () => ({})),
      replaceNamespacedConfigMap: vi.fn(async () => ({})),
      deleteNamespacedConfigMap: vi.fn(async () => ({}))
    }
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
