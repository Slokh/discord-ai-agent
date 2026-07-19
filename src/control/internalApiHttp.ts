import http from "node:http";

const MAX_BODY_BYTES = 25 * 1024 * 1024;

export async function readJsonBody(
  request: http.IncomingMessage,
): Promise<unknown> {
  return parseJsonBody(await readRawBody(request));
}

export async function readRawBody(
  request: http.IncomingMessage,
): Promise<Buffer> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES)
      throw new Error("Internal API request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function parseJsonBody(rawBody: Buffer): unknown {
  if (rawBody.length === 0) return {};
  return JSON.parse(rawBody.toString("utf8"));
}

export function singleHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function sendJson(
  response: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...securityHeaders(),
  });
  response.end(JSON.stringify(body));
}

export function sendHtml(
  response: http.ServerResponse,
  status: number,
  body: string,
) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...securityHeaders(),
  });
  response.end(body);
}

export function sendText(
  response: http.ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; version=0.0.4",
) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    ...securityHeaders(),
  });
  response.end(body);
}

export function sendBuffer(
  response: http.ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "public, max-age=31536000, immutable",
    ...securityHeaders(),
  });
  response.end(body);
}

export function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}

export function sendRedirect(response: http.ServerResponse, location: string) {
  if (response.headersSent) return;
  response.writeHead(302, { location });
  response.end();
}
