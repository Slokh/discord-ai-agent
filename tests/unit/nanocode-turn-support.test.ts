import { describe, expect, it, vi } from "vitest";
import { loadTurnImages } from "../../src/agent/turnImages.js";
import { nanocodeHostEnvironment } from "../../src/config/nanocodeHostEnvironment.js";
import { sessionToolDefinitions, sharedNanocodeHost, stopSharedNanocodeHost } from "../../src/agent/sharedNanocodeHost.js";
import { hasFaithfulPrivateReplayContext, privateReplayReplyContextFromEnvelope } from "../../src/agent/turnReplay.js";
import { loadConfig } from "../../src/config/env.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const image = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  url: `https://cdn.example/${id}.png`,
  filename: `${id}.png`,
  contentType: "image/png",
  ...extra,
});

function response(body: Buffer, contentType: string, ok = true) {
  return { ok, headers: new Headers({ "content-type": contentType }), arrayBuffer: async () => body } as unknown as Response;
}

describe("loadTurnImages", () => {
  it("inlines the current message's images and the reply parent's as data URLs", async () => {
    const fetchImage = vi.fn(async () => response(PNG, "image/png"));
    const images = await loadTurnImages({
      requestAttachments: [image("a", { proxyUrl: "https://proxy.example/a.png" }), { id: "doc", url: "https://cdn.example/doc.pdf", filename: "doc.pdf", contentType: "application/pdf" }],
      replyContext: { chain: [{ attachments: [image("parent")] }] } as never,
    }, fetchImage as never);
    expect(images).toEqual([`data:image/png;base64,${PNG.toString("base64")}`, `data:image/png;base64,${PNG.toString("base64")}`]);
    expect(fetchImage).toHaveBeenCalledWith("https://proxy.example/a.png", expect.anything());
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it("skips images that are too large, unsupported, unreachable, or beyond the limit", async () => {
    const fetchImage = vi.fn(async (url: string) => {
      if (url.includes("svg")) return response(Buffer.from("<svg/>"), "image/svg+xml");
      if (url.includes("missing")) return response(Buffer.alloc(0), "image/png", false);
      if (url.includes("throws")) throw new Error("network down");
      return response(PNG, "image/png");
    });
    const images = await loadTurnImages({
      requestAttachments: [
        image("huge", { sizeBytes: 50 * 1024 * 1024 }),
        image("svg", { url: "https://cdn.example/svg.png" }),
        image("missing"),
        image("throws"),
        image("ok"),
        image("fifth-is-over-the-limit"),
      ],
    }, fetchImage as never);
    expect(images).toEqual([]);
    expect(fetchImage).toHaveBeenCalledTimes(3);
  });
});

describe("nanocode host wiring", () => {
  it("gives the host only its credentials, the store, and test overrides", () => {
    const config = { ...loadConfig(), openRouter: { ...loadConfig().openRouter, apiKey: "key-1" }, databaseUrl: "postgres://db" };
    vi.stubEnv("NANOCODE_STORE", "memory");
    vi.stubEnv("NANOCODE_API_BASE_URL", "http://127.0.0.1:9/api/v1");
    vi.stubEnv("SOME_SECRET", "must-not-leak");
    try {
      const { env, apiBaseUrl } = nanocodeHostEnvironment(config);
      expect(env).toMatchObject({ OPENROUTER_API_KEY: "key-1", DATABASE_URL: "postgres://db", NANOCODE_STORE: "memory" });
      expect(env.SOME_SECRET).toBeUndefined();
      expect(apiBaseUrl).toBe("http://127.0.0.1:9/api/v1");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(nanocodeHostEnvironment(config).apiBaseUrl).toBeUndefined();
  });

  it("shares one host per process and maps tool definitions for it", async () => {
    const config = loadConfig();
    expect(sharedNanocodeHost(config)).toBe(sharedNanocodeHost(config));
    await stopSharedNanocodeHost();
    expect(sessionToolDefinitions([{ type: "function", function: { name: "t", parameters: { type: "object" } } } as never]))
      .toEqual([{ type: "function", name: "t", description: "", strict: false, parameters: { type: "object" } }]);
  });
});

describe("turn replay", () => {
  const replyMessage = { messageId: "m1", channelId: "c1", content: "parent", authorIsBot: false, attachmentSummaries: [], attachments: [] };
  const envelope = {
    requestKind: "message",
    guildId: "g1",
    channelId: "c1",
    userId: "u1",
    visibleChannelIds: ["c1", "c2"],
    replyContext: { ...replyMessage, rootMessageId: "m1", chain: [replyMessage] },
    requestAttachments: [],
    requestEmbeds: [],
  };
  const scope = { guildId: "g1", channelId: "c1", userId: "u1", visibleChannelIds: ["c2", "c1"] };

  it("replays a retained reply chain only in its original scope", () => {
    expect(privateReplayReplyContextFromEnvelope(envelope, scope)).toMatchObject({ rootMessageId: "m1" });
    expect(privateReplayReplyContextFromEnvelope({ ...envelope, replyContext: null }, scope)).toBeUndefined();
    expect(() => privateReplayReplyContextFromEnvelope(envelope, { ...scope, userId: "u2" })).toThrow("requested Discord scope");
    expect(() => privateReplayReplyContextFromEnvelope(envelope, { ...scope, visibleChannelIds: ["c1"] })).toThrow("visible-channel scope");
  });

  it("refuses turns it cannot replay faithfully", () => {
    expect(hasFaithfulPrivateReplayContext(envelope)).toBe(true);
    expect(hasFaithfulPrivateReplayContext({ ...envelope, requestAttachments: [{ id: "a" }] })).toBe(false);
    expect(hasFaithfulPrivateReplayContext({ ...envelope, requestKind: "component" })).toBe(false);
    expect(hasFaithfulPrivateReplayContext({ ...envelope, replyContext: { messageId: "x" } })).toBe(false);
    expect(() => privateReplayReplyContextFromEnvelope({ ...envelope, requestEmbeds: [{}] }, scope)).toThrow("cannot be replayed faithfully");
  });
});
