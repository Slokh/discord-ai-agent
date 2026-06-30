import { createSign } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { AppConfig } from "../config/env.js";

export async function resolveGitHubTaskToken(config: AppConfig): Promise<string> {
  if (config.github.appId && config.github.appPrivateKey && config.github.appInstallationId) {
    return createGitHubAppInstallationToken({
      appId: config.github.appId,
      privateKey: config.github.appPrivateKey,
      installationId: config.github.appInstallationId
    });
  }
  if (config.github.token) return config.github.token;
  throw new Error("GITHUB_TOKEN or GitHub App credentials are required for sandbox code-update tasks.");
}

async function createGitHubAppInstallationToken(input: { appId: string; privateKey: string; installationId: string }) {
  const jwt = signGitHubAppJwt({
    appId: input.appId,
    privateKey: normalizePrivateKey(input.privateKey)
  });
  const octokit = new Octokit({ auth: jwt });
  const response = await octokit.apps.createInstallationAccessToken({
    installation_id: Number(input.installationId)
  });
  return response.data.token;
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

function normalizePrivateKey(value: string) {
  return value.replace(/\\n/g, "\n");
}

function base64UrlJson(value: unknown) {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64Url(value: Buffer) {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
