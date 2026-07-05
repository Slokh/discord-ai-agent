import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractSpotifyId,
  getSpotifyArtist,
  getSpotifyAudioFeatures,
  getSpotifyPlaylist,
  getSpotifyPlaylistTracks,
  resetSpotifyTokenCache,
  searchSpotify
} from "../../src/tools/spotifyTools.js";
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
    visibleChannelIds: []
  } as unknown as ToolContext;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetchWith(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

describe("extractSpotifyId", () => {
  it("extracts ids from open.spotify.com URLs by kind", () => {
    expect(extractSpotifyId("https://open.spotify.com/playlist/abc123", "playlist")).toBe("abc123");
    expect(extractSpotifyId("https://open.spotify.com/artist/xyz456?si=1", "artist")).toBe("xyz456");
    expect(extractSpotifyId("https://open.spotify.com/track/trackid", "track")).toBe("trackid");
  });

  it("returns a bare id when kind matches", () => {
    expect(extractSpotifyId("abc123", "playlist")).toBe("abc123");
  });

  it("returns undefined when the URL is a different kind", () => {
    expect(extractSpotifyId("https://open.spotify.com/artist/xyz456", "playlist")).toBeUndefined();
  });

  it("returns undefined for freeform text", () => {
    expect(extractSpotifyId("my favorite playlist", "playlist")).toBeUndefined();
  });
});

describe("getSpotifyPlaylistTracks", () => {
  it("paginates through all tracks using the Spotify Web API", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    const calls: string[] = [];
    stubFetchWith((url) => {
      calls.push(url);
      if (url === "https://accounts.spotify.com/api/token") {
        return jsonResponse({ access_token: "tok", expires_in: 3600 });
      }
      const offset = Number(new URL(url).searchParams.get("offset"));
      if (offset === 0) {
        return jsonResponse({
          total: 250,
          limit: 100,
          offset: 0,
          next: `${url}&offset=100`,
          items: Array.from({ length: 100 }, (_, i) => ({
            added_at: "2024-01-01T00:00:00Z",
            track: { id: `t${i}`, name: `Track ${i}`, duration_ms: 180000, artists: [{ name: "Artist" }], album: { name: "Album" }, external_urls: { spotify: `https://open.spotify.com/track/t${i}` } }
          }))
        });
      }
      if (offset === 100) {
        return jsonResponse({
          total: 250,
          limit: 100,
          offset: 100,
          next: `${url}&offset=200`,
          items: Array.from({ length: 100 }, (_, i) => ({
            added_at: "2024-01-02T00:00:00Z",
            track: { id: `t${100 + i}`, name: `Track ${100 + i}`, duration_ms: 200000, artists: [{ name: "Artist" }] }
          }))
        });
      }
      return jsonResponse({
        total: 250,
        limit: 100,
        offset: 200,
        next: null,
        items: Array.from({ length: 50 }, (_, i) => ({
          added_at: "2024-01-03T00:00:00Z",
          track: { id: `t${200 + i}`, name: `Track ${200 + i}`, duration_ms: 210000, artists: [{ name: "Artist" }] }
        }))
      });
    });

    const result = await getSpotifyPlaylistTracks(ctx, { playlistIdOrUrl: "pl123", limit: 250 });

    const playlistCalls = calls.filter((c) => c.startsWith("https://api.spotify.com/v1/playlists/pl123/tracks"));
    expect(playlistCalls).toHaveLength(3);
    expect(playlistCalls[0]).toContain("offset=0");
    expect(playlistCalls[1]).toContain("offset=100");
    expect(playlistCalls[2]).toContain("offset=200");
    expect(result).toContain("250 of 250 tracks");
    expect(result).toContain("Track 0");
    expect(result).toContain("Track 249");
  });

  it("returns a friendly message when Spotify is not configured", async () => {
    const ctx = fakeContext({});
    const result = await getSpotifyPlaylistTracks(ctx, { playlistIdOrUrl: "pl123" });
    expect(result).toContain("Spotify is not configured");
  });

  it("rejects an invalid playlist id", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    const result = await getSpotifyPlaylistTracks(ctx, { playlistIdOrUrl: "not a playlist id" });
    expect(result).toContain("could not find a Spotify playlist ID");
  });
});

describe("getSpotifyPlaylist", () => {
  it("formats playlist metadata", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      return jsonResponse({
        id: "pl123",
        name: "My Cool Playlist",
        description: "A great mix",
        owner: { id: "owner1", display_name: "Owner One" },
        followers: { total: 42 },
        tracks: { total: 250 },
        external_urls: { spotify: "https://open.spotify.com/playlist/pl123" }
      });
    });
    const result = await getSpotifyPlaylist(ctx, { playlistIdOrUrl: "https://open.spotify.com/playlist/pl123" });
    expect(result).toContain("My Cool Playlist");
    expect(result).toContain("Owner One");
    expect(result).toContain("Tracks: 250");
    expect(result).toContain("Followers: 42");
  });
});

describe("searchSpotify", () => {
  it("searches tracks and returns ranked results", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      expect(url).toContain("/search?");
      expect(url).toContain("type=track");
      expect(url).toContain("q=Running%20Up%20That%20Hill");
      return jsonResponse({
        tracks: {
          items: [
            { id: "a", name: "Running Up That Hill", artists: [{ name: "Kate Bush" }], external_urls: { spotify: "https://open.spotify.com/track/a" } }
          ]
        }
      });
    });
    const result = await searchSpotify(ctx, { query: "Running Up That Hill", type: "track" });
    expect(result).toContain("Running Up That Hill");
    expect(result).toContain("Kate Bush");
  });
});

describe("getSpotifyArtist", () => {
  it("returns artist genres, popularity, and related artists", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      if (url.startsWith("https://api.spotify.com/v1/artists/artist1/related-artists")) {
        return jsonResponse({ artists: [{ id: "r1", name: "Related Artist" }] });
      }
      return jsonResponse({
        id: "artist1",
        name: "Radiohead",
        genres: ["alternative rock", "art rock"],
        popularity: 82,
        followers: { total: 5_000_000 },
        external_urls: { spotify: "https://open.spotify.com/artist/artist1" }
      });
    });
    const result = await getSpotifyArtist(ctx, { artistIdOrUrl: "artist1" });
    expect(result).toContain("Radiohead");
    expect(result).toContain("alternative rock");
    expect(result).toContain("Popularity: 82");
    expect(result).toContain("Related Artist");
  });
});

describe("getSpotifyAudioFeatures", () => {
  it("fetches audio features for track ids and describes mood", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    stubFetchWith((url) => {
      if (url === "https://accounts.spotify.com/api/token") return jsonResponse({ access_token: "tok" });
      expect(url).toContain("/audio-features?ids=t1,t2");
      return jsonResponse({
        audio_features: [
          { id: "t1", danceability: 0.8, energy: 0.7, valence: 0.9, tempo: 120, loudness: -5, acousticness: 0.1, instrumentalness: 0, liveness: 0.1, speechiness: 0.05, duration_ms: 180000 },
          { id: "t2", danceability: 0.2, energy: 0.2, valence: 0.1, tempo: 90, loudness: -14, acousticness: 0.8, instrumentalness: 0.5, liveness: 0.1, speechiness: 0.05, duration_ms: 240000 }
        ]
      });
    });
    const result = await getSpotifyAudioFeatures(ctx, { trackIds: ["t1", "https://open.spotify.com/track/t2"] });
    expect(result).toContain("Track t1:");
    expect(result).toContain("danceability=0.800");
    expect(result).toContain("Track t2:");
    expect(result).toContain("upbeat / feel-good party");
    expect(result).toContain("moody / melancholic");
  });

  it("requires at least one track id", async () => {
    const ctx = fakeContext({ clientId: "id", clientSecret: "secret" });
    const result = await getSpotifyAudioFeatures(ctx, { trackIds: [] });
    expect(result).toContain("need at least one Spotify track ID");
  });
});
