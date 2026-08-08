import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const NAMESPACE = "discord-ai-agent";
const SECRET = "discord-ai-agent-env";
const APP_LABEL = "app.kubernetes.io/name=discord-ai-agent";
const REMOTE_PROXY_SOURCE = String.raw`
const net = require("node:net");
const variable = process.argv[1];
const source = process["env"][variable];
if (!source) throw new Error(variable + " is unavailable in the selected pod.");
const target = new URL(source);
const server = net.createServer((downstream) => {
  const upstream = net.connect(Number(target.port || 5432), target.hostname);
  downstream.on("error", () => upstream.destroy());
  upstream.on("error", () => downstream.destroy());
  downstream.pipe(upstream).pipe(downstream);
});
server.listen(0, "127.0.0.1", () => process.stdout.write("READY " + server.address().port + "\n"));
process.stdin.resume();
process.stdin.on("end", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

export type ProductionDatabaseTunnel = {
  databaseUrl: string;
  productionDatabaseUrl: string;
  appRevision: string;
  discordClientId: string | null;
  failure: Promise<never>;
  close(): Promise<void>;
};

export async function startProductionDatabaseTunnel(input: {
  credentialVariable: "DATABASE_URL" | "CONSOLE_DATABASE_URL";
  component: "api" | "console";
  mode?: "read_only" | "administrative";
}): Promise<ProductionDatabaseTunnel> {
  const pod = productionPod(input.component);
  const runtime = podRuntime(pod, input.credentialVariable);
  const relayVariable = input.credentialVariable === "CONSOLE_DATABASE_URL" ? "DATABASE_URL" : input.credentialVariable;
  const proxy = spawn("kubectl", [
    "--namespace", NAMESPACE, "exec", "-i", pod, "--",
    "node", "-e", REMOTE_PROXY_SOURCE, relayVariable,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let forward: ChildProcess | null = null;
  try {
    const remotePort = await waitForLine(proxy, /^READY (\d+)$/m, "production database relay");
    const localPort = await availableLoopbackPort();
    forward = spawn("kubectl", [
      "--namespace", NAMESPACE, "port-forward", `pod/${pod}`,
      `${localPort}:${remotePort}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForLine(forward, /Forwarding from (?:127\.0\.0\.1|\[::1\]):\d+/, "production database port-forward");
    let closing = false;
    const failure = productionDatabaseTunnelFailure([
      { child: proxy, label: "production database relay" },
      { child: forward, label: "production database port-forward" },
    ], () => closing);
    return {
      databaseUrl: input.mode === "administrative"
        ? localDatabaseUrl(runtime.databaseUrl, localPort)
        : localReadOnlyDatabaseUrl(runtime.databaseUrl, localPort),
      productionDatabaseUrl: runtime.databaseUrl,
      appRevision: runtime.appRevision,
      discordClientId: runtime.discordClientId,
      failure,
      close: async () => {
        closing = true;
        stopChild(forward!);
        proxy.stdin?.end();
        stopChild(proxy);
        await Promise.all([settled(forward!), settled(proxy)]);
      },
    };
  } catch (error) {
    if (forward) stopChild(forward);
    proxy.stdin?.end();
    stopChild(proxy);
    throw error;
  }
}

export function productionDatabaseTunnelFailure(
  children: Array<{ child: Pick<ChildProcess, "once">; label: string }>,
  isClosing: () => boolean,
) {
  return new Promise<never>((_resolve, reject) => {
    for (const { child, label } of children) {
      child.once("exit", (code, signal) => {
        if (isClosing()) return;
        reject(new Error(`${label} disconnected unexpectedly (code ${String(code)}, signal ${String(signal)}).`));
      });
    }
  });
}

export function localReadOnlyDatabaseUrl(source: string, localPort: number) {
  const url = new URL(localDatabaseUrl(source, localPort));
  const existing = url.searchParams.get("options")?.trim();
  const options = existing ?? "";
  url.searchParams.set("options", [
    options,
    options.includes("default_transaction_read_only") ? "" : "-c default_transaction_read_only=on",
    options.includes("statement_timeout") ? "" : "-c statement_timeout=30000",
  ].filter(Boolean).join(" "));
  return url.toString();
}

function localDatabaseUrl(source: string, localPort: number) {
  const url = new URL(source);
  url.hostname = "127.0.0.1";
  url.port = String(localPort);
  return url.toString();
}

function productionPod(component: "api" | "console") {
  const selector = `${APP_LABEL},app.kubernetes.io/component=${component}`;
  const pod = commandText("kubectl", [
    "--namespace", NAMESPACE, "get", "pods", "--selector", selector,
    "--field-selector", "status.phase=Running", "--output", "jsonpath={.items[0].metadata.name}",
  ]);
  if (!pod) throw new Error(`No running production ${component} pod is available.`);
  return pod;
}

function podRuntime(pod: string, credentialVariable: "DATABASE_URL" | "CONSOLE_DATABASE_URL") {
  const source = `const environment=process["env"];process.stdout.write(JSON.stringify({databaseUrl:environment.DATABASE_URL||null,appRevision:environment.APP_REVISION||"unknown",discordClientId:environment.DISCORD_CLIENT_ID||null}))`;
  const metadataOutput = commandText("kubectl", [
    "--namespace", NAMESPACE, "exec", pod, "--", "node", "-e", source,
  ]);
  const parsed: unknown = JSON.parse(metadataOutput);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Production pod metadata was invalid.");
  }
  const databaseUrl = credentialVariable === "CONSOLE_DATABASE_URL"
    ? secretValue(credentialVariable)
    : "databaseUrl" in parsed && typeof parsed.databaseUrl === "string" ? parsed.databaseUrl : null;
  if (!databaseUrl) throw new Error(`Production ${credentialVariable} is unavailable.`);
  return {
    databaseUrl,
    appRevision: "appRevision" in parsed && typeof parsed.appRevision === "string" ? parsed.appRevision : "unknown",
    discordClientId: "discordClientId" in parsed && typeof parsed.discordClientId === "string"
      ? parsed.discordClientId
      : secretValue("DISCORD_CLIENT_ID") || null,
  };
}

function secretValue(key: "CONSOLE_DATABASE_URL" | "DISCORD_CLIENT_ID") {
  const encoded = commandText("kubectl", [
    "--namespace", NAMESPACE, "get", "secret", SECRET,
    "--output", `jsonpath={.data.${key}}`,
  ]);
  return encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
}

function availableLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForLine(child: ChildProcess, pattern: RegExp, label: string) {
  return new Promise<number>((resolve, reject) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(() => finish(new Error(
      `${label} did not become ready${errors.trim() ? `: ${errors.trim()}` : "."}`,
    )), 10_000);
    const onOutput = (chunk: Buffer | string) => {
      output += String(chunk);
      const match = output.match(pattern);
      if (match) finish(null, Number(match[1] ?? 0));
    };
    const onError = (chunk: Buffer | string) => { errors += String(chunk); onOutput(chunk); };
    const onExit = (code: number | null) => finish(new Error(`${label} exited with code ${String(code)}${errors.trim() ? `: ${errors.trim()}` : "."}`));
    const finish = (error: Error | null, value = 0) => {
      clearTimeout(timeout);
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onError);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(value);
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onError);
    child.once("exit", onExit);
  });
}

function commandText(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.error?.message || `exit ${String(result.status)}`;
    throw new Error(`${command} ${args.slice(0, 4).join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function stopChild(child: ChildProcess) {
  if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
}

function settled(child: ChildProcess) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
