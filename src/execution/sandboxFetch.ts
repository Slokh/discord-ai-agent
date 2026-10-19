/**
 * `agent-fetch`: download one public file into the sandbox workspace.
 *
 * Share pages from common file hosts return HTML viewers rather than the file,
 * so known share-link shapes are rewritten to their direct-download form.
 * Everything else is fetched as given. The download is streamed to disk with a
 * hard size cap; egress policy, not this helper, decides which hosts are
 * reachable.
 */
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export function resolveDirectDownloadUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Only http(s) URLs can be downloaded; received ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();

  if (host === "drive.google.com" || host === "docs.google.com") {
    const id = googleDriveFileId(url);
    if (id) return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
  }

  if (host === "www.dropbox.com" || host === "dropbox.com") {
    url.searchParams.delete("dl");
    url.searchParams.set("dl", "1");
    return url.toString();
  }

  if (host === "github.com") {
    // github.com/<owner>/<repo>/blob/<ref>/<path> renders HTML; /raw/ serves the file.
    const match = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (match) return `https://github.com/${match[1]}/${match[2]}/raw/${match[3]}`;
  }

  return url.toString();
}

function googleDriveFileId(url: URL) {
  const pathMatch = /\/(?:file|document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname);
  if (pathMatch) return pathMatch[1];
  const queryId = url.searchParams.get("id");
  return queryId && /^[A-Za-z0-9_-]+$/.test(queryId) ? queryId : null;
}

export function fileNameFromResponse(response: Pick<Response, "headers" | "url">, fallbackUrl: string) {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)?.[1];
  const fromHeader = encoded ? safeDecode(encoded.trim().replace(/^"|"$/g, "")) : plain?.trim();
  const fromUrl = path.posix.basename(new URL(response.url || fallbackUrl).pathname);
  return sanitizeFileName(fromHeader || fromUrl || "download");
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function sanitizeFileName(name: string) {
  const base = path.posix.basename(name.replaceAll("\\", "/")).replace(/[^\w.\- ()[\]]+/g, "_").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 180) : "download";
}

export async function downloadToDirectory(input: {
  url: string;
  directory: string;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}) {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const resolvedUrl = resolveDirectDownloadUrl(input.url);
  const response = await (input.fetchImpl ?? fetch)(resolvedUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status} from ${new URL(resolvedUrl).hostname}.`);
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`File is ${declared} bytes, over the ${maxBytes}-byte sandbox download limit.`);
  }
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  if (contentType.startsWith("text/html") && resolvedUrl !== input.url) {
    // A share host answered with a viewer, sign-in, or quota page instead of the file.
    throw new Error("The share link returned a web page instead of the file; it may be private, removed, or over its download quota.");
  }
  await fs.mkdir(input.directory, { recursive: true });
  const filePath = await uniquePath(path.join(input.directory, fileNameFromResponse(response, resolvedUrl)));
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(new Error(`Download exceeded the ${maxBytes}-byte sandbox limit.`));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), limit, createWriteStream(filePath));
  } catch (error) {
    await fs.rm(filePath, { force: true });
    throw error;
  }
  return { path: filePath, bytes: received, contentType, resolvedUrl };
}

async function uniquePath(candidate: string) {
  const { dir, name, ext } = path.parse(candidate);
  for (let index = 0; ; index += 1) {
    const next = index === 0 ? candidate : path.join(dir, `${name}-${index}${ext}`);
    try {
      await fs.access(next);
    } catch {
      return next;
    }
  }
}

async function main(argv: string[]) {
  const [url, directory = path.join(process.env.AGENT_WORKSPACE ?? process.cwd(), "downloads")] = argv;
  if (!url) {
    console.error("usage: agent-fetch <url> [directory]");
    process.exit(64);
  }
  const maxBytes = Number(process.env.AGENT_MAX_DOWNLOAD_BYTES) || DEFAULT_MAX_DOWNLOAD_BYTES;
  const result = await downloadToDirectory({ url, directory, maxBytes });
  console.log(JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
