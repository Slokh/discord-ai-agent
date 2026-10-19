import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/**
 * The egress proxy presents proxy-signed certificates for the hosts whose
 * placeholder credentials it replaces. Node trusts that CA additively through
 * NODE_EXTRA_CA_CERTS (set on the pod), but git, gh, curl, and the native
 * NanoCodex runtime replace the default store when told to, so they need one
 * combined bundle. The runner writes it once and exports it for every child.
 */
export async function prepareSandboxEgressTrust(
  env: NodeJS.ProcessEnv = process.env,
  options: { systemBundle?: string; outputDir?: string } = {},
): Promise<string | null> {
  const proxyCa = env.SANDBOX_EGRESS_CA_FILE?.trim();
  if (!proxyCa) return null;
  const [system, proxy] = await Promise.all([
    fs.readFile(options.systemBundle ?? SYSTEM_CA_BUNDLE, "utf8"),
    fs.readFile(proxyCa, "utf8"),
  ]);
  const bundlePath = path.join(options.outputDir ?? os.tmpdir(), "sandbox-egress-ca-bundle.crt");
  await fs.writeFile(bundlePath, `${system.trimEnd()}\n${proxy.trimEnd()}\n`, { mode: 0o644 });
  for (const name of ["SSL_CERT_FILE", "GIT_SSL_CAINFO", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"]) env[name] = bundlePath;
  return bundlePath;
}
