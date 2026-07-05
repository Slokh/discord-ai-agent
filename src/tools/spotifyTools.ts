import { summarizeForAudit, truncateForDiscord } from "../util/text.js";
import type { AgentFile, AgentResponse, ToolContext } from "./types.js";

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_REQUEST_TIMEOUT_MS = 15_000;
const PLAYLIST_ITEMS_PAGE_SIZE = 50;
const DEPRECATED_PLAYLIST_TRACKS_PAGE_SIZE = 100;
const DEFAULT_PLAYLIST_TRACK_LIMIT = 2_000;
const MAX_PLAYLIST_TRACKS = 2_000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const SPOTIFY_STORED_CONTENT = "Spotify response omitted from conversation memory and artifacts.";

export type SpotifyConfig = {
  clientId?: string;
  clientSecret?: string;
  market?: string;
  allowDeprecatedPlaylistTracks?: boolean;
};

export type SpotifyItemType = "track" | "artist" | "album" | "playlist";
type PlaylistTrackFormat = "text" | "csv";

type SpotifyToken = {
  clientId: string;
  accessToken: string;
  expiresAt: number;
};

type SpotifyExternalUrls = {
  spotify?: string;
};

type SpotifyArtist = {
  id: string;
  name?: string;
  external_urls?: SpotifyExternalUrls;
};

type SpotifyAlbum = {
  id: string;
  name?: string;
  album_type?: string;
  release_date?: string;
  total_tracks?: number;
  artists?: SpotifyArtist[];
  external_urls?: SpotifyExternalUrls;
};

type SpotifyTrack = {
  id?: string;
  name?: string;
  duration_ms?: number;
  explicit?: boolean;
  artists?: SpotifyArtist[];
  album?: SpotifyAlbum;
  external_urls?: SpotifyExternalUrls;
  type?: string;
  uri?: string;
};

type SpotifyPlaylist = {
  id: string;
  name?: string;
  description?: string;
  owner?: { id?: string; display_name?: string; external_urls?: SpotifyExternalUrls };
  tracks?: { total?: number };
  external_urls?: SpotifyExternalUrls;
};

type SpotifyPlaylistTrack = {
  added_at?: string | null;
  is_local?: boolean;
  item?: SpotifyTrack | null;
  track?: SpotifyTrack | null;
};

type SpotifyPagedResponse<T> = {
  items?: T[];
  next?: string | null;
  limit?: number;
  offset?: number;
  total?: number;
};

class SpotifyApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string | null
  ) {
    super(message);
  }
}

let cachedToken: SpotifyToken | null = null;

export function isSpotifyConfigured(config: SpotifyConfig | undefined): boolean {
  return Boolean(config?.clientId?.trim() && config.clientSecret?.trim());
}

export function resetSpotifyTokenCache(): void {
  cachedToken = null;
}

export function extractSpotifyId(input: string, kind: SpotifyItemType): string | undefined {
  return parseSpotifyReference(input, kind)?.id;
}

export function parseSpotifyReference(input: string, expectedType?: SpotifyItemType): { type: SpotifyItemType; id: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const urlMatch = trimmed.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(playlist|artist|track|album)\/([A-Za-z0-9]+)/i);
  if (urlMatch) {
    const type = urlMatch[1].toLowerCase() as SpotifyItemType;
    if (expectedType && type !== expectedType) return undefined;
    return { type, id: urlMatch[2] };
  }

  const uriMatch = trimmed.match(/^spotify:(playlist|artist|track|album):([A-Za-z0-9]+)$/i);
  if (uriMatch) {
    const type = uriMatch[1].toLowerCase() as SpotifyItemType;
    if (expectedType && type !== expectedType) return undefined;
    return { type, id: uriMatch[2] };
  }

  if (expectedType && /^[A-Za-z0-9]+$/.test(trimmed)) {
    return { type: expectedType, id: trimmed };
  }

  return undefined;
}

export async function searchSpotify(
  ctx: ToolContext,
  input: { query: string; type?: string; limit?: number }
): Promise<AgentResponse> {
  const query = input.query?.trim();
  const type = spotifyItemType(input.type, "track");
  const limit = boundedLimit(input.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

  if (!query) {
    await audit(ctx, "searchSpotify", { error: "empty_query" });
    return spotifyResponse("I need a search query to search Spotify.");
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "searchSpotify", { query, type, error: "not_configured" });
    return spotifyResponse("Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to search Spotify.");
  }

  try {
    const params = new URLSearchParams({
      q: query,
      type,
      limit: String(limit),
      market: spotifyMarket(ctx.config.spotify)
    });
    const result = await spotifyFetch<{
      tracks?: SpotifyPagedResponse<SpotifyTrack>;
      artists?: SpotifyPagedResponse<SpotifyArtist>;
      albums?: SpotifyPagedResponse<SpotifyAlbum>;
      playlists?: SpotifyPagedResponse<SpotifyPlaylist>;
    }>(`/search?${params.toString()}`, ctx.config.spotify);
    const content = formatSearchResults(query, type, result, limit);
    await audit(ctx, "searchSpotify", { query, type, limit, returned: spotifySearchResultCount(type, result) });
    return spotifyResponse(content);
  } catch (error) {
    const message = spotifyErrorMessage(error, "I could not search Spotify");
    await audit(ctx, "searchSpotify", { query, type, error: message });
    return spotifyResponse(message);
  }
}

export async function getSpotifyItem(
  ctx: ToolContext,
  input: { itemIdOrUrl: string; type?: string }
): Promise<AgentResponse> {
  const explicitType = spotifyItemType(input.type);
  const reference = parseSpotifyReference(input.itemIdOrUrl, explicitType);

  if (!reference) {
    await audit(ctx, "getSpotifyItem", { input: input.itemIdOrUrl, type: input.type, error: "invalid_reference" });
    return spotifyResponse(
      "I could not find a Spotify item ID in that input. Pass an open.spotify.com URL, a spotify: URI, or a bare ID with type=track/artist/album/playlist."
    );
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "getSpotifyItem", { type: reference.type, id: reference.id, error: "not_configured" });
    return spotifyResponse("Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to read Spotify details.");
  }

  try {
    const content = await fetchAndFormatSpotifyItem(ctx, reference);
    await audit(ctx, "getSpotifyItem", { type: reference.type, id: reference.id });
    return spotifyResponse(content);
  } catch (error) {
    const message = spotifyErrorMessage(error, "I could not read that Spotify item");
    await audit(ctx, "getSpotifyItem", { type: reference.type, id: reference.id, error: message });
    return spotifyResponse(message);
  }
}

export async function getSpotifyPlaylistTracks(
  ctx: ToolContext,
  input: { playlistIdOrUrl: string; limit?: number; format?: string }
): Promise<AgentResponse> {
  const playlistRef = parseSpotifyReference(input.playlistIdOrUrl, "playlist");
  const maxTracks = boundedLimit(input.limit, DEFAULT_PLAYLIST_TRACK_LIMIT, 1, MAX_PLAYLIST_TRACKS);
  const format: PlaylistTrackFormat = input.format === "csv" ? "csv" : "text";

  if (!playlistRef) {
    await audit(ctx, "getSpotifyPlaylistTracks", { input: input.playlistIdOrUrl, error: "invalid_playlist_id" });
    return spotifyResponse("I could not find a Spotify playlist ID in that input. Pass a playlist ID, open.spotify.com playlist URL, or spotify:playlist URI.");
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "getSpotifyPlaylistTracks", { playlistId: playlistRef.id, error: "not_configured" });
    return spotifyResponse("Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to read playlist tracks.");
  }

  try {
    const playlist = await fetchSpotifyPlaylist(ctx.config.spotify, playlistRef.id);
    let trackPage: { tracks: SpotifyPlaylistTrack[]; total: number; usedDeprecatedEndpoint: boolean };
    try {
      trackPage = await fetchPlaylistTrackPages(ctx.config.spotify, playlistRef.id, maxTracks, false);
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 403 && ctx.config.spotify.allowDeprecatedPlaylistTracks) {
        trackPage = await fetchPlaylistTrackPages(ctx.config.spotify, playlistRef.id, maxTracks, true);
      } else if (error instanceof SpotifyApiError && error.status === 403) {
        await audit(ctx, "getSpotifyPlaylistTracks", { playlistId: playlistRef.id, error: "playlist_items_forbidden" });
        return spotifyResponse(formatPlaylistItemsForbidden(playlist));
      } else {
        throw error;
      }
    }

    const normalized = trackPage.tracks.map(normalizePlaylistTrack).filter((track): track is NormalizedPlaylistTrack => Boolean(track));
    const files = normalized.length > 0 ? [playlistTracksFile(playlist, normalized, format)] : [];
    const content = formatPlaylistTrackSummary(playlist, normalized, trackPage.total, maxTracks, files[0], trackPage.usedDeprecatedEndpoint);
    await audit(ctx, "getSpotifyPlaylistTracks", {
      playlistId: playlistRef.id,
      total: trackPage.total,
      returned: normalized.length,
      attachment: files[0]?.name,
      usedDeprecatedEndpoint: trackPage.usedDeprecatedEndpoint || undefined
    });
    return spotifyResponse(content, files);
  } catch (error) {
    const message = spotifyErrorMessage(error, "I could not read that Spotify playlist");
    await audit(ctx, "getSpotifyPlaylistTracks", { playlistId: playlistRef.id, error: message });
    return spotifyResponse(message);
  }
}

async function fetchAndFormatSpotifyItem(ctx: ToolContext, reference: { type: SpotifyItemType; id: string }): Promise<string> {
  if (reference.type === "track") {
    const params = new URLSearchParams({ market: spotifyMarket(ctx.config.spotify) });
    const track = await spotifyFetch<SpotifyTrack>(`/tracks/${reference.id}?${params.toString()}`, ctx.config.spotify);
    return formatTrack(track);
  }
  if (reference.type === "artist") {
    const artist = await spotifyFetch<SpotifyArtist>(`/artists/${reference.id}`, ctx.config.spotify);
    return formatArtist(artist);
  }
  if (reference.type === "album") {
    const params = new URLSearchParams({ market: spotifyMarket(ctx.config.spotify) });
    const album = await spotifyFetch<SpotifyAlbum>(`/albums/${reference.id}?${params.toString()}`, ctx.config.spotify);
    return formatAlbum(album);
  }
  const playlist = await fetchSpotifyPlaylist(ctx.config.spotify, reference.id);
  return formatPlaylist(playlist);
}

async function fetchSpotifyPlaylist(config: SpotifyConfig, playlistId: string): Promise<SpotifyPlaylist> {
  const params = new URLSearchParams({
    market: spotifyMarket(config),
    fields: "id,name,description,owner(id,display_name,external_urls.spotify),tracks(total),external_urls.spotify"
  });
  return await spotifyFetch<SpotifyPlaylist>(`/playlists/${playlistId}?${params.toString()}`, config);
}

async function fetchPlaylistTrackPages(
  config: SpotifyConfig,
  playlistId: string,
  maxTracks: number,
  useDeprecatedEndpoint: boolean
): Promise<{ tracks: SpotifyPlaylistTrack[]; total: number; usedDeprecatedEndpoint: boolean }> {
  const tracks: SpotifyPlaylistTrack[] = [];
  const pageSize = useDeprecatedEndpoint ? DEPRECATED_PLAYLIST_TRACKS_PAGE_SIZE : PLAYLIST_ITEMS_PAGE_SIZE;
  const endpoint = useDeprecatedEndpoint ? "tracks" : "items";
  let offset = 0;
  let total = 0;

  do {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
      market: spotifyMarket(config),
      fields:
        "total,limit,offset,next,items(added_at,is_local,item(id,name,type,duration_ms,explicit,external_urls.spotify,uri,artists(id,name,external_urls.spotify),album(id,name,external_urls.spotify,release_date)),track(id,name,type,duration_ms,explicit,external_urls.spotify,uri,artists(id,name,external_urls.spotify),album(id,name,external_urls.spotify,release_date)))"
    });
    const page = await spotifyFetch<SpotifyPagedResponse<SpotifyPlaylistTrack>>(
      `/playlists/${playlistId}/${endpoint}?${params.toString()}`,
      config
    );
    const items = page.items ?? [];
    total = page.total ?? Math.max(total, offset + items.length);
    tracks.push(...items);
    offset += items.length;
    if (!page.next || items.length === 0) break;
  } while (tracks.length < maxTracks && offset < total);

  return { tracks: tracks.slice(0, maxTracks), total, usedDeprecatedEndpoint: useDeprecatedEndpoint };
}

async function getSpotifyToken(config: SpotifyConfig): Promise<string> {
  const clientId = config.clientId?.trim() ?? "";
  const clientSecret = config.clientSecret?.trim() ?? "";
  if (cachedToken && cachedToken.clientId === clientId && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }
  if (!clientId || !clientSecret) {
    throw new Error("Spotify credentials are not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.");
  }
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetchWithTimeout(SPOTIFY_AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString()
  });
  if (!response.ok) {
    throw await spotifyApiError(response, "Spotify token request failed");
  }
  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Spotify token response did not include an access_token.");
  }
  cachedToken = {
    clientId,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
  };
  return cachedToken.accessToken;
}

async function spotifyFetch<T>(path: string, config: SpotifyConfig, retryOnUnauthorized = true): Promise<T> {
  const token = await getSpotifyToken(config);
  const response = await fetchWithTimeout(`${SPOTIFY_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 401 && retryOnUnauthorized) {
    resetSpotifyTokenCache();
    return await spotifyFetch<T>(path, config, false);
  }
  if (!response.ok) {
    throw await spotifyApiError(response, `Spotify API ${path.split("?")[0]} failed`);
  }
  return (await response.json()) as T;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPOTIFY_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SpotifyApiError("Spotify request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function spotifyApiError(response: Response, prefix: string): Promise<SpotifyApiError> {
  const retryAfter = response.headers.get("retry-after");
  if (response.status === 429) {
    return new SpotifyApiError(
      `Spotify rate-limited this request${retryAfter ? `; try again after ${retryAfter}s` : ""}.`,
      response.status,
      retryAfter
    );
  }
  const text = await response.text().catch(() => "");
  return new SpotifyApiError(`${prefix} (${response.status}): ${truncateForDiscord(text, 200)}`, response.status, retryAfter);
}

function spotifyResponse(content: string, files?: AgentFile[]): AgentResponse {
  return {
    content,
    files: files?.length ? files : undefined,
    storedContent: SPOTIFY_STORED_CONTENT
  };
}

function formatSearchResults(
  query: string,
  type: SpotifyItemType,
  result: {
    tracks?: SpotifyPagedResponse<SpotifyTrack>;
    artists?: SpotifyPagedResponse<SpotifyArtist>;
    albums?: SpotifyPagedResponse<SpotifyAlbum>;
    playlists?: SpotifyPagedResponse<SpotifyPlaylist>;
  },
  limit: number
): string {
  const lines = [`Spotify ${type} search for "${query}" (top ${limit}).`, "Supplied by Spotify; links open Spotify."];
  const items =
    type === "track"
      ? result.tracks?.items
      : type === "artist"
        ? result.artists?.items
        : type === "album"
          ? result.albums?.items
          : result.playlists?.items;
  if (!items?.length) return [...lines, "No results."].join("\n");

  lines.push(
    ...items.map((item, index) => {
      if (type === "track") return `${index + 1}. ${trackLabel(item as SpotifyTrack)}${spotifyUrlSuffix(item as SpotifyTrack)}`;
      if (type === "artist") return `${index + 1}. ${artistLabel(item as SpotifyArtist)}${spotifyUrlSuffix(item as SpotifyArtist)}`;
      if (type === "album") return `${index + 1}. ${albumLabel(item as SpotifyAlbum)}${spotifyUrlSuffix(item as SpotifyAlbum)}`;
      return `${index + 1}. ${playlistLabel(item as SpotifyPlaylist)}${spotifyUrlSuffix(item as SpotifyPlaylist)}`;
    })
  );
  return lines.join("\n");
}

function formatTrack(track: SpotifyTrack): string {
  return [
    `Spotify track: ${trackLabel(track)}`,
    track.album?.name ? `- Album: ${track.album.name}` : null,
    track.duration_ms != null ? `- Duration: ${formatDuration(track.duration_ms)}` : null,
    track.explicit ? "- Explicit: yes" : null,
    track.external_urls?.spotify ? `- URL: ${track.external_urls.spotify}` : null,
    "Supplied by Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

function formatArtist(artist: SpotifyArtist): string {
  return [
    `Spotify artist: ${artistLabel(artist)}`,
    artist.external_urls?.spotify ? `- URL: ${artist.external_urls.spotify}` : null,
    "Supplied by Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

function formatAlbum(album: SpotifyAlbum): string {
  return [
    `Spotify album: ${albumLabel(album)}`,
    album.release_date ? `- Release date: ${album.release_date}` : null,
    album.total_tracks != null ? `- Tracks: ${album.total_tracks}` : null,
    album.external_urls?.spotify ? `- URL: ${album.external_urls.spotify}` : null,
    "Supplied by Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

function formatPlaylist(playlist: SpotifyPlaylist): string {
  const description = stripHtml(playlist.description ?? "").trim();
  return [
    `Spotify playlist: ${playlistLabel(playlist)}`,
    playlist.tracks?.total != null ? `- Tracks: ${playlist.tracks.total}` : null,
    description ? `- Description: ${truncateForDiscord(description, 300)}` : null,
    playlist.external_urls?.spotify ? `- URL: ${playlist.external_urls.spotify}` : null,
    "Supplied by Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

function formatPlaylistTrackSummary(
  playlist: SpotifyPlaylist,
  tracks: NormalizedPlaylistTrack[],
  total: number,
  maxTracks: number,
  file: AgentFile | undefined,
  usedDeprecatedEndpoint: boolean
): string {
  if (tracks.length === 0) {
    return [
      `Spotify playlist: ${playlistLabel(playlist)}`,
      `- Tracks: ${total || playlist.tracks?.total || 0}`,
      "- No playable tracks were returned.",
      "Supplied by Spotify."
    ].join("\n");
  }
  return [
    `Spotify playlist: ${playlistLabel(playlist)}`,
    `- Tracks fetched: ${tracks.length} of ${total || playlist.tracks?.total || tracks.length}${maxTracks < total ? ` (capped at ${maxTracks})` : ""}`,
    file ? `- Full track list attached: ${file.name}` : null,
    usedDeprecatedEndpoint ? "- Used Spotify's deprecated playlist tracks endpoint because SPOTIFY_ALLOW_DEPRECATED_PLAYLIST_TRACKS=true." : null,
    "Supplied by Spotify; track links open Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

function formatPlaylistItemsForbidden(playlist: SpotifyPlaylist): string {
  return [
    formatPlaylist(playlist),
    "",
    "I can read the playlist metadata, but Spotify returned 403 for the full item list. Current playlist item access can be limited to playlist owners/collaborators for this app. Set SPOTIFY_ALLOW_DEPRECATED_PLAYLIST_TRACKS=true only for a legacy Spotify app that is allowed to use the deprecated playlist tracks endpoint."
  ].join("\n");
}

type NormalizedPlaylistTrack = {
  position: number;
  name: string;
  artists: string;
  album: string;
  duration: string;
  addedAt: string;
  url: string;
  isLocal: boolean;
};

function normalizePlaylistTrack(entry: SpotifyPlaylistTrack, index: number): NormalizedPlaylistTrack | undefined {
  const track = entry.item ?? entry.track;
  if (!track || track.type === "episode") return undefined;
  return {
    position: index + 1,
    name: track.name || "(unknown track)",
    artists: artistNames(track.artists),
    album: track.album?.name ?? "",
    duration: track.duration_ms != null ? formatDuration(track.duration_ms) : "",
    addedAt: entry.added_at ? entry.added_at.slice(0, 10) : "",
    url: track.external_urls?.spotify ?? "",
    isLocal: Boolean(entry.is_local)
  };
}

function playlistTracksFile(playlist: SpotifyPlaylist, tracks: NormalizedPlaylistTrack[], format: PlaylistTrackFormat): AgentFile {
  const safeName = safeFilename(playlist.name || playlist.id);
  if (format === "csv") {
    return {
      name: `spotify-playlist-${safeName}.csv`,
      contentType: "text/csv",
      data: Buffer.from(formatPlaylistTracksCsv(tracks), "utf8")
    };
  }
  return {
    name: `spotify-playlist-${safeName}.txt`,
    contentType: "text/plain",
    data: Buffer.from(formatPlaylistTracksText(playlist, tracks), "utf8")
  };
}

function formatPlaylistTracksText(playlist: SpotifyPlaylist, tracks: NormalizedPlaylistTrack[]): string {
  return [
    `Spotify playlist: ${playlistLabel(playlist)}`,
    playlist.external_urls?.spotify ? `URL: ${playlist.external_urls.spotify}` : null,
    "Supplied by Spotify.",
    "",
    ...tracks.map((track) => {
      const parts = [
        `${track.position}. ${track.name}`,
        track.artists ? `- ${track.artists}` : null,
        track.album ? `(${track.album})` : null,
        track.duration ? `[${track.duration}]` : null,
        track.addedAt ? `added ${track.addedAt}` : null,
        track.isLocal ? "local file" : null,
        track.url || null
      ].filter(Boolean);
      return parts.join(" ");
    })
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

function formatPlaylistTracksCsv(tracks: NormalizedPlaylistTrack[]): string {
  const rows = [["position", "track", "artists", "album", "duration", "added_at", "spotify_url"], ...tracks.map((track) => [
    String(track.position),
    track.name,
    track.artists,
    track.album,
    track.duration,
    track.addedAt,
    track.url
  ])];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function trackLabel(track: SpotifyTrack): string {
  return `${track.name || track.id || "(unknown track)"}${track.artists?.length ? ` - ${artistNames(track.artists)}` : ""}`;
}

function albumLabel(album: SpotifyAlbum): string {
  return `${album.name || album.id}${album.artists?.length ? ` - ${artistNames(album.artists)}` : ""}`;
}

function artistLabel(artist: SpotifyArtist): string {
  return artist.name || artist.id;
}

function playlistLabel(playlist: SpotifyPlaylist): string {
  const owner = playlist.owner?.display_name || playlist.owner?.id;
  return `${playlist.name || playlist.id}${owner ? ` by ${owner}` : ""}`;
}

function spotifyUrlSuffix(item: { external_urls?: SpotifyExternalUrls }): string {
  return item.external_urls?.spotify ? `\n   ${item.external_urls.spotify}` : "";
}

function artistNames(artists: SpotifyArtist[] | undefined): string {
  return (artists ?? []).map((artist) => artist.name).filter(Boolean).join(", ");
}

function spotifySearchResultCount(
  type: SpotifyItemType,
  result: {
    tracks?: SpotifyPagedResponse<SpotifyTrack>;
    artists?: SpotifyPagedResponse<SpotifyArtist>;
    albums?: SpotifyPagedResponse<SpotifyAlbum>;
    playlists?: SpotifyPagedResponse<SpotifyPlaylist>;
  }
): number {
  if (type === "track") return result.tracks?.items?.length ?? 0;
  if (type === "artist") return result.artists?.items?.length ?? 0;
  if (type === "album") return result.albums?.items?.length ?? 0;
  return result.playlists?.items?.length ?? 0;
}

function spotifyItemType(value: string | undefined, fallback: SpotifyItemType): SpotifyItemType;
function spotifyItemType(value: string | undefined, fallback?: undefined): SpotifyItemType | undefined;
function spotifyItemType(value: string | undefined, fallback?: SpotifyItemType): SpotifyItemType | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "track" || normalized === "artist" || normalized === "album" || normalized === "playlist") return normalized;
  if (fallback) return fallback;
  return undefined;
}

function spotifyMarket(config: SpotifyConfig | undefined): string {
  return config?.market?.trim().toUpperCase() || "US";
}

function spotifyErrorMessage(error: unknown, prefix: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${truncateForDiscord(message, 300)}`;
}

function boundedLimit(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
}

function safeFilename(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "playlist";
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
