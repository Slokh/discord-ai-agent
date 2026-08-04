import type { DiscordAiAgentRepository } from "../db/repositories.js";

type PromotionRepo = Pick<DiscordAiAgentRepository, "isDeploymentVerified">;

export async function waitForDeploymentPromotion(input: {
  repo: PromotionRepo;
  revision: string;
  deploymentId?: string | null;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  if (!/^[a-f0-9]{40}$/i.test(input.revision)) return true;
  if (!input.deploymentId?.trim()) return false;
  const timeoutMs = Math.max(0, input.timeoutMs ?? 45 * 60_000);
  const intervalMs = Math.max(250, input.intervalMs ?? 5_000);
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await input.repo.isDeploymentVerified({ revision: input.revision, deploymentId: input.deploymentId })) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}
