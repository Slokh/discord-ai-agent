import type { DiscordAiAgentRepository } from "../db/repositories.js";

const DEFAULT_CAPACITY_POLL_MS = 2_000;

type SandboxCapacityRepository = Pick<DiscordAiAgentRepository, "listActiveSandboxRuns">;
type AgentTaskCompletionRepository = Pick<DiscordAiAgentRepository, "getAgentTask">;

export async function waitForAgentTaskCapacity(input: {
  repo: SandboxCapacityRepository | undefined;
  backend: string;
  maxConcurrent: number;
  pollMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
  onWait?: (activeCount: number) => Promise<void> | void;
}) {
  if (!input.repo) return;
  const maxConcurrent = Math.max(1, Math.trunc(input.maxConcurrent));
  const pollMs = Math.max(10, Math.trunc(input.pollMs ?? DEFAULT_CAPACITY_POLL_MS));
  const sleep = input.sleep ?? ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  let announcedWait = false;

  while (true) {
    const active = await input.repo.listActiveSandboxRuns({ backend: input.backend, limit: maxConcurrent });
    if (active.length < maxConcurrent) return;
    if (!announcedWait) {
      announcedWait = true;
      await input.onWait?.(active.length);
    }
    await sleep(pollMs);
  }
}

export async function waitForAgentTaskTerminal(input: {
  repo: AgentTaskCompletionRepository | undefined;
  taskId: string;
  pollMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
}) {
  if (!input.repo) return;
  const pollMs = Math.max(10, Math.trunc(input.pollMs ?? DEFAULT_CAPACITY_POLL_MS));
  const sleep = input.sleep ?? ((durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  while (true) {
    const task = await input.repo.getAgentTask(input.taskId);
    if (!task || isTerminalStatus(task.status)) return;
    await sleep(pollMs);
  }
}

function isTerminalStatus(status: string) {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
}
