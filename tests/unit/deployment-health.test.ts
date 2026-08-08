import { describe, expect, it, vi } from "vitest";
import { evaluateDeploymentHealth, verifyDeploymentStability } from "../../scripts/deploymentHealth.js";

describe("deployment health", () => {
  it("accepts aligned, observed, restart-free roles", () => {
    expect(evaluateDeploymentHealth(snapshot(), { release: "discord-ai-agent", expectedRevision: "revision-a" })).toMatchObject({
      healthy: true,
      components: [
        { component: "api", restarts: 0 },
        { component: "bot", restarts: 0 },
        { component: "worker", restarts: 0 },
        { component: "console", restarts: 0 },
      ],
      issues: [],
    });
  });

  it("rejects drift, incomplete readiness, and container restarts", () => {
    const payload = snapshot();
    const botDeployment = payload.items.find((item: any) => item.kind === "Deployment" && item.metadata.name.endsWith("-bot")) as any;
    botDeployment.status.readyReplicas = 0;
    botDeployment.status.observedGeneration = 1;
    const botPod = payload.items.find((item: any) => item.kind === "Pod" && item.metadata.labels["app.kubernetes.io/component"] === "bot") as any;
    botPod.status.containerStatuses[0].restartCount = 2;
    const result = evaluateDeploymentHealth(payload, { release: "discord-ai-agent", expectedRevision: "revision-a" });
    expect(result.healthy).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("not fully ready"),
      expect.stringContaining("has not observed generation"),
      expect.stringContaining("restarted 2 time"),
    ]));
  });

  it("holds health for every sample in the stability window", async () => {
    const readSnapshot = vi.fn(() => snapshot());
    const sleep = vi.fn(async () => undefined);
    await expect(verifyDeploymentStability({
      namespace: "namespace",
      release: "discord-ai-agent",
      expectedRevision: "revision-a",
      stabilitySeconds: 10,
      intervalMs: 5_000,
      readSnapshot,
      sleep,
    })).resolves.toMatchObject({ healthy: true });
    expect(readSnapshot).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("allows restarts before the gate while rejecting a restart during its stability window", async () => {
    const settled = snapshot();
    for (const item of settled.items.filter((item: any) => item.kind === "Pod")) {
      item.status.containerStatuses[0].restartCount = 1;
    }
    await expect(verifyDeploymentStability({
      namespace: "namespace",
      release: "discord-ai-agent",
      expectedRevision: "revision-a",
      stabilitySeconds: 5,
      intervalMs: 5_000,
      readSnapshot: () => settled,
      sleep: async () => undefined,
    })).resolves.toMatchObject({ healthy: true });

    let reads = 0;
    await expect(verifyDeploymentStability({
      namespace: "namespace",
      release: "discord-ai-agent",
      expectedRevision: "revision-a",
      stabilitySeconds: 5,
      intervalMs: 5_000,
      readSnapshot: () => {
        const sample = snapshot();
        if (reads++ > 0) sample.items.find((item: any) => item.kind === "Pod")!.status.containerStatuses[0].restartCount = 1;
        return sample;
      },
      sleep: async () => undefined,
    })).rejects.toThrow("stability window");
  });
});

function snapshot() {
  const items: any[] = [];
  for (const component of ["api", "bot", "worker", "console"]) {
    items.push({
      kind: "Deployment",
      metadata: { name: `discord-ai-agent-${component}`, generation: 2 },
      spec: {
        replicas: 1,
        template: { spec: { containers: [{ name: component, image: "registry.example/app:revision-a", env: [{ name: "APP_REVISION", value: "revision-a" }] }] } },
      },
      status: { observedGeneration: 2, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    });
    items.push({
      kind: "Pod",
      metadata: { name: `discord-ai-agent-${component}-pod`, labels: { "app.kubernetes.io/component": component } },
      spec: { containers: [{ name: component, image: "registry.example/app:revision-a" }] },
      status: { containerStatuses: [{ name: component, ready: true, restartCount: 0 }] },
    });
  }
  return { items };
}
