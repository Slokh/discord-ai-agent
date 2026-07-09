import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { progress } from "./callbacks.js";
import { runCommand } from "./commands.js";
import type { SandboxCachePaths } from "./repoWorkspace.js";
import type { SandboxEnv } from "./sandboxEnv.js";
import { conciseError, isInsidePath, pathExists, sha256Buffer, withDirectoryLock } from "./sandboxUtils.js";

const DEPENDENCY_CACHE_MODE = "devdeps-v1";

export async function prepareDependencies(input: {
  env: SandboxEnv;
  cache: SandboxCachePaths;
  checkoutDir: string;
  reason?: string;
}): Promise<{ cacheStatus: "hit" | "miss"; lockHash: string }> {
  await fs.mkdir(input.cache.npmCacheDir, { recursive: true });
  await fs.mkdir(input.cache.nodeModulesDir, { recursive: true });
  await fs.mkdir(input.cache.locksDir, { recursive: true });
  const lockHash = await dependencyCacheKey(input.checkoutDir);
  const nodeModulesPath = path.join(input.checkoutDir, "node_modules");
  const cachedNodeModulesPath = path.join(input.cache.nodeModulesDir, lockHash);
  const lockDir = path.join(input.cache.locksDir, `${lockHash}.node-modules.lock`);

  if (await pathExists(cachedNodeModulesPath)) {
    const restored = await restoreCachedNodeModules({
      env: input.env,
      lockHash,
      reason: input.reason,
      cachedNodeModulesPath,
      nodeModulesPath
    });
    if (restored) return { cacheStatus: "hit", lockHash };
  }

  let cacheStatus: "hit" | "miss" = "miss";
  await withDirectoryLock(lockDir, async () => {
    if (await pathExists(cachedNodeModulesPath)) {
      const restored = await restoreCachedNodeModules({
        env: input.env,
        lockHash,
        reason: input.reason,
        cachedNodeModulesPath,
        nodeModulesPath
      });
      if (restored) {
        cacheStatus = "hit";
        return;
      }
    }

    await progress(input.env, "dependency_cache_miss", "Dependency cache miss; installing with persistent npm cache.", {
      lockHash,
      cacheType: "dependencies",
      cacheStatus: "miss",
      reason: input.reason
    });
    await runCommand("npm", ["ci", "--include=dev", "--cache", input.cache.npmCacheDir, "--prefer-offline", "--no-audit", "--fund=false"], {
      cwd: input.checkoutDir,
      env: codegenNpmInstallEnv(process.env),
      taskEnv: input.env,
      step: "dependencies"
    });
    const tempCachePath = path.join(input.cache.nodeModulesDir, `.tmp-${lockHash}-${randomUUID()}`);
    await fs.rm(tempCachePath, { recursive: true, force: true }).catch(() => undefined);
    await fs.cp(nodeModulesPath, tempCachePath, { recursive: true, verbatimSymlinks: true });
    await fs.rename(tempCachePath, cachedNodeModulesPath).catch(async (error: NodeJS.ErrnoException) => {
      await fs.rm(tempCachePath, { recursive: true, force: true }).catch(() => undefined);
      if (error.code !== "EEXIST") throw error;
    });
  });
  return { cacheStatus, lockHash };
}

async function restoreCachedNodeModules(input: {
  env: SandboxEnv;
  lockHash: string;
  reason?: string;
  cachedNodeModulesPath: string;
  nodeModulesPath: string;
}) {
  await progress(input.env, "dependency_cache_hit", "Restoring node_modules from the dependency cache.", {
    lockHash: input.lockHash,
    cacheType: "dependencies",
    cacheStatus: "hit",
    reason: input.reason
  });
  await fs.rm(input.nodeModulesPath, { recursive: true, force: true }).catch(() => undefined);
  try {
    await fs.symlink(input.cachedNodeModulesPath, input.nodeModulesPath, "dir");
    await validateRestoredNodeModules(input.nodeModulesPath, input.cachedNodeModulesPath);
    return true;
  } catch (error) {
    await fs.rm(input.nodeModulesPath, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(input.cachedNodeModulesPath, { recursive: true, force: true }).catch(() => undefined);
    await progress(input.env, "dependency_cache_restore_failed", "Dependency cache restore failed; rebuilding cache with npm ci.", {
      lockHash: input.lockHash,
      cacheType: "dependencies",
      cacheStatus: "corrupt",
      reason: input.reason,
      error: conciseError(error)
    }).catch(() => undefined);
    return false;
  }
}

async function validateRestoredNodeModules(nodeModulesPath: string, cacheRootPath?: string) {
  const requiredBins = [".bin/eslint", ".bin/tsc", ".bin/tsx", ".bin/vitest"];
  const allowedRoots = [nodeModulesPath, cacheRootPath].filter((value): value is string => Boolean(value));
  const realAllowedRoots = await Promise.all(allowedRoots.map((root) => fs.realpath(root)));
  await Promise.all(
    requiredBins.map(async (relativePath) => {
      const binPath = path.join(nodeModulesPath, relativePath);
      const resolved = await fs.realpath(binPath);
      if (!realAllowedRoots.some((root) => isInsidePath(root, resolved))) {
        throw new Error(`Restored dependency cache contains non-portable bin symlink: ${relativePath} -> ${resolved}`);
      }
    })
  );
}

export async function dependencyCacheKey(checkoutDir: string) {
  const [lockfile, packageJson] = await Promise.all([
    fs.readFile(path.join(checkoutDir, "package-lock.json")),
    fs.readFile(path.join(checkoutDir, "package.json"))
  ]);
  return `${process.version.replace(/^v/, "node-")}-${DEPENDENCY_CACHE_MODE}-${sha256Buffer(Buffer.concat([lockfile, packageJson])).slice(0, 24)}`;
}

export function codegenNpmInstallEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  delete env.NODE_ENV;
  delete env.npm_config_production;
  delete env.NPM_CONFIG_PRODUCTION;
  delete env.npm_config_omit;
  delete env.NPM_CONFIG_OMIT;
  return {
    ...env,
    NODE_ENV: "development",
    npm_config_production: "false",
    NPM_CONFIG_PRODUCTION: "false"
  };
}

const CODEGEN_NPM_SCRIPT_ENV_PREFIXES = [
  "CODEGEN_",
  "CONTROL_",
  "CRAWL_",
  "DISCORD_",
  "GITHUB_",
  "KUBERNETES_",
  "OPENROUTER_",
  "SANDBOX_",
  "WORKER_"
];

const CODEGEN_NPM_SCRIPT_ENV_KEYS = new Set([
  "BOT_NAME",
  "DATABASE_URL",
  "EMBEDDING_DIMENSIONS",
  "MAX_HISTORY_RESULTS",
  "MAX_REPLY_CHARS",
  "MAX_THREAD_SUMMARY_MESSAGES",
  "RUN_MIGRATIONS",
  "TASK_ID",
  "TASK_REQUEST",
  "TASK_SIGNING_SECRET",
  "TASK_TITLE",
  "TRACE_ID"
]);

export function codegenNpmScriptEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  delete env.NODE_ENV;
  delete env.npm_config_production;
  delete env.NPM_CONFIG_PRODUCTION;
  delete env.npm_config_omit;
  delete env.NPM_CONFIG_OMIT;
  for (const key of Object.keys(env)) {
    if (CODEGEN_NPM_SCRIPT_ENV_KEYS.has(key) || CODEGEN_NPM_SCRIPT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  return {
    ...env,
    NODE_ENV: "development"
  };
}

export async function readDependencyManifestState(checkoutDir: string): Promise<Record<string, string | null>> {
  const files = ["package.json", "package-lock.json"];
  const entries = await Promise.all(
    files.map(async (file) => {
      const filePath = path.join(checkoutDir, file);
      if (!(await pathExists(filePath))) return [file, null] as const;
      return [file, sha256Buffer(await fs.readFile(filePath))] as const;
    })
  );
  return Object.fromEntries(entries);
}

export function changedDependencyManifestFiles(before: Record<string, string | null>, after: Record<string, string | null>) {
  return Object.keys({ ...before, ...after }).filter((file) => before[file] !== after[file]);
}
