import { randomUUID } from "node:crypto";
import type { ImprovementCaseStatus } from "./types.js";
import type { DbPool } from "./pool.js";
import type { ImprovementProofTrigger } from "../improvements/proofAdapterTypes.js";
import type { ImprovementProofProducerHealth } from "./improvementProofProducerRepository.js";

const MAX_DELIVERY_ATTEMPTS = 3;

export type ImprovementBotUpdate = {
  updateId: string;
  caseId: string;
  sourceKey: string;
  producerTrigger: ImprovementProofTrigger;
  livenessReason: ImprovementProducerUnhealthyReason;
  caseStatus: ImprovementCaseStatus;
  caseResolution: string | null;
  deliveryChannelId: string | null;
  deliveryMessageId: string | null;
  lastRenderedSignature: string | null;
};

type ImprovementProducerUnhealthyReason = Exclude<
  ImprovementProofProducerHealth["reason"],
  "current" | "not_yet_observed"
>;

/** Creates one content-free bot-channel projection for an unhealthy producer episode. */
export async function enqueueImprovementBotUpdate(pool: DbPool, input: {
  caseId: string;
  sourceKey: string;
  producerTrigger: ImprovementProofTrigger;
  livenessReason: ImprovementProducerUnhealthyReason;
}) {
  const result = await pool.query(
    `INSERT INTO improvement_bot_updates(
       update_id,case_id,source_key,producer_trigger,liveness_reason
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT(source_key) DO UPDATE SET source_key = EXCLUDED.source_key
     RETURNING update_id`,
    [`ibu-${randomUUID()}`, input.caseId, required(input.sourceKey, 300), input.producerTrigger, input.livenessReason],
  );
  return { updateId: String(result.rows[0].update_id) };
}

export async function listRenderableImprovementBotUpdates(pool: DbPool, limit = 50) {
  const result = await pool.query(
    `SELECT bot_update.*,case_row.status AS case_status,case_row.resolution AS case_resolution
     FROM improvement_bot_updates bot_update
     JOIN improvement_cases case_row ON case_row.case_id = bot_update.case_id
     WHERE bot_update.delivery_abandoned_at IS NULL
       AND (bot_update.next_delivery_at IS NULL OR bot_update.next_delivery_at <= now())
       AND (
         bot_update.last_rendered_at IS NULL
         OR greatest(bot_update.updated_at,case_row.updated_at) > bot_update.last_rendered_at
       )
     ORDER BY coalesce(bot_update.next_delivery_at,bot_update.updated_at),bot_update.update_id
     LIMIT $1`,
    [boundedLimit(limit)],
  );
  return result.rows.map(rowToBotUpdate);
}

export async function markImprovementBotUpdateRendered(pool: DbPool, input: {
  updateId: string;
  deliveryChannelId: string;
  deliveryMessageId: string;
  signature: string;
}) {
  await pool.query(
    `UPDATE improvement_bot_updates SET
       delivery_channel_id = $2,
       delivery_message_id = $3,
       last_rendered_signature = $4,
       last_rendered_at = now(),
       delivery_attempts = 0,
       last_delivery_error = NULL,
       next_delivery_at = NULL,
       delivery_abandoned_at = NULL,
       updated_at = now()
     WHERE update_id = $1`,
    [input.updateId, input.deliveryChannelId, input.deliveryMessageId, input.signature],
  );
}

export async function markImprovementBotUpdateDeliveryFailed(pool: DbPool, input: {
  updateId: string;
  error: string;
  retryAt: Date;
}) {
  const result = await pool.query(
    `UPDATE improvement_bot_updates SET
       delivery_attempts = delivery_attempts + 1,
       last_delivery_error = $2,
       next_delivery_at = CASE WHEN delivery_attempts + 1 >= $4 THEN NULL ELSE $3 END,
       delivery_abandoned_at = CASE WHEN delivery_attempts + 1 >= $4 THEN now() ELSE NULL END,
       updated_at = now()
     WHERE update_id = $1
     RETURNING delivery_attempts,delivery_abandoned_at`,
    [input.updateId, input.error.slice(0, 1_000), input.retryAt, MAX_DELIVERY_ATTEMPTS],
  );
  return {
    attempts: Number(result.rows[0]?.delivery_attempts ?? 0),
    abandoned: result.rows[0]?.delivery_abandoned_at != null,
  };
}

function rowToBotUpdate(row: Record<string, unknown>): ImprovementBotUpdate {
  return {
    updateId: String(row.update_id),
    caseId: String(row.case_id),
    sourceKey: String(row.source_key),
    producerTrigger: String(row.producer_trigger) as ImprovementProofTrigger,
    livenessReason: String(row.liveness_reason) as ImprovementProducerUnhealthyReason,
    caseStatus: String(row.case_status) as ImprovementCaseStatus,
    caseResolution: row.case_resolution == null ? null : String(row.case_resolution),
    deliveryChannelId: row.delivery_channel_id == null ? null : String(row.delivery_channel_id),
    deliveryMessageId: row.delivery_message_id == null ? null : String(row.delivery_message_id),
    lastRenderedSignature: row.last_rendered_signature == null ? null : String(row.last_rendered_signature),
  };
}

function required(value: string, max: number) {
  const normalized = value.trim().slice(0, max);
  if (!normalized) throw new Error("sourceKey is required.");
  return normalized;
}

function boundedLimit(value: number) {
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(value)));
}
