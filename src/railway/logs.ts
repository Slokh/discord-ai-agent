import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "../config/env.js";

const execFileAsync = promisify(execFile);

export const RAILWAY_LOG_SERVICES = ["discord-ai-agent-bot", "discord-ai-agent-worker"] as const;
export type RailwayLogService = (typeof RAILWAY_LOG_SERVICES)[number];

export type RailwayLogQuery = {
  service?: string;
  since?: string;
  lines?: number;
  filter?: string;
};

export type RailwayLogEntry = {
  timestamp: string | null;
  level: string | null;
  message: string;
  traceId: string | null;
  requestId: string | null;
  messageId: string | null;
  durationMs: number | null;
  raw: Record<string, unknown>;
};

export type RailwayLogResult = {
  service: RailwayLogService;
  since: string;
  lines: number;
  filter: string | null;
  entries: RailwayLogEntry[];
  stderr: string;
};

const DEFAULT_SERVICE: RailwayLogService = "discord-ai-agent-bot";
const DEFAULT_SINCE = "30m";
const DEFAULT_LINES = 100;
const MAX_LINES = 200;
const MAX_SINCE_SECONDS = 6 * 60 * 60;
const MAX_FILTER_CHARS = 240;
const COMMAND_TIMEOUT_MS = 25_000;

export async function fetchRailwayLogs(config: AppConfig["railway"], query: RailwayLogQuery): Promise<RailwayLogResult> {
  if (!config.token) {
    throw new Error("RAILWAY_TOKEN is required for Railway log access.");
  }
  const service = normalizeRailwayLogService(query.service);
  const since = normalizeSince(query.since);
  const lines = normalizeLines(query.lines);
  const filter = normalizeFilter(query.filter);

  const args = [
    "-y",
    "@railway/cli@latest",
    "logs",
    "--json",
    "--project",
    config.projectId,
    "--environment",
    config.environment,
    "--service",
    service,
    "--since",
    since,
    "--lines",
    String(lines)
  ];
  if (filter) args.push("--filter", filter);

  const { stdout, stderr } = await execFileAsync("npx", args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      RAILWAY_TOKEN: config.token,
      NO_COLOR: "1"
    }
  });

  return {
    service,
    since,
    lines,
    filter: filter ?? null,
    entries: parseRailwayLogJsonLines(stdout),
    stderr: redactSecrets(stderr.trim())
  };
}

export function normalizeRailwayLogService(value: string | undefined): RailwayLogService {
  if (!value) return DEFAULT_SERVICE;
  if ((RAILWAY_LOG_SERVICES as readonly string[]).includes(value)) return value as RailwayLogService;
  throw new Error(`Unsupported Railway service "${value}". Allowed: ${RAILWAY_LOG_SERVICES.join(", ")}.`);
}

export function normalizeSince(value: string | undefined): string {
  if (!value) return DEFAULT_SINCE;
  const match = value.trim().match(/^(\d+)(s|m|h)$/i);
  if (!match) throw new Error("Railway log since must be relative time like 30s, 15m, or 2h.");
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const seconds = unit === "h" ? amount * 3600 : unit === "m" ? amount * 60 : amount;
  if (!Number.isInteger(amount) || amount <= 0 || seconds > MAX_SINCE_SECONDS) {
    throw new Error("Railway log since must be greater than 0 and no more than 6h.");
  }
  return `${amount}${unit}`;
}

export function normalizeLines(value: number | undefined): number {
  if (value == null) return DEFAULT_LINES;
  if (!Number.isInteger(value) || value <= 0) throw new Error("Railway log lines must be a positive integer.");
  return Math.min(value, MAX_LINES);
}

export function normalizeFilter(value: string | undefined): string | undefined {
  const filter = value?.trim();
  if (!filter) return undefined;
  if (filter.length > MAX_FILTER_CHARS) throw new Error(`Railway log filter must be ${MAX_FILTER_CHARS} characters or fewer.`);
  return filter;
}

export function parseRailwayLogJsonLines(stdout: string): RailwayLogEntry[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        return [railwayLogEntryFromRaw(raw)];
      } catch {
        return [
          {
            timestamp: null,
            level: null,
            message: redactSecrets(line),
            traceId: null,
            requestId: null,
            messageId: null,
            durationMs: null,
            raw: {}
          }
        ];
      }
    });
}

function railwayLogEntryFromRaw(raw: Record<string, unknown>): RailwayLogEntry {
  return {
    timestamp: stringValue(raw.timestamp) ?? stringValue(raw.time),
    level: stringValue(raw.level),
    message: redactSecrets(stringValue(raw.message) ?? JSON.stringify(raw)),
    traceId: stringValue(raw.traceId),
    requestId: stringValue(raw.requestId),
    messageId: stringValue(raw.messageId),
    durationMs: numberValue(raw.durationMs),
    raw: redactObject(raw)
  };
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactUnknown(item)]));
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") return redactObject(value as Record<string, unknown>);
  return value;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[redacted-github-token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted-github-token]")
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+\b/g, "[redacted-openrouter-key]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted-discord-token]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+(@)/gi, "$1[redacted]$2")
    .replace(/(RAILWAY_TOKEN=)[^\s]+/gi, "$1[redacted]");
}
