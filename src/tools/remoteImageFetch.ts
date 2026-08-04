import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export async function fetchPublicImage(
  value: string,
  options: { maxBytes: number; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<{ buffer: Buffer; contentType: string; responseUrl: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let current = new URL(value);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await assertPublicHttpUrl(current);
      const response = await fetchImpl(current.toString(), { redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("image redirect did not include a location");
        if (redirect === MAX_REDIRECTS) throw new Error(`image fetch exceeded ${MAX_REDIRECTS} redirects`);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`image fetch failed (HTTP ${response.status})`);
      const declaredBytes = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > options.maxBytes) throw sizeError(options.maxBytes);
      return {
        buffer: await readBoundedBody(response, options.maxBytes),
        contentType: response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "",
        responseUrl: current.toString(),
      };
    }
    throw new Error("image redirect limit exceeded");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`image fetch timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function assertPublicHttpUrl(url: URL): Promise<void> {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("image URL must be an unauthenticated http(s) URL");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("image URL must use a public host");
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("image URL resolved to a private or non-routable address");
  }
}

export function isPublicAddress(value: string): boolean {
  const address = value.toLowerCase();
  if (address.startsWith("::ffff:")) return isPublicAddress(address.slice("::ffff:".length));
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  if (isIP(address) === 6) {
    return !(address === "::" || address === "::1" || address.startsWith("fc") || address.startsWith("fd") ||
      /^fe[89ab]/.test(address) || address.startsWith("ff") || address.startsWith("2001:db8:"));
  }
  return false;
}

async function readBoundedBody(response: Response, maxBytes: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw sizeError(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function sizeError(maxBytes: number) {
  return new Error(`source image is too large (exceeds ${maxBytes / 1_000_000} MB)`);
}
