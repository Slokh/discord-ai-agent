import { summarizeForAudit, truncateForDiscord } from "../util/text.js";
import type { ToolContext } from "./types.js";

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/api/token";
const PLAYLIST_TRACKS_PAGE_SIZE = 100;
const MAX_PLAYLIST_TRACKS = 2000;
const MAX_AUDIO_FEATURE_TRACKS = 100;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

export type SpotifyConfig = {
  clientId?: string;
  clientSecret?: string;
};

type SpotifyToken = {
  accessToken: string;
  expiresAt: number;
};

type SpotifyArtist = {
  id: string;
  name: string;
  genres?: string[];
  popularity?: number;
  followers?: { total?: number };
  external_urls?: { spotify?: string };
};

type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms?: number;
  artists?: Array<{ id?: string; name?: string }>;
  album?: { name?: string };
  external_urls?: { spotify?: string };
};

type SpotifyPlaylistTrack = {
  added_at?: string;
  added_by?: { id?: string };
  track?: SpotifyTrack | null;
};

type SpotifyPagedResponse<T> = {
  items?: T[];
  next?: string | null;
  limit?: number;
  offset?: number;
  total?: number;
};

let cachedToken: SpotifyToken | null = null;

export function isSpotifyConfigured(config: SpotifyConfig): boolean {
  return Boolean(config.clientId && config.clientSecret);
}

export function resetSpotifyTokenCache(): void {
  cachedToken = null;
}

async function getSpotifyToken(config: SpotifyConfig): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }
  if (!isSpotifyConfigured(config)) {
    throw new Error("Spotify credentials are not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.");
  }
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const response = await fetch(SPOTIFY_AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify token request failed (${response.status}): ${truncateForDiscord(text, 200)}`);
  }
  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Spotify token response did not include an access_token.");
  }
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
  };
  return cachedToken.accessToken;
}

async function spotifyFetch<T>(path: string, config: SpotifyConfig): Promise<T> {
  const token = await getSpotifyToken(config);
  const response = await fetch(`${SPOTIFY_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 401) {
    resetSpotifyTokenCache();
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify API ${path.split("?")[0]} failed (${response.status}): ${truncateForDiscord(text, 200)}`);
  }
  return (await response.json()) as T;
}

export function extractSpotifyId(input: string, kind: "playlist" | "artist" | "track" | "album"): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/open\.spotify\.com\/(playlist|artist|track|album)\/([A-Za-z0-9]+)/);
  if (match && match[1] === kind) return match[2];
  if (/^[A-Za-z0-9]+$/.test(trimmed) && !trimmed.includes(" ")) return trimmed;
  return undefined;
}

export async function getSpotifyPlaylistTracks(
  ctx: ToolContext,
  input: { playlistIdOrUrl: string; limit?: number }
): Promise<string> {
  const playlistId = extractSpotifyId(input.playlistIdOrUrl, "playlist");
  const maxTracks = boundedLimit(input.limit, MAX_PLAYLIST_TRACKS, 1, MAX_PLAYLIST_TRACKS);

  if (!playlistId) {
    await audit(ctx, "getSpotifyPlaylistTracks", { input: input.playlistIdOrUrl, error: "invalid_playlist_id" });
    return "I could not find a Spotify playlist ID in that input. Pass a playlist ID or an open.spotify.com/playlist/<id> URL.";
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "getSpotifyPlaylistTracks", { playlistId, error: "not_configured" });
    return "Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to read playlist tracks.";
  }

  try {
    const tracks: SpotifyPlaylistTrack[] = [];
    let offset = 0;
    let total = 0;
    do {
      const page = await spotifyFetch<SpotifyPagedResponse<SpotifyPlaylistTrack>>(
        `/playlists/${playlistId}/tracks?limit=${PLAYLIST_TRACKS_PAGE_SIZE}&offset=${offset}&fields=total,limit,offset,next,items(added_at,added_by.id,track(id,name,duration_ms,artists(id,name),album(name),external_urls.spotify))`,
        ctx.config.spotify
      );
      total = page.total ?? page.items?.length ?? 0;
      const items = page.items ?? [];
      tracks.push(...items);
      offset += items.length;
      if (!page.next) break;
    } while (tracks.length < maxTracks && offset < total);

    const limited = tracks.slice(0, maxTracks);
    await audit(ctx, "getSpotifyPlaylistTracks", { playlistId, total, returned: limited.length });

    if (limited.length === 0) {
      return `Spotify playlist ${playlistId} has no playable tracks, or I could not read it (it may be private).`;
    }
    return formatPlaylistTracks(playlistId, limited, total, maxTracks);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(ctx, "getSpotifyPlaylistTracks", { playlistId, error: message });
    return `I could not read that Spotify playlist: ${truncateForDiscord(message, 300)}`;
  }
}

export async function getSpotifyPlaylist(ctx: ToolContext, input: { playlistIdOrUrl: string }): Promise<string> {
  const playlistId = extractSpotifyId(input.playlistIdOrUrl, "playlist");
  if (!playlistId) {
    await audit(ctx, "getSpotifyPlaylist", { input: input.playlistIdOrUrl, error: "invalid_playlist_id" });
    return "I could not find a Spotify playlist ID in that input. Pass a playlist ID or an open.spotify.com/playlist/<id> URL.";
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "getSpotifyPlaylist", { playlistId, error: "not_configured" });
    return "Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to read playlist details.";
  }

  try {
    const playlist = await spotifyFetch<{
      id: string;
      name?: string;
      description?: string;
      owner?: { id?: string; display_name?: string };
      followers?: { total?: number };
      tracks?: { total?: number };
      external_urls?: { spotify?: string };
      images?: Array<{ url?: string }>;
    }>(
      `/playlists/${playlistId}?fields=id,name,description,owner(id,display_name),followers,total,tracks(total),external_urls.spotify,images`,
      ctx.config.spotify
    );
    await audit(ctx, "getSpotifyPlaylist", { playlistId, name: playlist.name });
    return formatPlaylist(playlist);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(ctx, "getSpotifyPlaylist", { playlistId, error: message });
    return `I could not read that Spotify playlist: ${truncateForDiscord(message, 300)}`;
  }
}

export async function searchSpotify(
  ctx: ToolContext,
  input: { query: string; type?: string; limit?: number }
): Promise<string> {
  const query = input.query?.trim();
  const type = (input.type?.trim() || "track").toLowerCase();
  const allowedTypes = new Set(["track", "artist", "album"]);
  const typeParam = allowedTypes.has(type) ? type : "track";
  const limit = boundedLimit(input.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

  if (!query) {
    await audit(ctx, "searchSpotify", { error: "empty_query" });
    return "I need a search query to search Spotify.";
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "searchSpotify", { query, error: "not_configured" });
    return "Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to search Spotify.";
  }

  try {
    const result = await spotifyFetch<{
      tracks?: SpotifyPagedResponse<SpotifyTrack>;
      artists?: SpotifyPagedResponse<SpotifyArtist>;
      albums?: SpotifyPagedResponse<{ id: string; name?: string; artists?: Array<{ name?: string }>; release_date?: string; external_urls?: { spotify?: string } }>;
    }>(`/search?q=${encodeURIComponent(query)}&type=${typeParam}&limit=${limit}`, ctx.config.spotify);
    await audit(ctx, "searchSpotify", { query, type: typeParam, limit });
    return formatSearchResults(query, typeParam, result, limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(ctx, "searchSpotify", { query, type: typeParam, error: message });
    return `I could not search Spotify: ${truncateForDiscord(message, 300)}`;
  }
}

export async function getSpotifyArtist(ctx: ToolContext, input: { artistIdOrUrl: string }): Promise<string> {
  const artistId = extractSpotifyId(input.artistIdOrUrl, "artist");
  if (!artistId) {
    await audit(ctx, "getSpotifyArtist", { input: input.artistIdOrUrl, error: "invalid_artist_id" });
    return "I could not find a Spotify artist ID in that input. Pass an artist ID or an open.spotify.com/artist/<id> URL.";
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "getSpotifyArtist", { artistId, error: "not_configured" });
    return "Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to read artist info.";
  }

  try {
    const [artist, related] = await Promise.all([
      spotifyFetch<SpotifyArtist>(`/artists/${artistId}`, ctx.config.spotify),
      spotifyFetch<{ artists?: SpotifyArtist[] }>(`/artists/${artistId}/related-artists`, ctx.config.spotify).catch(() => ({ artists: [] }))
    ]);
    await audit(ctx, "getSpotifyArtist", { artistId, name: artist.name });
    return formatArtist(artist, related.artists ?? []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(ctx, "getSpotifyArtist", { artistId, error: message });
    return `I could not read that Spotify artist: ${truncateForDiscord(message, 300)}`;
  }
}

export async function getSpotifyAudioFeatures(
  ctx: ToolContext,
  input: { trackIds: string[] }
): Promise<string> {
  const trackIds = (input.trackIds ?? [])
    .map((id) => extractSpotifyId(id, "track") ?? id.trim())
    .filter(Boolean)
    .slice(0, MAX_AUDIO_FEATURE_TRACKS);

  if (trackIds.length === 0) {
    await audit(ctx, "getSpotifyAudioFeatures", { error: "no_track_ids" });
    return "I need at least one Spotify track ID to fetch audio features. Pass track IDs or open.spotify.com/track/<id> URLs.";
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "getSpotifyAudioFeatures", { trackIds, error: "not_configured" });
    return "Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to read audio features.";
  }

  try {
    const result = await spotifyFetch<{
      audio_features?: Array<{
        id: string;
        danceability?: number;
        energy?: number;
        valence?: number;
        tempo?: number;
        key?: number;
        mode?: number;
        loudness?: number;
        acousticness?: number;
        instrumentalness?: number;
        liveness?: number;
        speechiness?: number;
        duration_ms?: number;
        time_signature?: number;
      } | null>;
    }>(`/audio-features?ids=${trackIds.join(",")}`, ctx.config.spotify);
    const features = (result.audio_features ?? []).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    await audit(ctx, "getSpotifyAudioFeatures", { trackIds, returned: features.length });
    return formatAudioFeatures(features);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(ctx, "getSpotifyAudioFeatures", { trackIds, error: message });
    return `I could not read Spotify audio features: ${truncateForDiscord(message, 300)}`;
  }
}

function formatPlaylistTracks(playlistId: string, tracks: SpotifyPlaylistTrack[], total: number, maxTracks: number): string {
  const lines = tracks.map((entry, index) => {
    const track = entry.track;
    if (!track) return `[${index + 1}] (unplayable/local track)`;
    const artists = (track.artists ?? []).map((artist) => artist.name).join(", ");
    const duration = track.duration_ms != null ? formatDuration(track.duration_ms) : "";
    const added = entry.added_at ? ` added=${entry.added_at.slice(0, 10)}` : "";
    const url = track.external_urls?.spotify ? `\n${track.external_urls.spotify}` : "";
    return `[${index + 1}] ${track.name}${artists ? ` — ${artists}` : ""}${duration ? ` (${duration})` : ""}${added}${url}`;
  });
  const header = `Spotify playlist ${playlistId}: ${tracks.length} of ${total} tracks${maxTracks < total ? ` (capped at ${maxTracks})` : ""}.`;
  return [header, ...lines].join("\n");
}

function formatPlaylist(playlist: {
  id: string;
  name?: string;
  description?: string;
  owner?: { id?: string; display_name?: string };
  followers?: { total?: number };
  tracks?: { total?: number };
  external_urls?: { spotify?: string };
  images?: Array<{ url?: string }>;
}): string {
  const owner = playlist.owner?.display_name || playlist.owner?.id || "(unknown owner)";
  const followers = playlist.followers?.total ?? null;
  const trackCount = playlist.tracks?.total ?? null;
  const description = playlist.description?.trim();
  const url = playlist.external_urls?.spotify;
  return [
    `Spotify playlist: ${playlist.name || playlist.id}`,
    `- Owner: ${owner}`,
    `- Tracks: ${trackCount ?? "unknown"}`,
    `- Followers: ${followers ?? "unknown"}`,
    description ? `- Description: ${truncateForDiscord(description, 300)}` : null,
    url ? `- URL: ${url}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function formatSearchResults(
  query: string,
  type: string,
  result: {
    tracks?: SpotifyPagedResponse<SpotifyTrack>;
    artists?: SpotifyPagedResponse<SpotifyArtist>;
    albums?: SpotifyPagedResponse<{ id: string; name?: string; artists?: Array<{ name?: string }>; release_date?: string; external_urls?: { spotify?: string } }>;
  },
  limit: number
): string {
  const lines: string[] = [`Spotify ${type} search for "${query}" (top ${limit}):`];
  if (type === "track" && result.tracks?.items) {
    lines.push(...result.tracks.items.map((track, index) => {
      const artists = (track.artists ?? []).map((artist) => artist.name).join(", ");
      const url = track.external_urls?.spotify ? `\n${track.external_urls.spotify}` : "";
      return `[${index + 1}] ${track.name}${artists ? ` — ${artists}` : ""}${url}`;
    }));
  } else if (type === "artist" && result.artists?.items) {
    lines.push(...result.artists.items.map((artist, index) => {
      const genres = artist.genres?.length ? ` genres=${artist.genres.join(", ")}` : "";
      const popularity = artist.popularity != null ? ` popularity=${artist.popularity}` : "";
      const url = artist.external_urls?.spotify ? `\n${artist.external_urls.spotify}` : "";
      return `[${index + 1}] ${artist.name}${genres}${popularity}${url}`;
    }));
  } else if (type === "album" && result.albums?.items) {
    lines.push(...result.albums.items.map((album, index) => {
      const artists = (album.artists ?? []).map((artist) => artist.name).join(", ");
      const released = album.release_date ? ` (${album.release_date})` : "";
      const url = album.external_urls?.spotify ? `\n${album.external_urls.spotify}` : "";
      return `[${index + 1}] ${album.name}${artists ? ` — ${artists}` : ""}${released}${url}`;
    }));
  }
  if (lines.length === 1) lines.push("No results.");
  return lines.join("\n");
}

function formatArtist(artist: SpotifyArtist, related: SpotifyArtist[]): string {
  const followers = artist.followers?.total ?? null;
  const lines = [
    `Spotify artist: ${artist.name}`,
    `- Genres: ${artist.genres?.length ? artist.genres.join(", ") : "none listed"}`,
    `- Popularity: ${artist.popularity ?? "unknown"}`,
    followers != null ? `- Followers: ${followers}` : null,
    artist.external_urls?.spotify ? `- URL: ${artist.external_urls.spotify}` : null
  ].filter(Boolean);
  if (related.length > 0) {
    lines.push(`- Related artists: ${related.slice(0, 5).map((entry) => entry.name).join(", ")}`);
  }
  return lines.join("\n");
}

function formatAudioFeatures(
  features: Array<{
    id: string;
    danceability?: number;
    energy?: number;
    valence?: number;
    tempo?: number;
    key?: number;
    mode?: number;
    loudness?: number;
    acousticness?: number;
    instrumentalness?: number;
    liveness?: number;
    speechiness?: number;
    duration_ms?: number;
    time_signature?: number;
  }>
): string {
  if (features.length === 0) return "Spotify returned no audio features for those track IDs.";
  const lines = features.map((feature) => {
    const mood = describeMood(feature.valence, feature.energy, feature.danceability);
    return [
      `Track ${feature.id}:`,
      `  danceability=${roundNum(feature.danceability)} energy=${roundNum(feature.energy)} valence=${roundNum(feature.valence)}`,
      `  tempo=${feature.tempo != null ? `${feature.tempo.toFixed(1)} BPM` : "unknown"} loudness=${feature.loudness ?? "unknown"}dB`,
      `  acousticness=${roundNum(feature.acousticness)} instrumentalness=${roundNum(feature.instrumentalness)} liveness=${roundNum(feature.liveness)} speechiness=${roundNum(feature.speechiness)}`,
      feature.duration_ms != null ? `  duration=${formatDuration(feature.duration_ms)}` : null,
      `  mood=${mood}`
    ].filter(Boolean).join("\n");
  });
  return ["Spotify audio features:", ...lines].join("\n\n");
}

function describeMood(valence?: number, energy?: number, danceability?: number): string {
  if (valence == null || energy == null || danceability == null) return "unknown";
  const happy = valence > 0.5;
  const energetic = energy > 0.6;
  const danceable = danceability > 0.6;
  if (happy && energetic && danceable) return "upbeat / feel-good party";
  if (happy && energetic) return "bright / energetic";
  if (happy && !energetic) return "warm / chill";
  if (!happy && energetic) return "intense / driving";
  if (!happy && !energetic) return "moody / melancholic";
  return "mixed";
}

function roundNum(value?: number): string {
  if (value == null) return "unknown";
  return value.toFixed(3);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function boundedLimit(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

async function audit(ctx: ToolContext, toolName: string, summary: Record<string, unknown>): Promise<void> {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName,
    argumentsSummary: summarizeForAudit(summary),
    resultSummary: summarizeForAudit(summary)
  });
}
