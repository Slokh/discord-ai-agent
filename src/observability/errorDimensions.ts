const SAFE_TOKEN = /[^a-z0-9_.:-]+/g;

/** Returns content-free, bounded dimensions suitable for grouping retained failures. */
export function runtimeErrorDimensions(error: unknown) {
  const record = object(error);
  const rawKind = error instanceof Error
    ? error.name || error.constructor?.name
    : typeof record.name === "string"
      ? record.name
      : typeof error;
  const errorKind = stableToken(rawKind, "unknown_error");
  const errorCode = typeof record.code === "string" ? stableToken(record.code, "unknown") : null;
  const rawStatus = record.status;
  const errorStatus = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : null;
  return {
    errorKind,
    ...(errorCode ? { errorCode } : {}),
    ...(errorStatus ? { errorStatus } : {}),
  };
}

function stableToken(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  return value.trim().toLowerCase().replace(SAFE_TOKEN, "_").replace(/^_+|_+$/g, "").slice(0, 100) || fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" ? value as Record<string, unknown> : {};
}
