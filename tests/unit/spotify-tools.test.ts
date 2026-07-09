import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareSpotifyPlaylists,
  extractSpotifyId,
  getSpotifyAlbumTracks,
  getSpotifyArtistDiscography,
  getSpotifyItem,
  getSpotifyPlaylistTracks,
  getSpotifyPlaylistStats,
  parseSpotifyReference,
  resetSpotifyTokenCache,
  searchSpotify
} from "../../src/tools/spotify/spotifyTools.js";
import type { ToolContext } from "../../src/tools/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetSpotifyTokenCache();
});

function fakeContext(spotify: { clientId?: string; clientSecret?: string } = {}): ToolContext {
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
    expect(extractSpotifyId("https://open.spotify.com/show/show123", "show")).toBe("show123");
    expect(extractSpotifyId("spotify:chapter:chapter123", "chapter")).toBe("chapter123");
  });

  it("does not accept a mismatched kind or untyped freeform text", () => {
    expect(extractSpotifyId("https://open.spotify.com/artist/xyz456", "playlist")).toBeUndefined();
    expect(parseSpotifyReference("my favorite playlist")).toBeUndefined();
  });
});

describe("getSpotifyPlaylistTracks", () => {
  it("paginates current playlist items at 50 per page and attaches the full list", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
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
      expect(parsed.searchParams.get("market")).toBe("US");
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
    expect(result.content).toContain("Queryable table: spotify-playlist-my-cool-playlist (75 rows)");
    expect(result.storedContent).toContain("Spotify response omitted");
    expect(result.files?.map((file) => file.name)).toEqual(["spotify-playlist-my-cool-playlist.csv", "spotify-playlist-my-cool-playlist.txt"]);
    expect(result.files?.[0].contentType).toBe("text/csv");
    expect(result.files?.[0].data.toString("utf8")).toContain('"75","Track 74","Artist 74"');
    expect(result.files?.[1].data.toString("utf8")).toContain("75. Track 74 - Artist 74");
    expect(result.tables?.[0]).toMatchObject({
      name: "spotify-playlist-my-cool-playlist",
      sourceFileName: "spotify-playlist-my-cool-playlist.csv",
      columns: expect.arrayContaining(["track", "artists", "duration_ms"]),
      rows: expect.arrayContaining([expect.objectContaining({ position: 75, track: "Track 74", artists: "Artist 74" })])
    });
  });

  it("can return the full playlist as csv", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubPlaylistFetch({ total: 1, entries: [playlistEntry(0)] });

    const result = await getSpotifyPlaylistTracks(ctx, { playlistIdOrUrl: "pl123", format: "csv" });

    expect(result.files?.[0].name).toBe("spotify-playlist-my-cool-playlist.csv");
    expect(result.files?.[0].contentType).toBe("text/csv");
    expect(result.files?.[0].data.toString("utf8")).toContain('"position","track","artists","album","duration","duration_ms","explicit","local","added_at","spotify_url"');
    expect(result.tables?.[0].name).toBe("spotify-playlist-my-cool-playlist");
  });

  it("defaults large playlist exports to the 10000 track cap", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    const offsets: number[] = [];
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok", expires_in: 3600 });
      if (url.startsWith("https://api.spotify.com/v1/playlists/pl123?")) {
        return jsonResponse({
          id: "pl123",
          name: "Huge Playlist",
          owner: { display_name: "Owner One" },
          tracks: { total: 10050 },
          external_urls: { spotify: "https://open.spotify.com/playlist/pl123" }
        });
      }
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/playlists/pl123/items");
      expect(parsed.searchParams.get("limit")).toBe("50");
      const offset = Number(parsed.searchParams.get("offset"));
      offsets.push(offset);
      return jsonResponse({
        total: 10050,
        limit: 50,
        offset,
        next: offset + 50 < 10050 ? "next" : null,
        items: Array.from({ length: 50 }, (_, i) => playlistEntry(offset + i))
      });
    });

    const result = await getSpotifyPlaylistTracks(ctx, { playlistIdOrUrl: "pl123" });

    expect(offsets).toHaveLength(200);
    expect(offsets[0]).toBe(0);
    expect(offsets[offsets.length - 1]).toBe(9950);
    expect(result.content).toContain("Tracks fetched: 10000 of 10050 (capped at 10000)");
    const attachment = result.files?.[0].data.toString("utf8") ?? "";
    expect(attachment).toContain('"10000","Track 9999","Artist 9999"');
    expect(attachment).not.toContain('"10001","Track 10000"');
    expect(result.tables?.[0].rows).toHaveLength(10000);
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

  it("does not fall back to the deprecated playlist tracks endpoint", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    const calls: string[] = [];
    stubFetchWith((url) => {
      calls.push(url);
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      if (url.startsWith("https://api.spotify.com/v1/playlists/pl123?")) {
        return jsonResponse({ id: "pl123", name: "Legacy Mix", tracks: { total: 1 } });
      }
      if (url.includes("/items?")) return textResponse("forbidden", 403);
      throw new Error(`unexpected deprecated endpoint call: ${url}`);
    });

    const result = await getSpotifyPlaylistTracks(ctx, { playlistIdOrUrl: "pl123" });

    expect(calls.some((url) => url.includes("/playlists/pl123/tracks?"))).toBe(false);
    expect(result.content).toContain("Spotify returned 403");
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

  it("searches public podcast and audiobook catalog types", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/search");
      expect(parsed.searchParams.get("type")).toBe("show");
      return jsonResponse({
        shows: {
          items: [{ id: "show1", name: "Song Exploder", publisher: "Pushkin", external_urls: { spotify: "https://open.spotify.com/show/show1" } }]
        }
      });
    });

    const result = await searchSpotify(ctx, { query: "Song Exploder", type: "show" });

    expect(result.content).toContain('Spotify show search for "Song Exploder"');
    expect(result.content).toContain("Song Exploder");
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

  it("formats public audiobook details", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      expect(url).toContain("/audiobooks/book1?");
      return jsonResponse({
        id: "book1",
        name: "Dune",
        authors: [{ name: "Frank Herbert" }],
        narrators: [{ name: "Scott Brick" }],
        total_chapters: 48,
        external_urls: { spotify: "https://open.spotify.com/audiobook/book1" }
      });
    });

    const result = await getSpotifyItem(ctx, { itemIdOrUrl: "spotify:audiobook:book1" });

    expect(result.content).toContain("Spotify audiobook: Dune");
    expect(result.content).toContain("Authors: Frank Herbert");
    expect(result.content).toContain("Chapters: 48");
  });
});

describe("getSpotifyAlbumTracks", () => {
  it("paginates album tracks and attaches the full list", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    const calls: string[] = [];
    stubFetchWith((url) => {
      calls.push(url);
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      if (url.startsWith("https://api.spotify.com/v1/albums/album1?")) {
        return jsonResponse({
          id: "album1",
          name: "Kid A",
          release_date: "2000-10-02",
          total_tracks: 2,
          artists: [{ name: "Radiohead" }],
          external_urls: { spotify: "https://open.spotify.com/album/album1" }
        });
      }
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/albums/album1/tracks");
      expect(parsed.searchParams.get("limit")).toBe("50");
      return jsonResponse({
        total: 2,
        next: null,
        items: [
          { id: "track1", name: "Everything In Its Right Place", track_number: 1, duration_ms: 251000, artists: [{ name: "Radiohead" }] },
          { id: "track2", name: "Kid A", track_number: 2, duration_ms: 284000, artists: [{ name: "Radiohead" }], explicit: false }
        ]
      });
    });

    const result = await getSpotifyAlbumTracks(ctx, { albumIdOrUrl: "spotify:album:album1" });

    expect(calls.some((url) => url.includes("/albums/album1/tracks?"))).toBe(true);
    expect(result.content).toContain("Spotify album: Kid A - Radiohead");
    expect(result.content).toContain("Tracks fetched: 2 of 2");
    expect(result.content).toContain("Queryable table: spotify-album-kid-a (2 rows)");
    expect(result.files?.map((file) => file.name)).toEqual(["spotify-album-kid-a.csv", "spotify-album-kid-a.txt"]);
    expect(result.files?.[0].data.toString("utf8")).toContain('"position","track","artists","duration","duration_ms","explicit","spotify_url"');
    expect(result.files?.[1].data.toString("utf8")).toContain("1. Everything In Its Right Place - Radiohead");
    expect(result.tables?.[0]).toMatchObject({
      name: "spotify-album-kid-a",
      sourceFileName: "spotify-album-kid-a.csv",
      rows: expect.arrayContaining([expect.objectContaining({ position: 1, track: "Everything In Its Right Place", duration_ms: 251000 })])
    });
    expect(result.storedContent).toContain("Spotify response omitted");
  });
});

describe("getSpotifyArtistDiscography", () => {
  it("fetches artist albums, singles, compilations, and appearances", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      if (url === "https://api.spotify.com/v1/artists/artist1") {
        return jsonResponse({ id: "artist1", name: "Radiohead", external_urls: { spotify: "https://open.spotify.com/artist/artist1" } });
      }
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/artists/artist1/albums");
      expect(parsed.searchParams.get("include_groups")).toBe("album,single");
      return jsonResponse({
        total: 2,
        next: null,
        items: [
          { id: "album1", name: "Kid A", album_type: "album", release_date: "2000-10-02", total_tracks: 10, external_urls: { spotify: "https://open.spotify.com/album/album1" } },
          { id: "single1", name: "No Surprises", album_type: "single", release_date: "1998-01-12", total_tracks: 3, external_urls: { spotify: "https://open.spotify.com/album/single1" } }
        ]
      });
    });

    const result = await getSpotifyArtistDiscography(ctx, {
      artistIdOrUrl: "artist1",
      includeGroups: ["album", "single"],
      format: "csv"
    });

    expect(result.content).toContain("Spotify artist discography: Radiohead");
    expect(result.content).toContain("By type: album (1), single (1)");
    expect(result.files?.[0].name).toBe("spotify-artist-radiohead-discography.csv");
    expect(result.files?.[0].data.toString("utf8")).toContain('"Kid A","album"');
    expect(result.tables?.[0]).toMatchObject({
      name: "spotify-artist-radiohead-discography",
      sourceFileName: "spotify-artist-radiohead-discography.csv",
      rows: expect.arrayContaining([expect.objectContaining({ album: "Kid A", type: "album", tracks: 10 })])
    });
  });
});

describe("getSpotifyPlaylistStats", () => {
  it("computes deterministic playlist stats from playlist items", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubPlaylistFetch({
      total: 4,
      entries: [
        playlistEntry(0, { id: "same1", name: "Shared", artist: "Radiohead", album: "Kid A", explicit: true }),
        playlistEntry(1, { id: "same2", name: "Again", artist: "Radiohead", album: "Kid A" }),
        playlistEntry(2, { id: "other", name: "Other", artist: "Kate Bush", album: "Hounds of Love" }),
        playlistEntry(3, { id: "", name: "Local", artist: "Local Artist", album: "Files", isLocal: true })
      ]
    });

    const result = await getSpotifyPlaylistStats(ctx, { playlistIdOrUrl: "pl123" });

    expect(result.content).toContain("Spotify playlist stats: My Cool Playlist by Owner One");
    expect(result.content).toContain("Tracks analyzed: 4 of 4");
    expect(result.content).toContain("Explicit tracks: 1");
    expect(result.content).toContain("Local/unavailable tracks: 1");
    expect(result.content).toContain("Top artists: Radiohead (2)");
  });
});

describe("compareSpotifyPlaylists", () => {
  it("compares shared tracks and artists across two playlists", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      if (url.startsWith("https://api.spotify.com/v1/playlists/plA?")) {
        return jsonResponse({ id: "plA", name: "First Mix", tracks: { total: 2 } });
      }
      if (url.startsWith("https://api.spotify.com/v1/playlists/plB?")) {
        return jsonResponse({ id: "plB", name: "Second Mix", tracks: { total: 2 } });
      }
      if (url.includes("/playlists/plA/items?")) {
        return jsonResponse({
          total: 2,
          next: null,
          items: [
            playlistEntry(0, { id: "shared", name: "Shared Song", artist: "Radiohead" }),
            playlistEntry(1, { id: "a-only", name: "A Only", artist: "Kate Bush" })
          ]
        });
      }
      if (url.includes("/playlists/plB/items?")) {
        return jsonResponse({
          total: 2,
          next: null,
          items: [
            playlistEntry(0, { id: "shared", name: "Shared Song", artist: "Radiohead" }),
            playlistEntry(1, { id: "b-only", name: "B Only", artist: "Björk" })
          ]
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await compareSpotifyPlaylists(ctx, { playlistAIdOrUrl: "plA", playlistBIdOrUrl: "plB" });

    expect(result.content).toContain("Spotify playlist comparison: First Mix vs Second Mix");
    expect(result.content).toContain("Shared tracks: 1");
    expect(result.content).toContain("Track overlap score: 33%");
    expect(result.content).toContain("Shared artist examples: Radiohead");
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

function playlistEntry(
  index: number,
  overrides: { id?: string; name?: string; artist?: string; album?: string; explicit?: boolean; isLocal?: boolean } = {}
) {
  return {
    added_at: `2024-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    is_local: overrides.isLocal ?? false,
    item: {
      id: overrides.id ?? `t${index}`,
      name: overrides.name ?? `Track ${index}`,
      type: "track",
      duration_ms: 180000 + index * 1000,
      explicit: overrides.explicit ?? false,
      artists: [{ name: overrides.artist ?? `Artist ${index}` }],
      album: { name: overrides.album ?? `Album ${index}` },
      external_urls: { spotify: `https://open.spotify.com/track/${overrides.id ?? `t${index}`}` }
    }
  };
}
