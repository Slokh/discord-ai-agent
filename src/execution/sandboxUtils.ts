import { createHash } from "node:crypto";
import type { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export const MAX_CAPTURED_COMMAND_OUTPUT = 40_000;
export const MAX_ACTIVITY_COMMAND_OUTPUT = 12_000;
export const MAX_RECOVERY_TAIL = 10_000;

export function tail(value: string, maxChars: number) {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

export function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Buffer(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function conciseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.slice(0, 500) ?? "unknown error";
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function truncateSingleLine(value: string, maxLength: number) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function sanitizeStepName(value: string) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "event";
}

export function compactJson(value: unknown, maxChars = 1200) {
  if (value == null) return null;
  const text = JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

export function jsonStringAt(value: unknown, keys: string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatToolNameList(tools: string[]) {
  if (tools.length <= 2) return tools.join(" and ");
  return `${tools.slice(0, 2).join(", ")} and ${tools.length - 2} more`;
}

export async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isInsidePath(root: string, candidate: string) {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export async function withDirectoryLock<T>(lockDir: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const staleAfterMs = 10 * 60 * 1000;
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const stat = await fs.stat(lockDir).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleAfterMs) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt > staleAfterMs) throw new Error(`Timed out waiting for cache lock ${lockDir}`);
      await sleep(500);
    }
  }

  try {
    return await run();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function reserveLocalPort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Unable to reserve a local port."));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

export function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Process did not exit within ${formatDuration(timeoutMs)}.`));
    }, timeoutMs);
    timeout.unref?.();
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}
