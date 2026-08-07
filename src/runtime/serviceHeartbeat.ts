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
  let inFlight: Promise<void> | null = null;

  const pulse = () => {
    if (stopped || inFlight) return inFlight;
    inFlight = Promise.all(input.components.map((component) => input.repository.pulse({
      component,
      instanceId,
      revision: input.config.appRevision,
      startedAt,
    })))
      .then(() => undefined)
      .catch((error) => {
        logger.warn({ err: error, components: input.components }, "Service heartbeat failed");
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  void pulse();
  const timer = setInterval(() => void pulse(), HEARTBEAT_INTERVAL_MS);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      await Promise.all(input.components.map((component) => input.repository.remove(component, instanceId)));
    },
  };
}
