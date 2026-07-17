import type { WagerHistoryEntry } from "../payments/types.js";
import { mapWager } from "./paymentRowMappers.js";
import type { DbPool } from "./pool.js";

export type WagerHistoryQuery = {
  guildId: string;
  requestedByUserId: string;
  game?: string;
  limit?: number;
};

export async function listWagerHistory(
  pool: DbPool,
  input: WagerHistoryQuery,
): Promise<{ entries: WagerHistoryEntry[]; hasMore: boolean }> {
  const game = input.game?.trim() || null;
  const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
  const result = await pool.query(
    `
      SELECT wager.*, draw.kind AS draw_kind, draw.outcome AS draw_outcome, draw.reason AS draw_reason
      FROM wallet_wager_reservations wager
      LEFT JOIN rng_draws draw ON draw.id = wager.draw_id
      WHERE wager.guild_id = $1
        AND wager.requested_by_user_id = $2
        AND ($3::text IS NULL OR wager.game ILIKE '%' || $3 || '%')
      ORDER BY wager.created_at DESC
      LIMIT $4
    `,
    [input.guildId, input.requestedByUserId, game, limit + 1],
  );
  return {
    entries: result.rows.slice(0, limit).map((row) => ({
      wager: mapWager(row),
      draw: row.draw_kind == null ? null : {
        kind: String(row.draw_kind),
        outcome: isRecord(row.draw_outcome) ? row.draw_outcome : {},
        reason: row.draw_reason == null ? null : String(row.draw_reason),
      },
    })),
    hasMore: result.rows.length > limit,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
