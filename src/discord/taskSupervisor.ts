import type { Logger } from "pino";

export type DiscordTaskKind = "request" | "maintenance";

export type DiscordTaskSupervisorSnapshot = {
  accepting: boolean;
  active: number;
  activeByKind: Record<DiscordTaskKind, number>;
};

type ActiveTask = { kind: DiscordTaskKind; label: string; promise: Promise<void> };

/**
 * Owns admission, failure isolation, and graceful draining for every asynchronous
 * Discord gateway or startup task. EventEmitter does not await listener promises,
 * so allowing listeners to manage this independently makes shutdown inherently racy.
 */
export class DiscordTaskSupervisor {
  private accepting = true;
  private readonly active = new Set<ActiveTask>();

  constructor(private readonly logger: Logger) {}

  run(input: {
    kind: DiscordTaskKind;
    label: string;
    task: () => Promise<void>;
    onRejected?: () => Promise<void>;
    logContext?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.accepting) {
      this.logger.info({ taskKind: input.kind, taskLabel: input.label, ...input.logContext }, "Ignoring Discord task while bot is draining");
      return input.onRejected?.().catch((error) => {
        this.logger.warn({ err: error, taskKind: input.kind, taskLabel: input.label }, "Failed to reject Discord task during drain");
      }) ?? Promise.resolve();
    }

    const activeTask: ActiveTask = {
      kind: input.kind,
      label: input.label,
      promise: Promise.resolve(),
    };
    activeTask.promise = Promise.resolve()
      .then(input.task)
      .catch((error) => {
        this.logger.error({ err: error, taskKind: input.kind, taskLabel: input.label, ...input.logContext }, "Discord task failed");
      })
      .finally(() => this.active.delete(activeTask));
    this.active.add(activeTask);
    return activeTask.promise;
  }

  async drain(timeoutMs = 30_000): Promise<void> {
    this.accepting = false;
    if (this.active.size === 0) return;
    this.logger.info({ ...this.snapshot(), timeoutMs }, "Waiting for active Discord tasks to drain");
    let timedOut = false;
    await Promise.race([
      Promise.allSettled([...this.active].map((task) => task.promise)),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (timedOut && this.active.size > 0) {
      this.logger.warn({ ...this.snapshot(), timeoutMs, activeLabels: [...this.active].map((task) => task.label) }, "Discord task drain timed out");
    }
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  snapshot(): DiscordTaskSupervisorSnapshot {
    let requests = 0;
    let maintenance = 0;
    for (const task of this.active) {
      if (task.kind === "request") requests += 1;
      else maintenance += 1;
    }
    return { accepting: this.accepting, active: this.active.size, activeByKind: { request: requests, maintenance } };
  }
}
