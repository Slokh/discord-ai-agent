import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { loadConfig } from "../src/config/env.js";
import { createProductionDevelopmentSource } from "../src/console/productionDevelopmentSource.js";
import { startProductionDatabaseTunnel, type ProductionDatabaseTunnel } from "../src/console/productionDatabaseTunnel.js";
import { createProductionSnapshotSource } from "../src/console/productionSnapshotSource.js";
import { startOperatorConsole } from "../src/console/server.js";
import { createOperatorDashboardServices } from "../src/runtime/applicationServices.js";

const NAMESPACE = "discord-ai-agent";
const SERVICE = "discord-ai-agent-console";
const CONSOLE_PORT = 8_081;
const UPSTREAM_PORT = 18_081;

export type OperatorConsoleOptions = {
  confirmed: boolean;
  localUi: boolean;
  localApi: boolean;
};

export function parseOperatorConsoleOptions(argv: string[]): OperatorConsoleOptions {
  const known = new Set(["--confirm-production", "--local-ui", "--local-api"]);
  const unknown = argv.filter((argument) => !known.has(argument));
  if (unknown.length) throw new Error(`Unknown operator-console argument: ${unknown.join(", ")}`);
  const options = {
    confirmed: argv.includes("--confirm-production"),
    localUi: argv.includes("--local-ui"),
    localApi: argv.includes("--local-api"),
  };
  if (options.localUi && options.localApi) throw new Error("Choose either --local-ui or --local-api, not both.");
  return options;
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

  if (options.localApi) return runLocalApi(context);

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

async function runLocalApi(context: string) {
  const shutdown = waitForShutdown();
  let reconnectAttempt = 0;
  while (true) {
    try {
      const outcome = await runLocalApiConnection(context, shutdown);
      if (outcome === "shutdown") return;
    } catch (error) {
      reconnectAttempt += 1;
      process.stderr.write(
        `Production database connection lost; reconnecting (attempt ${reconnectAttempt}): ${errorMessage(error)}\n`,
      );
      const outcome = await Promise.race([
        shutdown.then(() => "shutdown" as const),
        new Promise<"retry">((resolve) => setTimeout(() => resolve("retry"), Math.min(5_000, reconnectAttempt * 500))),
      ]);
      if (outcome === "shutdown") return;
    }
  }
}

async function runLocalApiConnection(context: string, shutdown: Promise<void>) {
  let databaseTunnel: ProductionDatabaseTunnel | null = null;
  let services: ReturnType<typeof createOperatorDashboardServices> | null = null;
  let localConsole: Awaited<ReturnType<typeof startOperatorConsole>> | null = null;
  let poolErrorListener: ((error: Error) => void) | null = null;
  try {
    databaseTunnel = await startProductionDatabaseTunnel({
      credentialVariable: "CONSOLE_DATABASE_URL",
      component: "console",
    });
    const config = loadConfig(["node", "operator-console", "console"]);
    config.databaseUrl = databaseTunnel.databaseUrl;
    config.appRevision = databaseTunnel.appRevision;
    config.discord.clientId = databaseTunnel.discordClientId ?? config.discord.clientId;
    config.consoleServer = { host: "127.0.0.1", port: CONSOLE_PORT };
    services = createOperatorDashboardServices(config);
    const poolFailure = new Promise<never>((_resolve, reject) => {
      poolErrorListener = (error) => reject(new Error(`Production database pool disconnected: ${errorMessage(error)}`));
      services!.pool.on("error", poolErrorListener);
    });
    void poolFailure.catch(() => undefined);
    const readOnly = await services.pool.query("SHOW transaction_read_only");
    if (readOnly.rows[0]?.transaction_read_only !== "on") {
      throw new Error("Refusing local production access because the database session is not read-only.");
    }
    const productionSource = createProductionDevelopmentSource({
      production: services.operatorDashboard,
      readKubernetes: readProductionDeployments,
    });
    await warmProductionConnection(productionSource);
    localConsole = await startOperatorConsole({
      config,
      repository: productionSource,
      sourceEnvironment: "production",
      liveReload: true,
    });
    process.stdout.write(
      `Production console ready at http://127.0.0.1:${CONSOLE_PORT} ` +
      `(local UI and API, read-only production database; context ${context}).\n`,
    );
    return await Promise.race([
      shutdown.then(() => "shutdown" as const),
      databaseTunnel.failure,
      poolFailure,
    ]);
  } finally {
    await localConsole?.close().catch(() => undefined);
    if (services && poolErrorListener) services.pool.off("error", poolErrorListener);
    await services?.close().catch(() => undefined);
    await databaseTunnel?.close().catch(() => undefined);
  }
}

function readProductionDeployments() {
  return Promise.resolve(JSON.parse(commandText("kubectl", [
    "--namespace", NAMESPACE,
    "get", "deployments",
    "--selector", "app.kubernetes.io/name=discord-ai-agent",
    "--output", "json",
  ])));
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

function waitForShutdown(tunnel?: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    tunnel?.once("exit", (code, signal) => {
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
