import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createExecutionBackend, KubernetesExecutionBackend, type KubernetesExecutionClients } from "../../src/execution/backend.js";
import type { AgentTaskJob } from "../../src/execution/types.js";
import type { SandboxRunRecord } from "../../src/db/repositories.js";

describe("KubernetesExecutionBackend", () => {
  it("cleans per-task resources when job creation fails", async () => {
    await withExecutionEnv(async () => {
      const clients = fakeClients({ createNamespacedJob: vi.fn(async () => { throw new Error("cluster refused job"); }) });
      const backend = new KubernetesExecutionBackend(loadConfig(), clients);

      await expect(backend.start(agentTask())).rejects.toThrow("cluster refused job");
      expect(clients.core.deleteNamespacedSecret).toHaveBeenCalledWith({ namespace: "discord-ai-agent", name: "agent-task-task-00005678-secret" });
      expect(clients.core.deleteNamespacedConfigMap).toHaveBeenCalledWith({ namespace: "discord-ai-agent", name: "agent-task-task-00005678-config" });
    });
  });

  it("cleans the secret when configmap creation fails", async () => {
    await withExecutionEnv(async () => {
      const clients = fakeClients({}, { createNamespacedConfigMap: vi.fn(async () => { throw new Error("configmap quota exceeded"); }) });
      const backend = new KubernetesExecutionBackend(loadConfig(), clients);

      await expect(backend.start(agentTask())).rejects.toThrow("configmap quota exceeded");
      expect(clients.core.deleteNamespacedSecret).toHaveBeenCalled();
      expect(clients.batch.createNamespacedJob).not.toHaveBeenCalled();
    });
  });

  it("passes only task-specific configuration into an isolated task", async () => {
    await withExecutionEnv(async () => {
      const clients = fakeClients();
      const backend = new KubernetesExecutionBackend(loadConfig(), clients);
      await backend.start({
        ...agentTask(),
        targetBranch: "kartik/follow-up",
        targetPullRequestNumber: 120,
        targetPullRequestUrl: "https://github.com/Slokh/discord-ai-agent/pull/120"
      });

      expect(clients.core.createNamespacedConfigMap).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({ data: expect.objectContaining({
          TARGET_BRANCH: "kartik/follow-up",
          TARGET_PULL_REQUEST_NUMBER: "120"
        }) })
      }));
      const config = vi.mocked(clients.core.createNamespacedConfigMap).mock.calls[0]?.[0].body.data;
      expect(config).not.toHaveProperty("GITHUB_REPOSITORY");
      expect(config).not.toHaveProperty("GITHUB_BASE_BRANCH");
      const job = vi.mocked(clients.batch.createNamespacedJob).mock.calls[0]?.[0].body;
      expect(job?.spec?.template.spec?.containers[0]?.image).toBe("registry.example/sandbox:test");
      expect(job?.spec?.template.spec).not.toHaveProperty("volumes");
    });
  });

  it("uses task ids for valid bounded Kubernetes names", async () => {
    await withExecutionEnv(async () => {
      const clients = fakeClients();
      const backend = new KubernetesExecutionBackend(loadConfig(), clients);
      await backend.start({ ...agentTask(), taskId: "task-123456789012345678", title: "a very long title that must not control identity" });
      const name = vi.mocked(clients.batch.createNamespacedJob).mock.calls[0]?.[0].body.metadata?.name;
      expect(name).toBe("agent-task-task-123456789012345678");
      expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    });
  });

  it("treats Kubernetes 404s as gone", async () => {
    const clients = fakeClients({ readNamespacedJob: vi.fn(async () => { throw { response: { status: 404 } }; }) });
    const backend = new KubernetesExecutionBackend(loadConfig(), clients);
    await expect(backend.observeRun(sandboxRun())).resolves.toEqual({ status: "gone", reason: "Kubernetes Job was not found." });
  });

  it("has one execution backend", () => {
    expect(createExecutionBackend(loadConfig())).toBeInstanceOf(KubernetesExecutionBackend);
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
      ...coreOverrides
    }
  };
}

async function withExecutionEnv(callback: () => Promise<void>) {
  const values = {
    OPENROUTER_API_KEY: "sk-test",
    GITHUB_TOKEN: "github-token",
    TASK_SIGNING_SECRET: "task-secret",
    POD_NAMESPACE: "discord-ai-agent",
    SANDBOX_IMAGE: "registry.example/sandbox:test"
  };
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, values);
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
    backendJobName: "agent-task-task-00005678",
    image: "sandbox:latest",
    status: "running",
    metadata: {},
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: null,
    cleanedUpAt: null,
    updatedAt: new Date("2026-01-01T00:00:01Z")
  };
}
