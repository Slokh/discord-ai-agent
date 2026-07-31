import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { resolveProductionControlPlane } from "./productionControlPlane.js";

type Env = NodeJS.ProcessEnv;

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  loadLocalEnv(repoRoot);

  const env: Env = { ...process.env };
  const resolvedTarget = resolveProductionControlPlane({ env });

  env.CONSOLE_API_TARGET = resolvedTarget.apiUrl;
  if (!env.CONSOLE_API_AUTH_PASSWORD && resolvedTarget.auth) env.CONSOLE_API_AUTH_PASSWORD = resolvedTarget.auth;

  process.stdout.write(`[console] live proxy target: ${env.CONSOLE_API_TARGET} (${resolvedTarget.source})\n`);
  process.stdout.write(`[console] live proxy auth: ${env.CONSOLE_API_AUTH_PASSWORD || env.CONSOLE_API_AUTH_HEADER ? "configured" : "not configured"}\n`);

  const viteBin = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteBin, "--config", "vite.console.config.ts", "--mode", "live", ...process.argv.slice(2)], {
    cwd: repoRoot,
    env,
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function loadLocalEnv(repoRoot: string) {
  for (const file of [".env", ".env.local", ".env.live", ".env.live.local"]) {
    dotenv.config({ path: path.join(repoRoot, file), override: false, quiet: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
