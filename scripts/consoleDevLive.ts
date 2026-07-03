import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

type Env = NodeJS.ProcessEnv;

const DEFAULT_NAMESPACE = "discord-ai-agent";
const DEFAULT_SECRET_NAME = "discord-ai-agent-env";

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  loadLocalEnv(repoRoot);

  const env: Env = { ...process.env };
  const namespace = env.KUBERNETES_NAMESPACE || DEFAULT_NAMESPACE;
  const resolvedTarget = resolveConsoleApiTarget(env, namespace);

  env.CONSOLE_API_TARGET = resolvedTarget.target;
  if (!env.CONSOLE_API_AUTH_PASSWORD && env.CONTROL_UI_AUTH_PASSWORD) {
    env.CONSOLE_API_AUTH_PASSWORD = env.CONTROL_UI_AUTH_PASSWORD;
  }
  if (!env.CONSOLE_API_AUTH_PASSWORD && resolvedTarget.source === "kubernetes") {
    const password = readKubernetesSecretValue(namespace, env.KUBERNETES_APP_SECRET_NAME || DEFAULT_SECRET_NAME, "CONTROL_UI_AUTH_PASSWORD");
    if (password) env.CONSOLE_API_AUTH_PASSWORD = password;
  }

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

function resolveConsoleApiTarget(env: Env, namespace: string): { target: string; source: "explicit" | "env" | "kubernetes" | "local" } {
  if (env.CONSOLE_API_TARGET) return { target: env.CONSOLE_API_TARGET, source: "explicit" };
  if (env.CONTROL_UI_PUBLIC_URL) return { target: env.CONTROL_UI_PUBLIC_URL, source: "env" };

  const kubernetesTarget = readKubernetesControlUiPublicUrl(namespace);
  if (kubernetesTarget) return { target: kubernetesTarget, source: "kubernetes" };

  return { target: "http://localhost:8080", source: "local" };
}

function readKubernetesControlUiPublicUrl(namespace: string) {
  const deploymentsJson = runOptional("kubectl", [
    "-n",
    namespace,
    "get",
    "deployments",
    "-l",
    "app.kubernetes.io/name=discord-ai-agent",
    "-o",
    "json"
  ]);
  if (!deploymentsJson) return undefined;

  try {
    const deployments = JSON.parse(deploymentsJson) as {
      items?: Array<{
        spec?: {
          template?: {
            spec?: {
              containers?: Array<{ env?: Array<{ name?: string; value?: string }> }>;
            };
          };
        };
      }>;
    };
    for (const item of deployments.items ?? []) {
      for (const container of item.spec?.template?.spec?.containers ?? []) {
        const value = container.env?.find((entry) => entry.name === "CONTROL_UI_PUBLIC_URL")?.value;
        if (value) return value;
      }
    }
  } catch {
    return undefined;
  }
}

function readKubernetesSecretValue(namespace: string, secretName: string, key: string) {
  const encoded = runOptional("kubectl", ["-n", namespace, "get", "secret", secretName, "-o", `jsonpath={.data.${key}}`]);
  if (!encoded) return undefined;
  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function runOptional(command: string, args: string[]) {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
