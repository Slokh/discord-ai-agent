import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/env.js";

const STALE_WORKSPACE_MS = 6 * 60 * 60 * 1000;

type CacheEntry = {
  name: string;
  path: string;
  exists: boolean;
  entries: number;
  bytes: number;
};

async function main() {
  const command = process.argv[2] ?? "status";
  const config = loadConfig();
  const cacheDir = process.env.SANDBOX_CACHE_DIR || config.execution.sandbox.cacheDir;
  const workspaceRoot = path.join(os.tmpdir(), "discord-ai-agent-workspaces");

  if (command === "status") {
    const entries = await inspectCache(cacheDir);
    process.stdout.write(`Sandbox cache: ${cacheDir}\n`);
    for (const entry of entries) {
      process.stdout.write(
        `- ${entry.name}: ${entry.exists ? `${entry.entries} entries, ${formatBytes(entry.bytes)}` : "missing"} (${entry.path})\n`
      );
    }
    process.stdout.write(`Workspace root: ${workspaceRoot}\n`);
    return;
  }

  if (command === "prune") {
    const removed = await pruneWorkspaces(workspaceRoot);
    process.stdout.write(`Pruned ${removed} stale sandbox workspace director${removed === 1 ? "y" : "ies"} from ${workspaceRoot}.\n`);
    return;
  }

  if (command === "clear") {
    if (!process.argv.includes("--yes")) {
      throw new Error("Refusing to clear the sandbox cache without --yes.");
    }
    await fs.rm(cacheDir, { recursive: true, force: true });
    const removed = await pruneWorkspaces(workspaceRoot, { removeAll: true });
    process.stdout.write(`Cleared sandbox cache ${cacheDir} and removed ${removed} workspace director${removed === 1 ? "y" : "ies"}.\n`);
    return;
  }

  throw new Error(`Unknown command "${command}". Use status, prune, or clear --yes.`);
}

async function inspectCache(cacheDir: string): Promise<CacheEntry[]> {
  const names = ["repos", "npm", "node_modules", "locks"];
  return Promise.all(
    names.map(async (name) => {
      const entryPath = path.join(cacheDir, name);
      if (!(await pathExists(entryPath))) {
        return { name, path: entryPath, exists: false, entries: 0, bytes: 0 };
      }
      const [entries, bytes] = await Promise.all([countChildren(entryPath), directorySize(entryPath)]);
      return { name, path: entryPath, exists: true, entries, bytes };
    })
  );
}

async function countChildren(dir: string) {
  return (await fs.readdir(dir).catch(() => [])).length;
}

async function directorySize(target: string): Promise<number> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  const children = await fs.readdir(target).catch(() => []);
  const sizes = await Promise.all(children.map((child) => directorySize(path.join(target, child))));
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function pruneWorkspaces(workspaceRoot: string, options: { removeAll?: boolean } = {}) {
  if (!(await pathExists(workspaceRoot))) return 0;
  const cutoff = Date.now() - STALE_WORKSPACE_MS;
  let removed = 0;
  const repoDirs = await fs.readdir(workspaceRoot, { withFileTypes: true }).catch(() => []);
  for (const repoDir of repoDirs) {
    if (!repoDir.isDirectory()) continue;
    const repoPath = path.join(workspaceRoot, repoDir.name);
    const taskDirs = await fs.readdir(repoPath, { withFileTypes: true }).catch(() => []);
    for (const taskDir of taskDirs) {
      if (!taskDir.isDirectory() || !taskDir.name.startsWith("task-")) continue;
      const taskPath = path.join(repoPath, taskDir.name);
      const stat = await fs.stat(taskPath).catch(() => null);
      if (!options.removeAll && (!stat || stat.mtimeMs > cutoff)) continue;
      await fs.rm(taskPath, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KiB";
  for (const candidate of units) {
    unit = candidate;
    if (value < 1024 || candidate === units[units.length - 1]) break;
    value /= 1024;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
