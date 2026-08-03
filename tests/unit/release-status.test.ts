import { describe, expect, it } from "vitest";
import {
  collectReleaseStatus,
  deploymentsFromKubernetes,
  releaseStatusExitCode,
} from "../../scripts/releaseStatus.js";

const kubernetesPayload = {
  items: ["api", "bot", "worker"].flatMap((component) => [{
    kind: "Deployment",
    metadata: { name: `discord-ai-agent-${component}` },
    spec: {
      replicas: 1,
      template: {
        spec: {
          containers: [{
            image: `registry/app:revision-a`,
            env: [{ name: "APP_REVISION", value: "revision-a" }],
          }],
        },
      },
    },
    status: { observedGeneration: 0, readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1 },
  }, {
    kind: "Pod",
    metadata: { name: `discord-ai-agent-${component}-pod`, labels: { "app.kubernetes.io/component": component } },
    spec: { containers: [{ name: component, image: "registry/app:revision-a" }] },
    status: { containerStatuses: [{ name: component, ready: true, restartCount: 0 }] },
  }]),
};

describe("release status", () => {
  it("projects role readiness and deployed revisions", () => {
    expect(deploymentsFromKubernetes(kubernetesPayload)).toEqual([
      expect.objectContaining({ name: "discord-ai-agent-api", revision: "revision-a", ready: 1, desired: 1 }),
      expect.objectContaining({ name: "discord-ai-agent-bot", revision: "revision-a", ready: 1, desired: 1 }),
      expect.objectContaining({ name: "discord-ai-agent-worker", revision: "revision-a", ready: 1, desired: 1 }),
    ]);
  });

  it("combines GitHub, Helm, Kubernetes, deploy, and quality evidence", () => {
    const runner = (command: string, args: string[]) => {
      if (command === "git") return { ok: true as const, stdout: "kartik/reliability" };
      if (command === "helm") return { ok: true as const, stdout: JSON.stringify({ info: { status: "deployed" } }) };
      if (command === "gh" && args[0] === "pr") return { ok: true as const, stdout: JSON.stringify({ number: 343, statusCheckRollup: [{ conclusion: "SUCCESS" }] }) };
      if (command === "gh") return { ok: true as const, stdout: JSON.stringify([{ conclusion: "success", headSha: "revision-a", createdAt: "2026-08-03T00:00:00Z" }]) };
      if (args.includes("deployments,pods")) return { ok: true as const, stdout: JSON.stringify(kubernetesPayload) };
      if (args.includes("agentTaskStatus.js")) return { ok: true as const, stdout: JSON.stringify({ activeAgentSessions: [], activeTasks: [], activeSandboxRuns: [], pendingSandboxCleanup: [] }) };
      return { ok: true as const, stdout: JSON.stringify({ assessment: { status: "pass" } }) };
    };
    const status = collectReleaseStatus({ runner });
    expect(status).toMatchObject({
      deployedRevision: "revision-a",
      revisionsAligned: true,
      rolloutReady: true,
      deploymentHealth: expect.objectContaining({ healthy: true }),
      warnings: [],
    });
    expect(releaseStatusExitCode(status)).toBe(0);
  });

  it("fails when roles drift or quality fails", () => {
    const deployments = deploymentsFromKubernetes(kubernetesPayload);
    deployments[0]!.revision = "revision-b";
    const status = {
      generatedAt: "2026-08-03T00:00:00Z",
      branch: null,
      pullRequest: null,
      checks: [],
      helm: null,
      deployments,
      deployedRevision: null,
      revisionsAligned: false,
      rolloutReady: true,
      deploymentHealth: null,
      deploymentRun: null,
      quality: { assessment: { status: "fail" } },
      tasks: null,
      warnings: [],
    };
    expect(releaseStatusExitCode(status)).toBe(1);
  });
});
