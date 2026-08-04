import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";

const DEFAULT_NAMESPACE = "discord-ai-agent";
const DEFAULT_SECRET_NAME = "discord-ai-agent-env";

export type ProductionControlPlane = {
  apiUrl: string;
  auth?: string;
  source: "explicit" | "environment" | "kubernetes";
};

export function resolveProductionControlPlane(input: {
  apiUrl?: string | null;
  auth?: string | null;
  namespace?: string | null;
  secretName?: string | null;
  env?: NodeJS.ProcessEnv;
} = {}): ProductionControlPlane {
  const env = input.env ?? process.env;
  const namespace = input.namespace || env.KUBERNETES_NAMESPACE || DEFAULT_NAMESPACE;
  const secretName = input.secretName || env.KUBERNETES_APP_SECRET_NAME || DEFAULT_SECRET_NAME;
  const explicitApiUrl = input.apiUrl?.trim() || env.CONSOLE_API_TARGET?.trim();
  const environmentApiUrl = env.CONTROL_API_PUBLIC_URL?.trim();
  const kubernetesApiUrl = explicitApiUrl || environmentApiUrl
    ? undefined
    : readKubernetesControlApiPublicUrl(namespace);
  const apiUrl = explicitApiUrl || environmentApiUrl || kubernetesApiUrl;
  if (!apiUrl) {
    throw new Error(
      "Could not resolve the production control-plane URL. Configure CONTROL_API_PUBLIC_URL, pass --api-url, or connect kubectl to the production cluster. Use --source db only for intentional isolated local inspection.",
    );
  }
  const auth = input.auth?.trim() || env.CONTROL_API_AUTH_PASSWORD?.trim() ||
    readKubernetesSecretValue(namespace, secretName, "CONTROL_API_AUTH_PASSWORD");
  return {
    apiUrl: apiUrl.replace(/\/$/, ""),
    auth: auth || undefined,
    source: explicitApiUrl ? "explicit" : environmentApiUrl ? "environment" : "kubernetes",
  };
}

function readKubernetesControlApiPublicUrl(namespace: string) {
  const deploymentsJson = runOptional("kubectl", [
    "-n", namespace, "get", "deployments",
    "-l", "app.kubernetes.io/name=discord-ai-agent",
    "-o", "json",
  ]);
  if (!deploymentsJson) return undefined;
  try {
    const deployments = JSON.parse(deploymentsJson) as {
      items?: Array<{ spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name?: string; value?: string }> }> } } } }>;
    };
    for (const deployment of deployments.items ?? []) {
      for (const container of deployment.spec?.template?.spec?.containers ?? []) {
        const value = container.env?.find((entry) => entry.name === "CONTROL_API_PUBLIC_URL")?.value?.trim();
        if (value) return value;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
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
    return execFileSync(command, args, { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}
