import http from "node:http";
import type { AppConfig } from "../config/env.js";
import { authorizedUi } from "./internalApiAuth.js";
import {
  sendBuffer,
  sendHtml,
  sendJson,
  sendRedirect,
} from "./internalApiHttp.js";
import { readRunConsoleAsset, renderRunConsolePage } from "./runConsole.js";

export async function handleInternalUiRoute(
  input: {
    config: AppConfig;
    request: http.IncomingMessage;
    response: http.ServerResponse;
  },
  method: string,
  url: URL,
): Promise<boolean> {
  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(input.response, 200, { status: "ok" });
    return true;
  }

  if (method === "GET" && url.pathname.startsWith("/console/")) {
    if (!authorizedUi(input.config, input.request, input.response, url))
      return true;
    const asset = await readRunConsoleAsset(url.pathname);
    if (!asset) {
      sendJson(input.response, 404, { error: "asset_not_found" });
      return true;
    }
    sendBuffer(input.response, 200, asset.body, asset.contentType);
    return true;
  }

  if (method === "GET" && url.pathname === "/") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return true;
    sendRedirect(input.response, "/runs");
    return true;
  }

  if (method === "GET" && url.pathname === "/runs") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return true;
    sendHtml(input.response, 200, await renderRunConsolePage());
    return true;
  }

  if (method === "GET" && url.pathname === "/payments") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return true;
    sendHtml(input.response, 200, await renderRunConsolePage());
    return true;
  }

  if (method === "GET" && url.pathname === "/friction") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return true;
    sendHtml(input.response, 200, await renderRunConsolePage());
    return true;
  }

  const runPageMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (method === "GET" && runPageMatch) {
    if (!authorizedUi(input.config, input.request, input.response, url)) return true;
    sendHtml(input.response, 200, await renderRunConsolePage());
    return true;
  }

  return false;
}
