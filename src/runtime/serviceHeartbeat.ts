import { hostname } from "node:os";
import type { AppConfig } from "../config/env.js";
import type { ServiceComponent, ServiceHeartbeatRepository } from "../db/serviceHeartbeatRepository.js";
import { logger } from "../util/logger.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

export async function startServiceHeartbeat(input: {
  components: ServiceComponent[];
  config: AppConfig;
  repository: ServiceHeartbeatRepository;
}) {
  const instanceId = `${hostname()}:${process.pid}`;
  const startedAt = new Date();
  let stopped = false;
  let running = false;

  const pulse = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await Promise.all(input.components.map((component) => input.repository.pulse({
        component,
        instanceId,
        revision: input.config.appRevision,
        startedAt,
      })));
    } catch (error) {
      logger.warn({ err: error, components: input.components }, "Service heartbeat failed");
    } finally {
      running = false;
    }
  };

  await pulse();
  const timer = setInterval(() => void pulse(), HEARTBEAT_INTERVAL_MS);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await Promise.all(input.components.map((component) => input.repository.remove(component, instanceId)));
    },
  };
}
