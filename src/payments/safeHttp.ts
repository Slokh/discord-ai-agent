import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";

const MAX_REDIRECTS = 3;

export async function assertPublicHttpsUrl(value: string | URL): Promise<URL> {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  if (url.protocol !== "https:") throw new Error("MPP services must use HTTPS");
  if (url.username || url.password) throw new Error("MPP service URLs cannot contain credentials");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("MPP service URL resolves to a local hostname");
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("MPP service hostname did not resolve");
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) throw new Error("MPP service URL resolves to a private or reserved address");
  }
  return url;
}

export async function safeFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: { allowedOrigin?: string; fetchImpl?: typeof fetch } = {}
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sourceRequest = input instanceof Request ? input : null;
  let url = await assertPublicHttpsUrl(sourceRequest ? sourceRequest.url : (input as string | URL));
  const allowedOrigin = options.allowedOrigin ?? url.origin;
  if (url.origin !== allowedOrigin) throw new Error("MPP request origin does not match the inspected service origin");
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const request = sourceRequest ? new Request(url, sourceRequest) : url;
    const requestInit = { ...init, redirect: "manual" as const };
    // Node's built-in fetch accepts an Undici dispatcher. The dispatcher's resolver
    // validates the exact DNS answer used by the socket, closing the validation/
    // connection race that a preflight-only DNS check would leave open.
    const response = fetchImpl === globalThis.fetch
      ? await globalThis.fetch(request, {
          ...requestInit,
          dispatcher: publicNetworkAgent
        } as RequestInit & { dispatcher: Dispatcher })
      : await fetchImpl(request, requestInit);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === MAX_REDIRECTS) throw new Error("MPP service exceeded the redirect limit");
    const method = (init.method ?? sourceRequest?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new Error("MPP services cannot redirect a request with a body");
    const next = await assertPublicHttpsUrl(new URL(location, url));
    if (next.origin !== allowedOrigin) throw new Error("MPP service redirected outside its inspected origin");
    url = next;
  }
  throw new Error("MPP service redirect handling failed");
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  void lookup(hostname, { ...options, all: true, verbatim: true })
    .then((addresses) => {
      if (addresses.length === 0) throw new Error("MPP service hostname did not resolve");
      if (addresses.some((entry) => isPrivateAddress(entry.address))) {
        throw new Error("MPP service URL resolves to a private or reserved address");
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const requestedFamily = Number(options.family ?? 0);
      const selected = addresses.find((entry) => requestedFamily === 0 || entry.family === requestedFamily);
      if (!selected) throw new Error("MPP service hostname did not resolve to the requested address family");
      callback(null, selected.address, selected.family);
    })
    .catch((error: unknown) => callback(asLookupError(error), "", 0));
};

function asLookupError(error: unknown): NodeJS.ErrnoException {
  if (error instanceof Error) return error as NodeJS.ErrnoException;
  return new Error(String(error)) as NodeJS.ErrnoException;
}

const publicNetworkAgent = new Agent({ connect: { lookup: publicLookup } });

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.includes(".")) {
    const mapped = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mapped) return isPrivateAddress(mapped);
  }
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      /^f[cd]/.test(normalized) ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return true;
}
