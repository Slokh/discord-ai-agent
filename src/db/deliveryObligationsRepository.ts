import type { DbPool } from "./pool.js";

export type DiscordDeliveryObligationState = "pending" | "delivered" | "abandoned";

export type DiscordDeliveryObligationRecord = {
  executionId: string;
  threadKey: string | null;
  guildId: string;
  channelId: string;
  statusChannelId: string | null;
  statusMessageId: string | null;
  sourceMessageId: string;
  state: DiscordDeliveryObligationState;
  createdAt: Date;
  updatedAt: Date;
  lastError: string | null;
  metadata: Record<string, unknown>;
};

export class DeliveryObligationsRepository {
  constructor(private readonly pool: DbPool) {}

  async upsertPending(input: {
    executionId: string;
    threadKey?: string | null;
    guildId: string;
    channelId: string;
    statusChannelId?: string | null;
    statusMessageId?: string | null;
    sourceMessageId: string;
    metadata?: Record<string, unknown>;
  }): Promise<DiscordDeliveryObligationRecord> {
    const result = await this.pool.query(
      `
        INSERT INTO discord_delivery_obligations(
          execution_id, thread_key, guild_id, channel_id, status_channel_id,
          status_message_id, source_message_id, state, last_error, metadata, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NULL, $8::jsonb, now())
        ON CONFLICT(execution_id) DO UPDATE SET
          thread_key = coalesce(EXCLUDED.thread_key, discord_delivery_obligations.thread_key),
          guild_id = EXCLUDED.guild_id,
          channel_id = EXCLUDED.channel_id,
          status_channel_id = coalesce(EXCLUDED.status_channel_id, discord_delivery_obligations.status_channel_id),
          status_message_id = coalesce(EXCLUDED.status_message_id, discord_delivery_obligations.status_message_id),
          source_message_id = EXCLUDED.source_message_id,
          state = 'pending',
          last_error = NULL,
          metadata = discord_delivery_obligations.metadata || EXCLUDED.metadata,
          updated_at = now()
        RETURNING *
      `,
      [input.executionId, input.threadKey ?? null, input.guildId, input.channelId, input.statusChannelId ?? null, input.statusMessageId ?? null, input.sourceMessageId, JSON.stringify(input.metadata ?? {})]
    );
    return rowToObligation(result.rows[0]);
  }

  async markDelivered(input: { executionId: string; statusChannelId?: string | null; statusMessageId?: string | null; metadata?: Record<string, unknown> }) {
    return this.markState({ ...input, state: "delivered", lastError: null });
  }

  async markAbandoned(input: { executionId: string; error?: string | null; metadata?: Record<string, unknown> }) {
    return this.markState({ executionId: input.executionId, state: "abandoned", lastError: input.error ?? null, metadata: input.metadata });
  }

  async listPendingOlderThan(input: { olderThanMs: number; limit?: number }): Promise<DiscordDeliveryObligationRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM discord_delivery_obligations WHERE state = 'pending' AND updated_at <= now() - ($1::int * interval '1 millisecond') ORDER BY updated_at ASC LIMIT $2`,
      [Math.max(0, Math.trunc(input.olderThanMs)), Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)))]
    );
    return result.rows.map(rowToObligation);
  }

  async getByExecutionId(executionId: string): Promise<DiscordDeliveryObligationRecord | undefined> {
    const result = await this.pool.query(`SELECT * FROM discord_delivery_obligations WHERE execution_id = $1`, [executionId]);
    return result.rows[0] ? rowToObligation(result.rows[0]) : undefined;
  }

  private async markState(input: { executionId: string; state: DiscordDeliveryObligationState; statusChannelId?: string | null; statusMessageId?: string | null; lastError?: string | null; metadata?: Record<string, unknown> }) {
    const result = await this.pool.query(
      `
        UPDATE discord_delivery_obligations
        SET state = $2,
            status_channel_id = coalesce($3, status_channel_id),
            status_message_id = coalesce($4, status_message_id),
            last_error = $5,
            metadata = metadata || $6::jsonb,
            updated_at = now()
        WHERE execution_id = $1
        RETURNING *
      `,
      [input.executionId, input.state, input.statusChannelId ?? null, input.statusMessageId ?? null, input.lastError ?? null, JSON.stringify(input.metadata ?? {})]
    );
    return result.rows[0] ? rowToObligation(result.rows[0]) : undefined;
  }
}

function rowToObligation(row: any): DiscordDeliveryObligationRecord {
  return {
    executionId: String(row.execution_id),
    threadKey: row.thread_key == null ? null : String(row.thread_key),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    statusChannelId: row.status_channel_id == null ? null : String(row.status_channel_id),
    statusMessageId: row.status_message_id == null ? null : String(row.status_message_id),
    sourceMessageId: String(row.source_message_id),
    state: row.state,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    metadata: row.metadata ?? {}
  };
}
