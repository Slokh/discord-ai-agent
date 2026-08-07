import type { DbPool } from "./pool.js";

export type ServiceComponent = "bot" | "worker" | "api" | "console";

export class ServiceHeartbeatRepository {
  constructor(private readonly pool: DbPool) {}

  async pulse(input: {
    component: ServiceComponent;
    instanceId: string;
    revision: string;
    startedAt: Date;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO service_runtime_heartbeats(
         component,instance_id,revision,started_at,last_seen_at,metadata
       ) VALUES ($1,$2,$3,$4,now(),$5::jsonb)
       ON CONFLICT(component,instance_id) DO UPDATE SET
         revision = EXCLUDED.revision,
         started_at = EXCLUDED.started_at,
         last_seen_at = now(),
         metadata = EXCLUDED.metadata`,
      [input.component, input.instanceId, input.revision, input.startedAt, JSON.stringify(input.metadata ?? {})],
    );
    await this.pool.query("DELETE FROM service_runtime_heartbeats WHERE last_seen_at < now() - interval '7 days'");
  }

  async remove(component: ServiceComponent, instanceId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM service_runtime_heartbeats WHERE component = $1 AND instance_id = $2",
      [component, instanceId],
    );
  }
}
