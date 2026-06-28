import pino from "pino";
import { loadConfig } from "../config/env.js";
import { currentTraceContext } from "./trace.js";

const config = loadConfig();

export function durationMs(startedAt: number) {
  return Date.now() - startedAt;
}

export function previewText(text: string | undefined | null, maxLength = 220) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export const logger = pino({
  level: config.logLevel,
  mixin() {
    return currentTraceContext() ?? {};
  },
  redact: {
    paths: [
      "discord.token",
      "openRouter.apiKey",
      "github.token",
      "apiKey",
      "token",
      "authorization",
      "*.token",
      "*.authorization",
      "headers.authorization",
      "headers.Authorization"
    ],
    censor: "[redacted]"
  },
  transport:
    config.nodeEnv === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            singleLine: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname"
          }
        }
      : undefined
});
