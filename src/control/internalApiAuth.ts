import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import {
  verifyCallbackBodySignature,
  verifyTaskBearerToken,
} from "../execution/token.js";
import { singleHeader } from "./internalApiHttp.js";

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
  _url: URL,
) {
  const password = config.controlUi.authPassword;
  if (!password) return true;

  const allowed = verifyUiAuthorization({
    password,
    authorization: request.headers.authorization,
  });
  if (allowed) return true;
  sendUiUnauthorized(response);
  return false;
}

export function verifyUiAuthorization(input: {
  password: string;
  authorization?: string | string[];
}) {
  if (!input.password) return true;
  const authorization = Array.isArray(input.authorization)
    ? input.authorization[0]
    : input.authorization;
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

function sendUiUnauthorized(response: http.ServerResponse) {
  if (response.headersSent) return;
  response.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": 'Basic realm="Discord AI Agent task viewer"',
  });
  response.end("Authentication required.");
}
