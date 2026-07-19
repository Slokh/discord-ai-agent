import { afterEach, describe, expect, it, vi } from "vitest";
import { updateBotAvatar } from "../../src/tools/botProfileTools.js";
import type { ToolContext } from "../../src/tools/types.js";
import { createAgentTurnOutput } from "../../src/tools/turnOutput.js";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.fetch = ORIGINAL_FETCH;
});

function fakeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: {
      discord: { token: "bot-token-123" },
      maxReplyChars: 1800
    },
    repo: { auditTool: vi.fn(async () => undefined) },
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: ["channel"],
    ...overrides
  } as unknown as ToolContext;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function stubFetchWith(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => handler(String(url), init)));
}

const PNG_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

describe("updateBotAvatar", () => {
  it("patches /users/@me with a base64 data-URI avatar from an image URL", async () => {
    const ctx = fakeContext();
    let captured: { url: string; init?: RequestInit } | undefined;
    stubFetchWith((url, init) => {
      if (url === "https://example.com/avatar.png") {
        return new Response(PNG_PIXEL, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (url === "https://discord.com/api/v10/users/@me") {
        captured = { url, init };
        return jsonResponse({ id: "bot-id", avatar: "newhash", username: "ai-agent" });
      }
      return new Response("not found", { status: 404 });
    });

    const response = await updateBotAvatar(ctx, { imageUrl: "https://example.com/avatar.png" });

    expect(captured).toBeDefined();
    expect(captured?.init?.method).toBe("PATCH");
    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bot bot-token-123");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(captured?.init?.body)) as { avatar: string };
    expect(body.avatar).toMatch(/^data:image\/png;base64,/);
    expect(response).toContain("Updated my Discord bot avatar");
    expect(response).toContain("https://cdn.discordapp.com/avatars/bot-id/newhash.png");
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "updateBotAvatar" })
    );
  });

  it("rejects a non-image URL without calling the Discord API", async () => {
    const ctx = fakeContext();
    const calls: string[] = [];
    stubFetchWith((url) => {
      calls.push(url);
      if (url === "https://example.com/notimage") {
        return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response("", { status: 404 });
    });

    const response = await updateBotAvatar(ctx, { imageUrl: "https://example.com/notimage" });

    expect(response).toContain("could not prepare that image");
    expect(calls).not.toContain("https://discord.com/api/v10/users/@me");
    expect(ctx.repo.auditTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "updateBotAvatar", error: expect.stringContaining("image encode failed") })
    );
  });

  it("surfaces Discord rate-limit (429) responses with a retry hint", async () => {
    const ctx = fakeContext();
    stubFetchWith((url) => {
      if (url === "https://example.com/avatar.png") {
        return new Response(PNG_PIXEL, { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response(JSON.stringify({ retry_after: 2 }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2" }
      });
    });

    const response = await updateBotAvatar(ctx, { imageUrl: "https://example.com/avatar.png" });

    expect(response).toContain("rate-limiting");
    expect(response).toContain("2 second");
  });

  it("surfaces Discord permission/authorization errors from the PATCH", async () => {
    const ctx = fakeContext();
    stubFetchWith((url) => {
      if (url === "https://example.com/avatar.png") {
        return new Response(PNG_PIXEL, { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response(JSON.stringify({ message: "401: Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    });

    const response = await updateBotAvatar(ctx, { imageUrl: "https://example.com/avatar.png" });

    expect(response).toContain("HTTP 401");
    expect(response).toContain("Unauthorized");
  });

  it("returns a friendly message when no bot token is configured", async () => {
    const ctx = fakeContext({
      config: { discord: { token: "" }, maxReplyChars: 1800 } as unknown as ToolContext["config"]
    });
    let called = false;
    stubFetchWith(() => {
      called = true;
      return new Response("", { status: 200 });
    });

    const response = await updateBotAvatar(ctx, { imageUrl: "https://example.com/avatar.png" });

    expect(response).toContain("no Discord bot token is configured");
    expect(called).toBe(false);
  });

  it("uses a generated image file as the avatar source when imageUrl is omitted", async () => {
    const turnOutput = createAgentTurnOutput();
    turnOutput.files.push({ name: "gen-avatar.png", data: PNG_PIXEL, contentType: "image/png" });
    const ctx = fakeContext({
      turnOutput,
    });
    let captured: { url: string; body?: string } | undefined;
    stubFetchWith((url, init) => {
      captured = { url, body: init?.body as string };
      return jsonResponse({ id: "bot-id", avatar: "hash2" });
    });

    const response = await updateBotAvatar(ctx, {});

    expect(captured?.url).toBe("https://discord.com/api/v10/users/@me");
    const body = JSON.parse(String(captured?.body)) as { avatar: string };
    expect(body.avatar).toMatch(/^data:image\/png;base64,/);
    expect(response).toContain("Updated my Discord bot avatar");
    expect(response).toContain("generated image: gen-avatar.png");
  });

  it("rejects an invalid imageUrl scheme", async () => {
    const ctx = fakeContext();
    let called = false;
    stubFetchWith(() => {
      called = true;
      return new Response("", { status: 200 });
    });

    const response = await updateBotAvatar(ctx, { imageUrl: "ftp://example.com/x.png" });

    expect(response).toContain("could not get an image");
    expect(response).toContain("http(s)");
    expect(called).toBe(false);
  });

  it("rejects an oversized image before calling the Discord API", async () => {
    const ctx = fakeContext();
    const calls: string[] = [];
    stubFetchWith((url) => {
      calls.push(url);
      if (url === "https://example.com/huge.png") {
        return new Response(Buffer.alloc(8_000_001), {
          status: 200,
          headers: { "content-type": "image/png" }
        });
      }
      return new Response("", { status: 404 });
    });

    const response = await updateBotAvatar(ctx, { imageUrl: "https://example.com/huge.png" });

    expect(response).toContain("too large");
    expect(calls).not.toContain("https://discord.com/api/v10/users/@me");
  });

  it("reports a clear message when no image source is available", async () => {
    const ctx = fakeContext();
    const response = await updateBotAvatar(ctx, { useContextImage: false });

    expect(response).toContain("I need an image URL or a context image");
  });

  it("accepts a data: image URI directly without fetching", async () => {
    const ctx = fakeContext();
    let captured: { url: string; body?: string } | undefined;
    let fetched: string | undefined;
    stubFetchWith((url, init) => {
      if (url === "https://discord.com/api/v10/users/@me") {
        captured = { url, body: init?.body as string };
        return jsonResponse({ id: "bot-id", avatar: "newhash" });
      }
      fetched = url;
      return new Response("", { status: 404 });
    });

    const dataUri = `data:image/png;base64,${PNG_PIXEL.toString("base64")}`;
    const response = await updateBotAvatar(ctx, { imageUrl: dataUri });

    expect(fetched).toBeUndefined();
    expect(captured?.url).toBe("https://discord.com/api/v10/users/@me");
    const body = JSON.parse(String(captured?.body)) as { avatar: string };
    expect(body.avatar).toBe(dataUri);
    expect(response).toContain("Updated my Discord bot avatar");
  });
});
