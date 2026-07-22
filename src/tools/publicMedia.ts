const X_METADATA_MAX_BYTES = 1024 * 1024;
const PUBLIC_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const PUBLIC_MEDIA_TIMEOUT_MS = 15_000;

export type XStatusVideoReference = {
  statusId: string;
  videoIndex: number;
};

export type ResolvedPublicMedia = {
  data: Buffer;
  contentType: "video/mp4";
  format: "mp4";
  provider: "x";
  bytes: number;
};

export function parseXStatusVideoUrl(value: string): XStatusVideoReference | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !X_HOSTS.has(hostname)) return null;
  const match = /^\/[^/]+\/status\/(\d{1,20})(?:\/video\/(\d+))?\/?$/.exec(url.pathname);
  if (!match) return null;
  const videoIndex = Number(match[2] ?? "1");
  if (!Number.isSafeInteger(videoIndex) || videoIndex < 1 || videoIndex > 20) return null;
  return { statusId: match[1], videoIndex };
}

export function publicMediaUrlIsInRequestScope(
  value: string,
  requestText: string | undefined,
  replyTexts: string[],
): boolean {
  const requested = parseXStatusVideoUrl(value);
  if (!requested) return false;
  return [requestText ?? "", ...replyTexts]
    .flatMap(extractHttpUrls)
    .map(parseXStatusVideoUrl)
    .some((candidate) => candidate?.statusId === requested.statusId && candidate.videoIndex === requested.videoIndex);
}

export function singlePublicXVideoUrlInRequestScope(
  requestText: string | undefined,
  replyTexts: string[],
): string | null {
  const byReference = new Map<string, string>();
  for (const value of [requestText ?? "", ...replyTexts].flatMap(extractHttpUrls)) {
    const reference = parseXStatusVideoUrl(value);
    if (!reference) continue;
    byReference.set(`${reference.statusId}:${reference.videoIndex}`, value);
  }
  return byReference.size === 1 ? [...byReference.values()][0] : null;
}

export async function resolvePublicXVideo(
  value: string,
  signal?: AbortSignal,
): Promise<ResolvedPublicMedia> {
  const reference = parseXStatusVideoUrl(value);
  if (!reference) throw new Error("only public X/Twitter status video URLs are supported");
  const token = xSyndicationToken(reference.statusId);
  const metadataUrl = new URL("https://cdn.syndication.twimg.com/tweet-result");
  metadataUrl.searchParams.set("id", reference.statusId);
  metadataUrl.searchParams.set("lang", "en");
  metadataUrl.searchParams.set("token", token);
  const metadataResponse = await boundedFetch(metadataUrl, X_METADATA_MAX_BYTES, signal);
  if (!metadataResponse.response.ok) {
    throw new Error(`X public metadata returned HTTP ${metadataResponse.response.status}`);
  }
  const metadataType = metadataResponse.response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (metadataType && metadataType !== "application/json") {
    throw new Error("X public metadata returned an unexpected content type");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataResponse.data.toString("utf8"));
  } catch {
    throw new Error("X public metadata was not valid JSON");
  }
  const mediaUrl = selectXMp4Variant(metadata, reference.videoIndex);
  const mediaResponse = await boundedFetch(mediaUrl, PUBLIC_MEDIA_MAX_BYTES, signal);
  if (!mediaResponse.response.ok) {
    throw new Error(`X public video returned HTTP ${mediaResponse.response.status}`);
  }
  const contentType = mediaResponse.response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
    throw new Error("X public video returned an unexpected content type");
  }
  return {
    data: mediaResponse.data,
    contentType: "video/mp4",
    format: "mp4",
    provider: "x",
    bytes: mediaResponse.data.length,
  };
}

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

function extractHttpUrls(value: string): string[] {
  return value.match(/https:\/\/[^\s<>]+/gi)?.map((url) => url.replace(/[),.;!?]+$/, "")) ?? [];
}

function xSyndicationToken(statusId: string): string {
  return ((Number(statusId) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(?:0+|\.)/g, "");
}

function selectXMp4Variant(metadata: unknown, requestedVideoIndex: number): URL {
  const root = asRecord(metadata);
  const mediaDetails = Array.isArray(root?.mediaDetails) ? root.mediaDetails : [];
  const videoEntries = mediaDetails.filter((entry) => {
    const record = asRecord(entry);
    return record?.type === "video" || record?.type === "animated_gif" || Boolean(asRecord(record?.video_info));
  });
  const fallbackVideo = root?.video ? [root.video] : [];
  const selected = [...videoEntries, ...fallbackVideo][requestedVideoIndex - 1];
  const selectedRecord = asRecord(selected);
  const videoInfo = asRecord(selectedRecord?.video_info) ?? selectedRecord;
  const variants = Array.isArray(videoInfo?.variants) ? videoInfo.variants : [];
  const mp4Variants = variants
    .map(asRecord)
    .filter((variant): variant is Record<string, unknown> => Boolean(variant))
    .filter((variant) => variant.content_type === "video/mp4" && typeof variant.url === "string")
    .sort((left, right) => numericBitrate(left.bitrate) - numericBitrate(right.bitrate));
  if (mp4Variants.length === 0) throw new Error("the X status did not expose a public MP4 video");
  const url = new URL(String(mp4Variants[0].url));
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "video.twimg.com" ||
    (url.port !== "" && url.port !== "443") ||
    Boolean(url.username || url.password)
  ) {
    throw new Error("X public metadata returned a video on an unapproved host");
  }
  return url;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numericBitrate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

async function boundedFetch(url: URL, maxBytes: number, parentSignal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), PUBLIC_MEDIA_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new Error(`public media response exceeds the ${maxBytes}-byte limit`);
    }
    if (!response.body) return { response, data: Buffer.alloc(0) };
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        controller.abort();
        throw new Error(`public media response exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(chunk);
    }
    return { response, data: Buffer.concat(chunks, total) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`public media download timed out after ${PUBLIC_MEDIA_TIMEOUT_MS}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
}
