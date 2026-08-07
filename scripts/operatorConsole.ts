import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { loadConfig } from "../src/config/env.js";
import { createProductionDevelopmentSource } from "../src/console/productionDevelopmentSource.js";
import { createProductionSnapshotSource } from "../src/console/productionSnapshotSource.js";
import { startOperatorConsole } from "../src/console/server.js";

const NAMESPACE = "discord-ai-agent";
const SERVICE = "discord-ai-agent-console";
const CONSOLE_PORT = 8_081;
const UPSTREAM_PORT = 18_081;

export type OperatorConsoleOptions = {
  confirmed: boolean;
  localUi: boolean;
};

export function parseOperatorConsoleOptions(argv: string[]): OperatorConsoleOptions {
  const known = new Set(["--confirm-production", "--local-ui"]);
  const unknown = argv.filter((argument) => !known.has(argument));
  if (unknown.length) throw new Error(`Unknown operator-console argument: ${unknown.join(", ")}`);
  return {
    confirmed: argv.includes("--confirm-production"),
    localUi: argv.includes("--local-ui"),
  };
}

export function requireProductionConfirmation(options: OperatorConsoleOptions) {
  if (!options.confirmed) {
    throw new Error("Production console access requires --confirm-production.");
  }
}

async function main() {
  const options = parseOperatorConsoleOptions(process.argv.slice(2));
  requireProductionConfirmation(options);
  const context = commandText("kubectl", ["config", "current-context"]);
  commandText("kubectl", ["--namespace", NAMESPACE, "get", "service", SERVICE, "--output", "name"]);

  const tunnelPort = options.localUi ? UPSTREAM_PORT : CONSOLE_PORT;
  const tunnel = startTunnel(tunnelPort);
  let localConsole: Awaited<ReturnType<typeof startOperatorConsole>> | null = null;
  try {
    const deployedSource = createProductionSnapshotSource({ baseUrl: `http://127.0.0.1:${tunnelPort}` });
    const productionSource = options.localUi
      ? createProductionDevelopmentSource({
        production: deployedSource,
        readKubernetes: () => Promise.resolve(JSON.parse(commandText("kubectl", [
          "--namespace", NAMESPACE,
          "get", "deployments",
          "--selector", "app.kubernetes.io/name=discord-ai-agent",
          "--output", "json",
        ]))),
      })
      : deployedSource;
    await waitForProduction(productionSource, tunnel);
    await warmProductionConnection(productionSource);

    if (options.localUi) {
      const config = loadConfig(["node", "operator-console", "console"]);
      config.consoleServer = { host: "127.0.0.1", port: CONSOLE_PORT };
      localConsole = await startOperatorConsole({
        config,
        repository: productionSource,
        sourceEnvironment: "production",
        liveReload: true,
      });
    }

    process.stdout.write(
      `Production console ready at http://127.0.0.1:${CONSOLE_PORT} ` +
      `(${options.localUi ? "local UI, live production data" : "deployed UI"}; context ${context}).\n`,
    );
    await waitForShutdown(tunnel);
  } finally {
    await localConsole?.close().catch(() => undefined);
    stopChild(tunnel);
  }
}

export async function warmProductionConnection(source: Pick<ReturnType<typeof createProductionSnapshotSource>, "snapshot">) {
  await source.snapshot({ revision: "ignored" });
}

function startTunnel(localPort: number) {
  return spawn("kubectl", [
    "--namespace", NAMESPACE,
    "port-forward", `service/${SERVICE}`,
    `${localPort}:${CONSOLE_PORT}`,
  ], { stdio: ["ignore", "inherit", "inherit"] });
}

async function waitForProduction(source: ReturnType<typeof createProductionSnapshotSource>, tunnel: ChildProcess) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (tunnel.exitCode != null) throw new Error(`Production console tunnel exited with code ${tunnel.exitCode}.`);
    try {
      await source.snapshot({ revision: "ignored" });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Production console did not become ready: ${errorMessage(lastError)}`);
}

function waitForShutdown(tunnel: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    tunnel.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM") resolve();
      else reject(new Error(`Production console tunnel exited with code ${String(code)}.`));
    });
  });
}

function stopChild(child: ChildProcess) {
  if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
}

function commandText(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.error?.message || `exit ${String(result.status)}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}
