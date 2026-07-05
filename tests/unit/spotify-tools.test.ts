import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractSpotifyId,
  getSpotifyItem,
  getSpotifyPlaylistTracks,
  parseSpotifyReference,
  resetSpotifyTokenCache,
  searchSpotify
} from "../../src/tools/spotifyTools.js";
import type { ToolContext } from "../../src/tools/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetSpotifyTokenCache();
});

function fakeContext(spotify: { clientId?: string; clientSecret?: string; market?: string; allowDeprecatedPlaylistTracks?: boolean } = {}): ToolContext {
  return {
    config: { spotify, maxReplyChars: 1800 } as unknown as ToolContext["config"],
    repo: { auditTool: vi.fn(async () => undefined) } as unknown as ToolContext["repo"],
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: []
  } as unknown as ToolContext;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function textResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function stubFetchWith(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => handler(String(url), init)));
}

describe("Spotify ID parsing", () => {
  it("extracts ids from URLs, localized URLs, URIs, and bare ids by kind", () => {
    expect(extractSpotifyId("https://open.spotify.com/playlist/abc123?si=1", "playlist")).toBe("abc123");
    expect(extractSpotifyId("https://open.spotify.com/intl-gb/artist/xyz456?si=1", "artist")).toBe("xyz456");
    expect(extractSpotifyId("spotify:track:trackid", "track")).toBe("trackid");
    expect(extractSpotifyId("albumid", "album")).toBe("albumid");
  });

  it("does not accept a mismatched kind or untyped freeform text", () => {
    expect(extractSpotifyId("https://open.spotify.com/artist/xyz456", "playlist")).toBeUndefined();
    expect(parseSpotifyReference("my favorite playlist")).toBeUndefined();
  });
});

describe("getSpotifyPlaylistTracks", () => {
  it("paginates current playlist items at 50 per page and attaches the full list", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret", market: "GB" });
    const calls: string[] = [];
    stubFetchWith((url) => {
      calls.push(url);
      if (url === "https://accounts.spotify.com/api/token") {
        return jsonResponse({ access_token: "tok", expires_in: 3600 });
      }
      if (url.startsWith("https://api.spotify.com/v1/playlists/pl123?")) {
        return jsonResponse({
          id: "pl123",
          name: "My Cool Playlist",
          owner: { display_name: "Owner One" },
          tracks: { total: 75 },
          external_urls: { spotify: "https://open.spotify.com/playlist/pl123" }
        });
      }
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/playlists/pl123/items");
      expect(parsed.searchParams.get("limit")).toBe("50");
      expect(parsed.searchParams.get("market")).toBe("GB");
      const offset = Number(parsed.searchParams.get("offset"));
      if (offset === 0) {
        return jsonResponse({
          total: 75,
          limit: 50,
          offset: 0,
          next: "next",
          items: Array.from({ length: 50 }, (_, i) => playlistEntry(i))
        });
      }
      return jsonResponse({
        total: 75,
        limit: 50,
        offset: 50,
        next: null,
        items: Array.from({ length: 25 }, (_, i) => playlistEntry(50 + i))
      });
    });

    const result = await getSpotifyPlaylistTracks(ctx, { playlistIdOrUrl: "spotify:playlist:pl123", limit: 75 });

    expect(calls.filter((c) => c.includes("/playlists/pl123/items?"))).toHaveLength(2);
    expect(result.content).toContain("My Cool Playlist by Owner One");
    expect(result.content).toContain("Tracks fetched: 75 of 75");
    expect(result.content).toContain("Full track list attached");
    expect(result.storedContent).toContain("Spotify response omitted");
    expect(result.files).toHaveLength(1);
    expect(result.files?.[0].name).toBe("spotify-playlist-my-cool-playlist.txt");
    expect(result.files?.[0].data.toString("utf8")).toContain("75. Track 74 - Artist 74");
  });

  it("can return the full playlist as csv", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubPlaylistFetch({ total: 1, entries: [playlistEntry(0)] });

    const result = await getSpotifyPlaylistTracks(ctx, { playlistIdOrUrl: "pl123", format: "csv" });

    expect(result.files?.[0].name).toBe("spotify-playlist-my-cool-playlist.csv");
    expect(result.files?.[0].contentType).toBe("text/csv");
    expect(result.files?.[0].data.toString("utf8")).toContain('"position","track","artists","album","duration","added_at","spotify_url"');
  });

  it("returns a clear limitation on current playlist item 403s", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      if (url.startsWith("https://api.spotify.com/v1/playlists/pl123?")) {
        return jsonResponse({
          id: "pl123",
          name: "Forbidden Mix",
          tracks: { total: 20 },
          external_urls: { spotify: "https://open.spotify.com/playlist/pl123" }
        });
      }
      return textResponse("forbidden", 403);
    });

    const result = await getSpotifyPlaylistTracks(ctx, { playlistIdOrUrl: "pl123" });

    expect(result.content).toContain("Forbidden Mix");
    expect(result.content).toContain("Spotify returned 403");
    expect(result.files).toBeUndefined();
  });

  it("falls back to the deprecated playlist tracks endpoint only when explicitly allowed", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret", allowDeprecatedPlaylistTracks: true });
    const calls: string[] = [];
    stubFetchWith((url) => {
      calls.push(url);
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      if (url.startsWith("https://api.spotify.com/v1/playlists/pl123?")) {
        return jsonResponse({ id: "pl123", name: "Legacy Mix", tracks: { total: 1 } });
      }
      if (url.includes("/items?")) return textResponse("forbidden", 403);
      expect(url).toContain("/playlists/pl123/tracks?");
      return jsonResponse({ total: 1, limit: 100, offset: 0, next: null, items: [{ added_at: "2024-01-01T00:00:00Z", track: playlistEntry(0).item }] });
    });

    const result = await getSpotifyPlaylistTracks(ctx, { playlistIdOrUrl: "pl123" });

    expect(calls.some((url) => url.includes("/playlists/pl123/tracks?"))).toBe(true);
    expect(result.content).toContain("deprecated playlist tracks endpoint");
  });

  it("returns friendly messages for missing config and invalid playlist ids", async () => {
    await expect(getSpotifyPlaylistTracks(fakeContext({}), { playlistIdOrUrl: "pl123" })).resolves.toEqual(
      expect.objectContaining({ content: expect.stringContaining("Spotify is not configured") })
    );
    await expect(getSpotifyPlaylistTracks(fakeContext({ clientId: "id", clientSecret: "secret" }), { playlistIdOrUrl: "not a playlist id" })).resolves.toEqual(
      expect.objectContaining({ content: expect.stringContaining("could not find a Spotify playlist ID") })
    );
  });
});

describe("searchSpotify", () => {
  it("searches tracks, clamps limit to Spotify's current maximum, and caches the token", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    const calls: string[] = [];
    let searchCalls = 0;
    stubFetchWith((url) => {
      calls.push(url);
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok", expires_in: 3600 });
      searchCalls += 1;
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/search");
      expect(parsed.searchParams.get("type")).toBe("track");
      expect(parsed.searchParams.get("limit")).toBe(searchCalls === 1 ? "10" : "5");
      return jsonResponse({
        tracks: {
          items: [
            {
              id: "a",
              name: "Running Up That Hill",
              artists: [{ name: "Kate Bush" }],
              external_urls: { spotify: "https://open.spotify.com/track/a" }
            }
          ]
        }
      });
    });

    const first = await searchSpotify(ctx, { query: "Running Up That Hill", type: "track", limit: 50 });
    const second = await searchSpotify(ctx, { query: "Running Up That Hill", type: "track" });

    expect(first.content).toContain("Running Up That Hill - Kate Bush");
    expect(second.content).toContain("Running Up That Hill - Kate Bush");
    expect(calls.filter((url) => url === "https://accounts.spotify.com/api/token")).toHaveLength(1);
  });

  it("returns Retry-After details for Spotify rate limits", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      return textResponse("slow down", 429, { "retry-after": "12" });
    });

    const result = await searchSpotify(ctx, { query: "Kate Bush" });

    expect(result.content).toContain("rate-limited");
    expect(result.content).toContain("12s");
  });

  it("refreshes the token and retries once on 401", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    let searchCalls = 0;
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: searchCalls === 0 ? "bad" : "good" });
      searchCalls += 1;
      if (searchCalls === 1) return textResponse("expired", 401);
      return jsonResponse({ artists: { items: [{ id: "artist1", name: "Radiohead", external_urls: { spotify: "https://open.spotify.com/artist/artist1" } }] } });
    });

    const result = await searchSpotify(ctx, { query: "Radiohead", type: "artist" });

    expect(result.content).toContain("Radiohead");
    expect(searchCalls).toBe(2);
  });
});

describe("getSpotifyItem", () => {
  it("formats track details from a Spotify URL", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      expect(url).toContain("/tracks/track1?");
      return jsonResponse({
        id: "track1",
        name: "Idioteque",
        duration_ms: 309000,
        explicit: false,
        artists: [{ name: "Radiohead" }],
        album: { name: "Kid A" },
        external_urls: { spotify: "https://open.spotify.com/track/track1" }
      });
    });

    const result = await getSpotifyItem(ctx, { itemIdOrUrl: "https://open.spotify.com/track/track1" });

    expect(result.content).toContain("Spotify track: Idioteque - Radiohead");
    expect(result.content).toContain("Album: Kid A");
    expect(result.content).toContain("Duration: 5:09");
  });

  it("requires a type when given a bare ID", async () => {
    const result = await getSpotifyItem(fakeContext({ clientId: "id", clientSecret: "secret" }), { itemIdOrUrl: "abc123" });
    expect(result.content).toContain("bare ID with type");
  });
});

function stubPlaylistFetch(input: { total: number; entries: ReturnType<typeof playlistEntry>[] }) {
  stubFetchWith((url) => {
    if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
    if (url.startsWith("https://api.spotify.com/v1/playlists/pl123?")) {
      return jsonResponse({
        id: "pl123",
        name: "My Cool Playlist",
        owner: { display_name: "Owner One" },
        tracks: { total: input.total },
        external_urls: { spotify: "https://open.spotify.com/playlist/pl123" }
      });
    }
    return jsonResponse({ total: input.total, limit: 50, offset: 0, next: null, items: input.entries });
  });
}

function playlistEntry(index: number) {
  return {
    added_at: `2024-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    is_local: false,
    item: {
      id: `t${index}`,
      name: `Track ${index}`,
      type: "track",
      duration_ms: 180000 + index * 1000,
      artists: [{ name: `Artist ${index}` }],
      album: { name: `Album ${index}` },
      external_urls: { spotify: `https://open.spotify.com/track/t${index}` }
    }
  };
}
