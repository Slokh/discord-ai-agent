import { createSign } from "node:crypto";
import type { AppConfig } from "../config/env.js";

let cachedToken: { key: string; token: string; expiresAt: number } | undefined;

export async function resolveGitHubTaskToken(config: AppConfig): Promise<string> {
  if (config.github.appId && config.github.appPrivateKey && config.github.appInstallationId) {
    return createGitHubAppInstallationToken({
      appId: config.github.appId,
      privateKey: config.github.appPrivateKey,
      installationId: config.github.appInstallationId,
      repository: config.github.repository
    });
  }
  if (config.github.token) return config.github.token;
  throw new Error("GITHUB_TOKEN or GitHub App credentials are required for sandbox code-update tasks.");
}

async function createGitHubAppInstallationToken(input: { appId: string; privateKey: string; installationId: string; repository: string }) {
  const cacheKey = `${input.appId}:${input.installationId}:${input.repository}`;
  const nowMs = Date.now();
  if (cachedToken?.key === cacheKey && cachedToken.expiresAt - nowMs > 5 * 60_000) return cachedToken.token;
  const jwt = signGitHubAppJwt({
    appId: input.appId,
    privateKey: normalizePrivateKey(input.privateKey)
  });
  const [, repo] = input.repository.split("/");
  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "user-agent": "discord-ai-agent"
    },
    body: JSON.stringify({ repositories: [repo] })
  });
  if (!response.ok) throw new Error(`GitHub App installation token request failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { token: string; expires_at: string };
  cachedToken = { key: cacheKey, token: data.token, expiresAt: new Date(data.expires_at).getTime() };
  return data.token;
}

function signGitHubAppJwt(input: { appId: string; privateKey: string }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: input.appId
  });
  const body = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(body).sign(input.privateKey);
  return `${body}.${base64Url(signature)}`;
}

export const __test = { signGitHubAppJwt, normalizePrivateKey, clearCache: () => (cachedToken = undefined) };

function normalizePrivateKey(value: string) {
  return value.replace(/\\n/g, "\n");
}

function base64UrlJson(value: unknown) {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64Url(value: Buffer) {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
