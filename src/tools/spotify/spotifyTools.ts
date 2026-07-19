import { summarizeForAudit, truncateForDiscord } from "../../util/text.js";
import type { AgentFile, AgentResponse, AgentTable, ToolContext } from "../types.js";
import {
  albumTrackFiles,
  albumTracksTable,
  artistDiscographyFiles,
  artistDiscographyGroups,
  artistDiscographyTable,
  dedupeAlbums,
  formatAlbum,
  formatAlbumTrackSummary,
  formatArtist,
  formatArtistDiscography,
  formatAudiobook,
  formatChapter,
  formatEpisode,
  formatPlaylist,
  formatPlaylistComparison,
  formatPlaylistItemsForbidden,
  formatPlaylistStats,
  formatPlaylistTrackSummary,
  formatSearchResults,
  formatShow,
  formatTrack,
  normalizeAlbumTrack,
  normalizePlaylistTracks,
  playlistTrackFiles,
  playlistTracksTable,
  spotifySearchResultCount
} from "./spotifyFormatting.js";
import type {
  AlbumTrackFormat,
  ArtistDiscographyGroup,
  PlaylistTrackFormat,
  SpotifyAlbum,
  SpotifyAlbumTrack,
  SpotifyArtist,
  SpotifyAudiobook,
  SpotifyChapter,
  SpotifyConfig,
  SpotifyEpisode,
  SpotifyItemType,
  SpotifyPagedResponse,
  SpotifyPlaylist,
  SpotifyPlaylistTrack,
  SpotifySearchType,
  SpotifyShow,
  SpotifyTrack,
} from "./spotifyTypes.js";

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_REQUEST_TIMEOUT_MS = 15_000;
const PLAYLIST_ITEMS_PAGE_SIZE = 50;
const DEFAULT_PLAYLIST_TRACK_LIMIT = 10_000;
const MAX_PLAYLIST_TRACKS = 10_000;
const DEFAULT_ALBUM_TRACK_LIMIT = 200;
const MAX_ALBUM_TRACKS = 500;
const DEFAULT_ARTIST_DISCOGRAPHY_LIMIT = 50;
const MAX_ARTIST_DISCOGRAPHY_ITEMS = 200;
const DEFAULT_PLAYLIST_COMPARE_LIMIT = 10_000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const SPOTIFY_STORED_CONTENT = "Spotify response omitted from conversation memory and artifacts.";

type SpotifyToken = {
  clientId: string;
  accessToken: string;
  expiresAt: number;
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

function spotifyMarket(config: SpotifyConfig | undefined): string {
  return config?.market?.trim() || "US";
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

  const urlMatch = trimmed.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(playlist|artist|track|album|show|episode|audiobook|chapter)\/([A-Za-z0-9]+)/i);
  if (urlMatch) {
    const type = urlMatch[1].toLowerCase() as SpotifyItemType;
    if (expectedType && type !== expectedType) return undefined;
    return { type, id: urlMatch[2] };
  }

  const uriMatch = trimmed.match(/^spotify:(playlist|artist|track|album|show|episode|audiobook|chapter):([A-Za-z0-9]+)$/i);
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
  const type = spotifySearchType(input.type, "track");
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
      shows?: SpotifyPagedResponse<SpotifyShow>;
      episodes?: SpotifyPagedResponse<SpotifyEpisode>;
      audiobooks?: SpotifyPagedResponse<SpotifyAudiobook>;
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
      "I could not find a Spotify item ID in that input. Pass an open.spotify.com URL, a spotify: URI, or a bare ID with type=track/artist/album/playlist/show/episode/audiobook/chapter."
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
  const format: PlaylistTrackFormat = spotifyStructuredFormat(input.format);

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
    let trackPage: { tracks: SpotifyPlaylistTrack[]; total: number };
    try {
      trackPage = await fetchPlaylistTrackPages(ctx.config.spotify, playlistRef.id, maxTracks);
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 403) {
        await audit(ctx, "getSpotifyPlaylistTracks", { playlistId: playlistRef.id, error: "playlist_items_forbidden" });
        return spotifyResponse(formatPlaylistItemsForbidden(playlist));
      } else {
        throw error;
      }
    }

    const normalized = normalizePlaylistTracks(trackPage.tracks);
    const files = normalized.length > 0 ? playlistTrackFiles(playlist, normalized, format) : [];
    const table = normalized.length > 0 ? playlistTracksTable(playlist, normalized) : undefined;
    const content = formatPlaylistTrackSummary(playlist, normalized, trackPage.total, maxTracks, files, table);
    await audit(ctx, "getSpotifyPlaylistTracks", {
      playlistId: playlistRef.id,
      total: trackPage.total,
      returned: normalized.length,
      attachments: files.map((file) => file.name),
      table: table?.name
    });
    return spotifyResponse(content, files, table ? [table] : undefined);
  } catch (error) {
    const message = spotifyErrorMessage(error, "I could not read that Spotify playlist");
    await audit(ctx, "getSpotifyPlaylistTracks", { playlistId: playlistRef.id, error: message });
    return spotifyResponse(message);
  }
}

export async function getSpotifyAlbumTracks(
  ctx: ToolContext,
  input: { albumIdOrUrl: string; limit?: number; format?: string }
): Promise<AgentResponse> {
  const albumRef = parseSpotifyReference(input.albumIdOrUrl, "album");
  const maxTracks = boundedLimit(input.limit, DEFAULT_ALBUM_TRACK_LIMIT, 1, MAX_ALBUM_TRACKS);
  const format: AlbumTrackFormat = spotifyStructuredFormat(input.format);

  if (!albumRef) {
    await audit(ctx, "getSpotifyAlbumTracks", { input: input.albumIdOrUrl, error: "invalid_album_id" });
    return spotifyResponse("I could not find a Spotify album ID in that input. Pass an album ID, open.spotify.com album URL, or spotify:album URI.");
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "getSpotifyAlbumTracks", { albumId: albumRef.id, error: "not_configured" });
    return spotifyResponse("Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to read album tracks.");
  }

  try {
    const album = await fetchSpotifyAlbum(ctx.config.spotify, albumRef.id);
    const trackPage = await fetchAlbumTrackPages(ctx.config.spotify, albumRef.id, maxTracks);
    const normalized = trackPage.tracks.map((track, index) => normalizeAlbumTrack(track, index, album));
    const files = normalized.length > 0 ? albumTrackFiles(album, normalized, format) : [];
    const table = normalized.length > 0 ? albumTracksTable(album, normalized) : undefined;
    const content = formatAlbumTrackSummary(album, normalized, trackPage.total, maxTracks, files, table);
    await audit(ctx, "getSpotifyAlbumTracks", {
      albumId: albumRef.id,
      total: trackPage.total,
      returned: normalized.length,
      attachments: files.map((file) => file.name),
      table: table?.name
    });
    return spotifyResponse(content, files, table ? [table] : undefined);
  } catch (error) {
    const message = spotifyErrorMessage(error, "I could not read that Spotify album");
    await audit(ctx, "getSpotifyAlbumTracks", { albumId: albumRef.id, error: message });
    return spotifyResponse(message);
  }
}

export async function getSpotifyArtistDiscography(
  ctx: ToolContext,
  input: { artistIdOrUrl: string; includeGroups?: string[]; limit?: number; format?: string }
): Promise<AgentResponse> {
  const artistRef = parseSpotifyReference(input.artistIdOrUrl, "artist");
  const maxItems = boundedLimit(input.limit, DEFAULT_ARTIST_DISCOGRAPHY_LIMIT, 1, MAX_ARTIST_DISCOGRAPHY_ITEMS);
  const includeGroups = artistDiscographyGroups(input.includeGroups);
  const format: AlbumTrackFormat = spotifyStructuredFormat(input.format);

  if (!artistRef) {
    await audit(ctx, "getSpotifyArtistDiscography", { input: input.artistIdOrUrl, error: "invalid_artist_id" });
    return spotifyResponse("I could not find a Spotify artist ID in that input. Pass an artist ID, open.spotify.com artist URL, or spotify:artist URI.");
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "getSpotifyArtistDiscography", { artistId: artistRef.id, error: "not_configured" });
    return spotifyResponse("Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to read artist discographies.");
  }

  try {
    const artist = await spotifyFetch<SpotifyArtist>(`/artists/${artistRef.id}`, ctx.config.spotify);
    const page = await fetchArtistAlbumPages(ctx.config.spotify, artistRef.id, includeGroups, maxItems);
    const albums = dedupeAlbums(page.albums);
    const files = albums.length > 0 ? artistDiscographyFiles(artist, albums, format) : [];
    const table = albums.length > 0 ? artistDiscographyTable(artist, albums) : undefined;
    const content = formatArtistDiscography(artist, albums, page.total, maxItems, includeGroups, files, table);
    await audit(ctx, "getSpotifyArtistDiscography", {
      artistId: artistRef.id,
      includeGroups,
      total: page.total,
      returned: albums.length,
      attachments: files.map((file) => file.name),
      table: table?.name
    });
    return spotifyResponse(content, files, table ? [table] : undefined);
  } catch (error) {
    const message = spotifyErrorMessage(error, "I could not read that Spotify artist discography");
    await audit(ctx, "getSpotifyArtistDiscography", { artistId: artistRef.id, error: message });
    return spotifyResponse(message);
  }
}

export async function getSpotifyPlaylistStats(
  ctx: ToolContext,
  input: { playlistIdOrUrl: string; limit?: number }
): Promise<AgentResponse> {
  const playlistRef = parseSpotifyReference(input.playlistIdOrUrl, "playlist");
  const maxTracks = boundedLimit(input.limit, DEFAULT_PLAYLIST_COMPARE_LIMIT, 1, MAX_PLAYLIST_TRACKS);

  if (!playlistRef) {
    await audit(ctx, "getSpotifyPlaylistStats", { input: input.playlistIdOrUrl, error: "invalid_playlist_id" });
    return spotifyResponse("I could not find a Spotify playlist ID in that input. Pass a playlist ID, open.spotify.com playlist URL, or spotify:playlist URI.");
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "getSpotifyPlaylistStats", { playlistId: playlistRef.id, error: "not_configured" });
    return spotifyResponse("Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to analyze playlist stats.");
  }

  try {
    const playlist = await fetchSpotifyPlaylist(ctx.config.spotify, playlistRef.id);
    const tracks = await fetchPlaylistTracksWith403Handling(ctx, playlist, playlistRef.id, maxTracks, "getSpotifyPlaylistStats");
    if (!tracks) return spotifyResponse(formatPlaylistItemsForbidden(playlist));
    const normalized = normalizePlaylistTracks(tracks.tracks);
    const content = formatPlaylistStats(playlist, normalized, tracks.total, maxTracks);
    await audit(ctx, "getSpotifyPlaylistStats", { playlistId: playlistRef.id, total: tracks.total, returned: normalized.length });
    return spotifyResponse(content);
  } catch (error) {
    const message = spotifyErrorMessage(error, "I could not analyze that Spotify playlist");
    await audit(ctx, "getSpotifyPlaylistStats", { playlistId: playlistRef.id, error: message });
    return spotifyResponse(message);
  }
}

export async function compareSpotifyPlaylists(
  ctx: ToolContext,
  input: { playlistAIdOrUrl: string; playlistBIdOrUrl: string; limit?: number }
): Promise<AgentResponse> {
  const playlistARef = parseSpotifyReference(input.playlistAIdOrUrl, "playlist");
  const playlistBRef = parseSpotifyReference(input.playlistBIdOrUrl, "playlist");
  const maxTracks = boundedLimit(input.limit, DEFAULT_PLAYLIST_COMPARE_LIMIT, 1, MAX_PLAYLIST_TRACKS);

  if (!playlistARef || !playlistBRef) {
    await audit(ctx, "compareSpotifyPlaylists", { error: "invalid_playlist_id" });
    return spotifyResponse("I need two Spotify playlist IDs, open.spotify.com playlist URLs, or spotify:playlist URIs to compare playlists.");
  }
  if (!isSpotifyConfigured(ctx.config.spotify)) {
    await audit(ctx, "compareSpotifyPlaylists", { playlistAId: playlistARef.id, playlistBId: playlistBRef.id, error: "not_configured" });
    return spotifyResponse("Spotify is not configured on this bot. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to compare playlists.");
  }

  try {
    const playlistA = await fetchSpotifyPlaylist(ctx.config.spotify, playlistARef.id);
    const playlistB = await fetchSpotifyPlaylist(ctx.config.spotify, playlistBRef.id);
    const tracksA = await fetchPlaylistTracksWith403Handling(ctx, playlistA, playlistARef.id, maxTracks, "compareSpotifyPlaylists");
    const tracksB = await fetchPlaylistTracksWith403Handling(ctx, playlistB, playlistBRef.id, maxTracks, "compareSpotifyPlaylists");
    if (!tracksA || !tracksB) {
      return spotifyResponse("I can read both playlist metadata records, but Spotify returned 403 for at least one full item list, so I cannot compare their tracks safely.");
    }
    const normalizedA = normalizePlaylistTracks(tracksA.tracks);
    const normalizedB = normalizePlaylistTracks(tracksB.tracks);
    const content = formatPlaylistComparison(playlistA, normalizedA, playlistB, normalizedB, maxTracks);
    await audit(ctx, "compareSpotifyPlaylists", {
      playlistAId: playlistARef.id,
      playlistBId: playlistBRef.id,
      playlistATracks: normalizedA.length,
      playlistBTracks: normalizedB.length
    });
    return spotifyResponse(content);
  } catch (error) {
    const message = spotifyErrorMessage(error, "I could not compare those Spotify playlists");
    await audit(ctx, "compareSpotifyPlaylists", { playlistAId: playlistARef.id, playlistBId: playlistBRef.id, error: message });
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
    const album = await fetchSpotifyAlbum(ctx.config.spotify, reference.id);
    return formatAlbum(album);
  }
  if (reference.type === "playlist") {
    const playlist = await fetchSpotifyPlaylist(ctx.config.spotify, reference.id);
    return formatPlaylist(playlist);
  }
  if (reference.type === "show") {
    const params = new URLSearchParams({ market: spotifyMarket(ctx.config.spotify) });
    const show = await spotifyFetch<SpotifyShow>(`/shows/${reference.id}?${params.toString()}`, ctx.config.spotify);
    return formatShow(show);
  }
  if (reference.type === "episode") {
    const params = new URLSearchParams({ market: spotifyMarket(ctx.config.spotify) });
    const episode = await spotifyFetch<SpotifyEpisode>(`/episodes/${reference.id}?${params.toString()}`, ctx.config.spotify);
    return formatEpisode(episode);
  }
  if (reference.type === "audiobook") {
    const params = new URLSearchParams({ market: spotifyMarket(ctx.config.spotify) });
    const audiobook = await spotifyFetch<SpotifyAudiobook>(`/audiobooks/${reference.id}?${params.toString()}`, ctx.config.spotify);
    return formatAudiobook(audiobook);
  }
  const params = new URLSearchParams({ market: spotifyMarket(ctx.config.spotify) });
  const chapter = await spotifyFetch<SpotifyChapter>(`/chapters/${reference.id}?${params.toString()}`, ctx.config.spotify);
  return formatChapter(chapter);
}

async function fetchSpotifyAlbum(config: SpotifyConfig, albumId: string): Promise<SpotifyAlbum> {
  const params = new URLSearchParams({ market: spotifyMarket(config) });
  return await spotifyFetch<SpotifyAlbum>(`/albums/${albumId}?${params.toString()}`, config);
}

async function fetchSpotifyPlaylist(config: SpotifyConfig, playlistId: string): Promise<SpotifyPlaylist> {
  const params = new URLSearchParams({
    market: spotifyMarket(config),
    fields: "id,name,description,owner(id,display_name,external_urls.spotify),tracks(total),external_urls.spotify"
  });
  return await spotifyFetch<SpotifyPlaylist>(`/playlists/${playlistId}?${params.toString()}`, config);
}

async function fetchPlaylistTracksWith403Handling(
  ctx: ToolContext,
  playlist: SpotifyPlaylist,
  playlistId: string,
  maxTracks: number,
  toolName: string
): Promise<{ tracks: SpotifyPlaylistTrack[]; total: number } | null> {
  try {
    return await fetchPlaylistTrackPages(ctx.config.spotify, playlistId, maxTracks);
  } catch (error) {
    if (error instanceof SpotifyApiError && error.status === 403) {
      await audit(ctx, toolName, { playlistId: playlist.id, error: "playlist_items_forbidden" });
      return null;
    }
    throw error;
  }
}

async function fetchPlaylistTrackPages(
  config: SpotifyConfig,
  playlistId: string,
  maxTracks: number
): Promise<{ tracks: SpotifyPlaylistTrack[]; total: number }> {
  const tracks: SpotifyPlaylistTrack[] = [];
  let offset = 0;
  let total = 0;

  do {
    const params = new URLSearchParams({
      limit: String(PLAYLIST_ITEMS_PAGE_SIZE),
      offset: String(offset),
      market: spotifyMarket(config),
      fields:
        "total,limit,offset,next,items(added_at,is_local,item(id,name,type,duration_ms,explicit,external_urls.spotify,uri,artists(id,name,external_urls.spotify),album(id,name,external_urls.spotify,release_date)),track(id,name,type,duration_ms,explicit,external_urls.spotify,uri,artists(id,name,external_urls.spotify),album(id,name,external_urls.spotify,release_date)))"
    });
    const page = await spotifyFetch<SpotifyPagedResponse<SpotifyPlaylistTrack>>(
      `/playlists/${playlistId}/items?${params.toString()}`,
      config
    );
    const items = page.items ?? [];
    total = page.total ?? Math.max(total, offset + items.length);
    tracks.push(...items);
    offset += items.length;
    if (!page.next || items.length === 0) break;
  } while (tracks.length < maxTracks && offset < total);

  return { tracks: tracks.slice(0, maxTracks), total };
}

async function fetchAlbumTrackPages(
  config: SpotifyConfig,
  albumId: string,
  maxTracks: number
): Promise<{ tracks: SpotifyAlbumTrack[]; total: number }> {
  const tracks: SpotifyAlbumTrack[] = [];
  let offset = 0;
  let total = 0;

  do {
    const params = new URLSearchParams({
      limit: "50",
      offset: String(offset),
      market: spotifyMarket(config)
    });
    const page = await spotifyFetch<SpotifyPagedResponse<SpotifyAlbumTrack>>(`/albums/${albumId}/tracks?${params.toString()}`, config);
    const items = page.items ?? [];
    total = page.total ?? Math.max(total, offset + items.length);
    tracks.push(...items);
    offset += items.length;
    if (!page.next || items.length === 0) break;
  } while (tracks.length < maxTracks && offset < total);

  return { tracks: tracks.slice(0, maxTracks), total };
}

async function fetchArtistAlbumPages(
  config: SpotifyConfig,
  artistId: string,
  includeGroups: ArtistDiscographyGroup[],
  maxItems: number
): Promise<{ albums: SpotifyAlbum[]; total: number }> {
  const albums: SpotifyAlbum[] = [];
  let offset = 0;
  let total = 0;

  do {
    const params = new URLSearchParams({
      include_groups: includeGroups.join(","),
      limit: "50",
      offset: String(offset),
      market: spotifyMarket(config)
    });
    const page = await spotifyFetch<SpotifyPagedResponse<SpotifyAlbum>>(`/artists/${artistId}/albums?${params.toString()}`, config);
    const items = page.items ?? [];
    total = page.total ?? Math.max(total, offset + items.length);
    albums.push(...items);
    offset += items.length;
    if (!page.next || items.length === 0) break;
  } while (albums.length < maxItems && offset < total);

  return { albums: albums.slice(0, maxItems), total };
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

function spotifyResponse(content: string, files?: AgentFile[], tables?: AgentTable[], meta: Pick<AgentResponse, "status" | "errorCode" | "retryable" | "limitation"> = {}): AgentResponse {
  return {
    content,
    ...spotifyResponseMetadata(content),
    ...meta,
    files: files?.length ? files : undefined,
    tables: tables?.length ? tables : undefined,
    storedContent: SPOTIFY_STORED_CONTENT
  };
}

function spotifyResponseMetadata(content: string): Pick<AgentResponse, "status" | "errorCode" | "retryable" | "limitation"> {
  if (content.startsWith("Spotify rate-limited")) return { status: "error", errorCode: "rate_limited", retryable: true };
  if (content.includes("Spotify is not configured")) return { status: "error", errorCode: "not_configured", retryable: false };
  if (content.startsWith("I need ") || content.startsWith("I could not find a Spotify")) return { status: "error", errorCode: "invalid_input", retryable: false };
  if (content.startsWith("I could not ")) return { status: "error", errorCode: "upstream_error", retryable: true };
  if (content.includes("could not read playlist items")) return { status: "error", errorCode: "permission_denied", retryable: false };
  if (content.includes("truncated") || content.includes("limited to")) return { status: "partial", limitation: "result_limited" };
  return {};
}

function spotifyItemType(value: string | undefined, fallback: SpotifyItemType): SpotifyItemType;
function spotifyItemType(value: string | undefined, fallback?: undefined): SpotifyItemType | undefined;
function spotifyItemType(value: string | undefined, fallback?: SpotifyItemType): SpotifyItemType | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "track" ||
    normalized === "artist" ||
    normalized === "album" ||
    normalized === "playlist" ||
    normalized === "show" ||
    normalized === "episode" ||
    normalized === "audiobook" ||
    normalized === "chapter"
  ) {
    return normalized;
  }
  if (fallback) return fallback;
  return undefined;
}

function spotifySearchType(value: string | undefined, fallback: SpotifySearchType): SpotifySearchType {
  const type = spotifyItemType(value, fallback);
  return type === "chapter" ? fallback : type;
}

function spotifyStructuredFormat(value: string | undefined): PlaylistTrackFormat {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "text" || normalized === "csv" || normalized === "both") return normalized;
  return "both";
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
