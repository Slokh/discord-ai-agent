import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import {
  verifyCallbackBodySignature,
  verifyTaskBearerToken,
  taskCallbackSecret,
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
  const bearerIsValid = verifyTaskBearerToken({
      taskId,
      sandboxRunId,
      token,
      secret: config.execution.taskSigningSecret,
    });
  if (!bearerIsValid) return false;

  const callbackSecret = taskCallbackSecret({
    taskId,
    sandboxRunId,
    secret: config.execution.taskSigningSecret,
  });
  return (
    verifyCallbackBodySignature({
      secret: callbackSecret,
      timestamp,
      signature,
      rawBody,
    }) ||
    // Jobs started by the previous revision still hold the former callback key
    // during a rolling deploy. Their short-lived task bearer token keeps this
    // compatibility path bounded to the lifetime of those in-flight jobs.
    verifyCallbackBodySignature({
      secret: config.execution.taskSigningSecret,
      timestamp,
      signature,
      rawBody,
    })
  );
}

export function authorizedControl(
  config: AppConfig,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  _url: URL,
) {
  const password = config.controlApi.authPassword;
  if (!password) return true;

  const allowed = verifyControlAuthorization({
    password,
    authorization: request.headers.authorization,
  });
  if (allowed) return true;
  sendControlUnauthorized(response);
  return false;
}

export function verifyControlAuthorization(input: {
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

function sendControlUnauthorized(response: http.ServerResponse) {
  if (response.headersSent) return;
  response.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": 'Basic realm="Discord AI Agent task viewer"',
  });
  response.end("Authentication required.");
}
