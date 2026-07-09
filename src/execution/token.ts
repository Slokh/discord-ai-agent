import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SIGNATURE_SKEW_MS = 10 * 60 * 1000;

export function taskBearerToken(input: { taskId: string; sandboxRunId: string; secret: string; issuedAt?: number }) {
  const issuedAt = input.issuedAt ?? Date.now();
  const payload = `${input.taskId}.${input.sandboxRunId}.${issuedAt}`;
  const signature = createHmac("sha256", input.secret).update(payload).digest("hex");
  return `${issuedAt}.${signature}`;
}

export function verifyTaskBearerToken(input: { taskId: string; sandboxRunId: string; secret: string; token: string | undefined; now?: number; ttlMs?: number }) {
  if (!input.token) return false;
  const [issuedAtText, actualSignature] = input.token.split(".");
  const issuedAt = Number(issuedAtText);
  if (!Number.isFinite(issuedAt) || !actualSignature) return false;
  const now = input.now ?? Date.now();
  if (issuedAt > now + DEFAULT_SIGNATURE_SKEW_MS || now - issuedAt > (input.ttlMs ?? DEFAULT_TOKEN_TTL_MS)) return false;
  const expectedToken = taskBearerToken({ taskId: input.taskId, sandboxRunId: input.sandboxRunId, secret: input.secret, issuedAt });
  const expected = Buffer.from(expectedToken, "utf8");
  const actual = Buffer.from(input.token, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function callbackBodySignature(input: { secret: string; timestamp: string; rawBody: Buffer | string }) {
  return createHmac("sha256", input.secret).update(`${input.timestamp}.`).update(input.rawBody).digest("hex");
}

export function verifyCallbackBodySignature(input: {
  secret: string;
  timestamp: string | undefined;
  rawBody: Buffer;
  signature: string | undefined;
  now?: number;
  skewMs?: number;
}) {
  if (!input.timestamp || !input.signature) return false;
  const timestampMs = Number(input.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  const now = input.now ?? Date.now();
  if (Math.abs(now - timestampMs) > (input.skewMs ?? DEFAULT_SIGNATURE_SKEW_MS)) return false;
  const expected = Buffer.from(callbackBodySignature({ secret: input.secret, timestamp: input.timestamp, rawBody: input.rawBody }), "utf8");
  const actual = Buffer.from(input.signature, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
