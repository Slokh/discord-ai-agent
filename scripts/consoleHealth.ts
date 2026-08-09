import path from "node:path";
import { fileURLToPath } from "node:url";

export type ConsoleHealthResult = {
  status: "healthy" | "unhealthy";
  checkedAt: string;
  revision: string;
  checks: Array<{ name: string; status: "passed" | "failed"; durationMs: number | null; code: string }>;
  activity: { sampled: boolean; detailSampled: boolean };
};

export type ConsoleHealthInput = {
  expectedRevision: string;
  internalUrl?: string | null;
  publicUrl?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxAgeMs?: number;
  maxLatencyMs?: number;
  timeoutMs?: number;
};

export async function waitForConsoleHealth(input: ConsoleHealthInput & {
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<ConsoleHealthResult> {
  const attempts = Math.max(1, Math.trunc(input.attempts ?? 1));
  const retryDelayMs = Math.max(0, Math.trunc(input.retryDelayMs ?? 0));
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let result: ConsoleHealthResult | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await checkConsoleHealth(input);
    if (result.status === "healthy") return result;
    if (attempt < attempts && retryDelayMs > 0) await sleep(retryDelayMs);
  }
  return result!;
}

export async function checkConsoleHealth(input: ConsoleHealthInput): Promise<ConsoleHealthResult> {
  if (!input.internalUrl && !input.publicUrl) throw new Error("At least one Console health endpoint is required.");
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const maxAgeMs = input.maxAgeMs ?? 120_000;
  const maxLatencyMs = input.maxLatencyMs ?? 4_000;
  const timeoutMs = input.timeoutMs ?? 8_000;
  const checks: ConsoleHealthResult["checks"] = [];
  const request = async (name: string, url: URL) => {
    const startedAt = performance.now();
    try {
      const response = await fetchImpl(url, {
        cache: "no-store",
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
      return { response, durationMs, slow: durationMs > maxLatencyMs };
    } catch {
      checks.push({ name, status: "failed", durationMs: null, code: "request_failed" });
      return null;
    }
  };
  const record = (name: string, durationMs: number, passed: boolean, code: string, slow: boolean) => {
    checks.push({
      name,
      status: passed && !slow ? "passed" : "failed",
      durationMs,
      code: slow && passed ? "latency_budget_exceeded" : code,
    });
  };

  if (input.publicUrl) {
    const publicBase = checkedHttpUrl(input.publicUrl, "publicUrl");
    const health = await request("public_health", new URL("/healthz", publicBase));
    if (health) {
      const payload = await health.response.json().catch(() => null) as { ok?: unknown } | null;
      record("public_health", health.durationMs, health.response.status === 200 && payload?.ok === true, "invalid_health_response", health.slow);
    }
    const page = await request("public_auth_redirect", new URL("/", publicBase));
    if (page) {
      const location = page.response.headers.get("location") ?? "";
      record("public_auth_redirect", page.durationMs, page.response.status === 302 && location.startsWith("/auth/login?"), "auth_redirect_missing", page.slow);
    }
    const api = await request("public_api_boundary", new URL("/api/overview", publicBase));
    if (api) {
      const payload = await api.response.json().catch(() => null) as { error?: unknown } | null;
      record("public_api_boundary", api.durationMs, api.response.status === 401 && payload?.error === "authentication_required", "api_not_protected", api.slow);
    }
  }

  let activitySampled = false;
  let activityStory: { kind: string; id: string } | null = null;
  if (input.internalUrl) {
    const internalBase = checkedHttpUrl(input.internalUrl, "internalUrl");
    const overview = await request("production_overview", new URL("/api/overview", internalBase));
    if (overview) {
      const payload = await overview.response.json().catch(() => null) as Record<string, unknown> | null;
      const generatedAt = Date.parse(String(payload?.generatedAt ?? ""));
      const fresh = Number.isFinite(generatedAt) && Math.abs(now() - generatedAt) <= maxAgeMs;
      const valid = overview.response.status === 200
        && payload?.schemaVersion === 3
        && payload?.environment === "production"
        && payload?.revision === input.expectedRevision
        && fresh;
      const code = payload?.revision !== input.expectedRevision ? "revision_mismatch" : !fresh ? "projection_stale" : "invalid_overview";
      record("production_overview", overview.durationMs, valid, code, overview.slow);
    }
    const activity = await request("production_activity", new URL("/api/activity?types=conversation,improvement,code_change&limit=1", internalBase));
    if (activity) {
      const payload = await activity.response.json().catch(() => null) as Record<string, unknown> | null;
      const rows = [...array(payload?.active), ...array(payload?.recent)];
      const candidate = rows.find((row) => typeof row.kind === "string" && typeof row.id === "string");
      activityStory = candidate ? { kind: String(candidate.kind), id: String(candidate.id) } : null;
      const valid = activity.response.status === 200 && payload?.schemaVersion === 3 && payload?.environment === "production";
      activitySampled = valid;
      record("production_activity", activity.durationMs, valid, "invalid_activity", activity.slow);
    }
    if (activityStory) {
      const detailUrl = new URL(`/api/activity/${encodeURIComponent(activityStory.kind)}/${encodeURIComponent(activityStory.id)}`, internalBase);
      const detail = await request("production_activity_detail", detailUrl);
      if (detail) {
        const payload = await detail.response.json().catch(() => null) as Record<string, unknown> | null;
        const valid = detail.response.status === 200
          && payload?.schemaVersion === 2
          && payload?.environment === "production"
          && payload?.kind === activityStory.kind
          && payload?.id === activityStory.id;
        record("production_activity_detail", detail.durationMs, valid, "invalid_activity_detail", detail.slow);
      }
    }
  }

  return {
    status: checks.every((check) => check.status === "passed") ? "healthy" : "unhealthy",
    checkedAt: new Date(now()).toISOString(),
    revision: input.expectedRevision,
    checks,
    activity: { sampled: activitySampled, detailSampled: Boolean(activityStory) },
  };
}

function checkedHttpUrl(value: string, name: string) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials.`);
  }
  return url;
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[++index];
    if (!name || !value) throw new Error(`Missing value for --${name || arg}`);
    values.set(name, value);
  }
  const expectedRevision = values.get("revision")?.trim();
  if (!expectedRevision) throw new Error("--revision is required.");
  return {
    expectedRevision,
    internalUrl: values.get("internal-url") ?? "http://127.0.0.1:8081",
    publicUrl: values.get("public-url") ?? null,
    maxAgeMs: numberArg(values.get("max-age-ms") ?? "120000", "max-age-ms"),
    maxLatencyMs: numberArg(values.get("max-latency-ms") ?? "4000", "max-latency-ms"),
  };
}

function numberArg(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive number.`);
  return parsed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  checkConsoleHealth(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status !== "healthy") process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
