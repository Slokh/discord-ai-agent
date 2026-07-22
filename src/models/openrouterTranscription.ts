import { durationMs, logger } from "../util/logger.js";

export type TranscriptionInput = {
  data: Buffer;
  format: string;
  model?: string;
  language?: string;
  signal?: AbortSignal;
};

export type TranscriptionResult = {
  text: string;
  model: string;
  raw: unknown;
  durationSeconds?: number;
  estimatedCostUsd?: number;
};

type Request = (
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  options: { retryPolicy: "expensive"; signal?: AbortSignal }
) => Promise<any>;

const TRANSCRIPTION_TIMEOUT_MS = 65_000;

export async function transcribeAudioViaOpenRouter(
  input: TranscriptionInput,
  configuredModel: string,
  request: Request
): Promise<TranscriptionResult> {
  const model = input.model ?? configuredModel;
  const startedAt = Date.now();
  logger.info({
    provider: "openrouter",
    operation: "transcription",
    model,
    format: input.format,
    inputBytes: input.data.length,
    language: input.language
  }, "OpenRouter transcription request");
  const body: Record<string, unknown> = {
    model,
    input_audio: { data: input.data.toString("base64"), format: input.format }
  };
  if (input.language) body.language = input.language;
  const json = await request("/audio/transcriptions", body, TRANSCRIPTION_TIMEOUT_MS, {
    retryPolicy: "expensive",
    signal: input.signal
  });
  const text = typeof json.text === "string" ? json.text.trim() : "";
  if (!text) throw new Error("OpenRouter transcription response did not include text.");
  const result: TranscriptionResult = {
    text,
    model: String(json.model ?? model),
    raw: json,
    durationSeconds: firstFiniteNumber(json?.usage?.seconds, json?.usage?.duration_seconds, json?.duration),
    estimatedCostUsd: firstFiniteNumber(
      json?.usage?.cost,
      json?.usage?.total_cost,
      json?.usage?.cost_usd,
      json?.usage?.total_cost_usd
    )
  };
  logger.info({
    provider: "openrouter",
    operation: "transcription",
    model: result.model,
    format: input.format,
    inputBytes: input.data.length,
    outputChars: result.text.length,
    durationSeconds: result.durationSeconds,
    durationMs: durationMs(startedAt),
    estimatedCostUsd: result.estimatedCostUsd
  }, "OpenRouter transcription response");
  return result;
}

function firstFiniteNumber(...values: unknown[]) {
  for (const value of values) {
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number === "number" && Number.isFinite(number)) return number;
  }
  return undefined;
}
