import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import {
  verifyCallbackBodySignature,
  verifyTaskBearerToken,
} from "../execution/token.js";
import { sendRedirect, singleHeader } from "./internalApiHttp.js";

const UI_AUTH_COOKIE_NAME = "discord_ai_agent_ui_auth";
const UI_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function authorized(
  config: AppConfig,
  request: http.IncomingMessage,
  taskId: string,
  sandboxRunId: string | undefined,
  rawBody: Buffer,
) {
  if (!sandboxRunId) return false;
  const auth = request.headers.authorization;
  const token = auth?.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : undefined;
  const timestamp = singleHeader(request.headers["x-agent-task-timestamp"]);
  const signature = singleHeader(request.headers["x-agent-task-signature"]);
  return (
    verifyTaskBearerToken({
      taskId,
      sandboxRunId,
      token,
      secret: config.execution.taskSigningSecret,
    }) &&
    verifyCallbackBodySignature({
      secret: config.execution.taskSigningSecret,
      timestamp,
      signature,
      rawBody,
    })
  );
}

export function authorizedUi(
  config: AppConfig,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  options: { redirectOnQueryAuth?: boolean } = {},
) {
  const password = config.controlUi.authPassword;
  if (!password) return true;

  const queryAuth =
    url.searchParams.get("auth") ?? url.searchParams.get("token");
  if (queryAuth != null) {
    if (!safeEqual(queryAuth, password)) {
      sendUiUnauthorized(response);
      return false;
    }
    setUiAuthCookie(response, password, request);
    if (options.redirectOnQueryAuth) {
      sendRedirect(response, cleanAuthRedirectPath(url));
      return false;
    }
    return true;
  }

  const allowed = verifyUiAuthorization({
    password,
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
  });
  if (allowed) return true;
  sendUiUnauthorized(response);
  return false;
}

export function verifyUiAuthorization(input: {
  password: string;
  authorization?: string | string[];
  cookie?: string | string[];
}) {
  if (!input.password) return true;
  const authorization = Array.isArray(input.authorization)
    ? input.authorization[0]
    : input.authorization;
  const cookie = Array.isArray(input.cookie) ? input.cookie[0] : input.cookie;
  const cookieValue = parseCookie(cookie ?? "")[UI_AUTH_COOKIE_NAME];
  if (cookieValue && safeEqual(cookieValue, uiAuthSessionToken(input.password)))
    return true;
  if (!authorization) return false;

  if (authorization.startsWith("Bearer ")) {
    return safeEqual(authorization.slice("Bearer ".length), input.password);
  }

  if (!authorization.startsWith("Basic ")) return false;
  const decoded = Buffer.from(
    authorization.slice("Basic ".length),
    "base64",
  ).toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return username === "admin" && safeEqual(password, input.password);
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function parseCookie(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}

export function setUiAuthCookie(
  response: http.ServerResponse,
  password: string,
  request: http.IncomingMessage,
) {
  const secure = isLocalhostRequest(request) ? "" : "; Secure";
  response.setHeader(
    "set-cookie",
    `${UI_AUTH_COOKIE_NAME}=${encodeURIComponent(uiAuthSessionToken(password))}; Path=/; Max-Age=${UI_AUTH_COOKIE_MAX_AGE_SECONDS}; HttpOnly${secure}; SameSite=Lax`,
  );
}

export function uiAuthSessionToken(password: string) {
  return createHash("sha256")
    .update("discord-ai-agent-ui-session\0")
    .update(password)
    .digest("base64url");
}

export function clearUiAuthCookie(
  response: http.ServerResponse,
  request?: http.IncomingMessage,
) {
  const secure = request && isLocalhostRequest(request) ? "" : "; Secure";
  response.setHeader(
    "set-cookie",
    `${UI_AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly${secure}; SameSite=Lax`,
  );
}

function isLocalhostRequest(request: http.IncomingMessage) {
  const host = request.headers.host?.toLowerCase() ?? "";
  return (
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]")
  );
}

function cleanAuthRedirectPath(url: URL) {
  const clean = new URL(url.toString());
  clean.searchParams.delete("auth");
  clean.searchParams.delete("token");
  return `${clean.pathname}${clean.search || ""}`;
}

function sendUiUnauthorized(response: http.ServerResponse) {
  if (response.headersSent) return;
  response.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": 'Basic realm="Discord AI Agent task viewer"',
  });
  response.end("Authentication required.");
}
