import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import {
  buildSandboxRunnerEnv,
  createExecutionBackend,
  KubernetesExecutionBackend,
  LocalProcessExecutionBackend,
  type KubernetesExecutionClients
} from "../../src/execution/backend.js";
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
        OPENROUTER_CHAT_MODEL: "z-ai/glm-5.2",
        OPENROUTER_CODEGEN_MODEL: "openai/gpt-5.5",
        CODEGEN_HARNESS: "opencode",
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
                OPENROUTER_CHAT_MODEL: "z-ai/glm-5.2",
                OPENROUTER_CODEGEN_MODEL: "openai/gpt-5.5",
                CODEGEN_HARNESS: "opencode",
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

  it("trims Kubernetes job names after truncating long task titles", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: "sk-test",
        GITHUB_TOKEN: "github-token",
        GITHUB_REPOSITORY: "example/discord-ai-agent",
        TASK_SIGNING_SECRET: "task-secret",
        KUBERNETES_NAMESPACE: "discord-ai-agent"
      },
      async () => {
        const clients = fakeClients();
        const backend = new KubernetesExecutionBackend(loadConfig(), clients);

        await backend.start({
          ...agentTask(),
          taskId: "task-1521299407214084337",
          title: "animated-emoji-a-loading-1521299407214084337-bef"
        });

        const job = vi.mocked(clients.batch.createNamespacedJob).mock.calls[0]?.[0].body;
        const jobName = job?.metadata?.name;

        expect(jobName).toBe("agent-task-animated-emoji-a-loading-1521299407214084337");
        expect(jobName).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
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

describe("LocalProcessExecutionBackend", () => {
  it("spawns the sandbox runner with task-scoped environment and observes the child process", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: "sk-test",
        GITHUB_TOKEN: "github-token",
        GITHUB_REPOSITORY: "example/discord-ai-agent",
        GITHUB_BASE_BRANCH: "main",
        TASK_SIGNING_SECRET: "task-secret",
        CONTROL_PLANE_INTERNAL_URL: "http://agent-api:8080",
        OPENROUTER_CHAT_MODEL: "z-ai/glm-5.2",
        OPENROUTER_CODEGEN_MODEL: "openai/gpt-5.5",
        CODEGEN_HARNESS: "opencode",
        SANDBOX_CACHE_DIR: "/var/cache/warm-codegen",
        CODEGEN_EXECUTION_BACKEND: "local-process"
      },
      async () => {
        const child = fakeChildProcess();
        const spawnProcess = vi.fn(() => child as any);
        const githubTokenResolver = vi.fn(async () => "resolved-github-token");
        const backend = new LocalProcessExecutionBackend(loadConfig(), {
          spawnProcess: spawnProcess as any,
          githubTokenResolver,
          now: () => 1782930000000
        });
        const progress = vi.fn(async () => undefined);

        const result = await backend.start(agentTask(), { progress });

        expect(result).toEqual(
          expect.objectContaining({
            sandboxRunId: expect.stringMatching(/^run-/),
            backendJobName: "agent-task-update-the-readme-00005678",
            namespace: null,
            image: "local-process"
          })
        );
        expect(createExecutionBackend(loadConfig()).name).toBe("local-process-sandbox");
        expect(githubTokenResolver).toHaveBeenCalled();
        expect(spawnProcess).toHaveBeenCalledWith(
          process.execPath,
          ["dist/src/execution/sandboxRunner.js"],
          expect.objectContaining({
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
            env: expect.objectContaining({
              TASK_ID: "task-00005678",
              TRACE_ID: "trace-1",
              SANDBOX_RUN_ID: result.sandboxRunId,
              TASK_TITLE: "Update the README",
              TASK_REQUEST: "Update the README.",
              REQUESTED_BY: "user-1",
              CONTROL_PLANE_INTERNAL_URL: "http://agent-api:8080",
              GITHUB_TOKEN: "resolved-github-token",
              GITHUB_REPOSITORY: "example/discord-ai-agent",
              GITHUB_BASE_BRANCH: "main",
              OPENROUTER_API_KEY: "sk-test",
              OPENROUTER_CHAT_MODEL: "z-ai/glm-5.2",
              OPENROUTER_CODEGEN_MODEL: "openai/gpt-5.5",
              CODEGEN_HARNESS: "opencode",
              AGENT_TASK_TOKEN: expect.any(String),
              SANDBOX_CACHE_DIR: "/var/cache/warm-codegen",
              SANDBOX_STARTED_AT_MS: "1782930000000"
            })
          })
        );
        expect(progress).toHaveBeenCalledWith(
          expect.objectContaining({ step: "sandbox_prepare", message: "Preparing a warm local codegen worker process." })
        );
        await expect(backend.observeRun({ ...sandboxRun(), sandboxRunId: result.sandboxRunId })).resolves.toEqual(
          expect.objectContaining({ status: "running", metadata: expect.objectContaining({ pid: 4242 }) })
        );

        const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        child.stdout.emit("data", Buffer.from("stdout before failure\n"));
        child.stderr.emit("data", Buffer.from("GITHUB_TOKEN=secretsecretsecretsecretsecret\n"));
        expect(stdoutWrite).toHaveBeenCalledWith("stdout before failure\n");
        expect(stderrWrite).toHaveBeenCalledWith("GITHUB_TOKEN=[REDACTED]\n");
        stdoutWrite.mockRestore();
        stderrWrite.mockRestore();
        child.emit("exit", 1, null);
        await expect(backend.observeRun({ ...sandboxRun(), sandboxRunId: result.sandboxRunId })).resolves.toEqual(
          expect.objectContaining({
            status: "failed",
            metadata: expect.objectContaining({
              exitCode: 1,
              stdoutTail: "stdout before failure\n",
              stderrTail: "GITHUB_TOKEN=[REDACTED]\n"
            })
          })
        );
      }
    );
  });

  it("fails and terminates local codegen processes that exceed the sandbox timeout", async () => {
    vi.useFakeTimers();
    let now = 1782930000000;
    try {
      await withEnv(
        {
          OPENROUTER_API_KEY: "sk-test",
          GITHUB_TOKEN: "github-token",
          GITHUB_REPOSITORY: "example/discord-ai-agent",
          GITHUB_BASE_BRANCH: "main",
          TASK_SIGNING_SECRET: "task-secret",
          CONTROL_PLANE_INTERNAL_URL: "http://agent-api:8080",
          SANDBOX_TASK_TIMEOUT_SECONDS: "1",
          CODEGEN_EXECUTION_BACKEND: "local-process"
        },
        async () => {
          const child = fakeChildProcess();
          const backend = new LocalProcessExecutionBackend(loadConfig(), {
            spawnProcess: vi.fn(() => child as any) as any,
            githubTokenResolver: vi.fn(async () => "resolved-github-token"),
            now: () => now
          });
          const result = await backend.start(agentTask());

          now += 1_001;
          await vi.advanceTimersByTimeAsync(1_001);

          expect(child.kill).toHaveBeenCalledWith("SIGTERM");
          await expect(backend.observeRun({ ...sandboxRun(), sandboxRunId: result.sandboxRunId })).resolves.toEqual(
            expect.objectContaining({
              status: "failed",
              reason: "Local codegen process exceeded 1s sandbox timeout.",
              metadata: expect.objectContaining({ timedOut: true })
            })
          );

          await backend.cleanupRun({ ...sandboxRun(), sandboxRunId: result.sandboxRunId });
          expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds sandbox runner environment without leaking placeholder values", () => {
    const config = {
      ...loadConfig(),
      execution: { ...loadConfig().execution, taskSigningSecret: "secret", controlPlaneInternalUrl: "http://agent-api:8080" },
      openRouter: { ...loadConfig().openRouter, apiKey: "sk-test", chatModel: "chat-model", codegenModel: "code-model" },
      github: { ...loadConfig().github, repository: "example/repo", baseBranch: "main" }
    };

    expect(
      buildSandboxRunnerEnv({
        config,
        job: agentTask(),
        sandboxRunId: "run-123",
        taskToken: "task-token",
        githubToken: "github-token",
        startedAtMs: 123,
        baseEnv: { PATH: "/usr/bin" }
      })
    ).toEqual(
      expect.objectContaining({
        PATH: "/usr/bin",
        TASK_ID: "task-00005678",
        SANDBOX_RUN_ID: "run-123",
        GITHUB_TOKEN: "github-token",
        OPENROUTER_API_KEY: "sk-test",
        CODEGEN_HARNESS: "opencode",
        AGENT_TASK_TOKEN: "task-token"
      })
    );
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

function fakeChildProcess() {
  const child = new EventEmitter() as any;
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = vi.fn();
  child.kill = vi.fn();
  return child;
}
