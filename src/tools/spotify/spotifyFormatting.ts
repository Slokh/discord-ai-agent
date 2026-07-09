import { truncateForDiscord } from "../../util/text.js";
import type { AgentFile, AgentTable } from "../types.js";
import type {
  AlbumTrackFormat,
  ArtistDiscographyGroup,
  PlaylistTrackFormat,
  SpotifyAlbum,
  SpotifyAlbumTrack,
  SpotifyArtist,
  SpotifyAudiobook,
  SpotifyChapter,
  SpotifyEpisode,
  SpotifyExternalUrls,
  SpotifyPagedResponse,
  SpotifyPlaylist,
  SpotifyPlaylistTrack,
  SpotifySearchType,
  SpotifyShow,
  SpotifyTrack
} from "./spotifyTools.js";

export function formatSearchResults(
  query: string,
  type: SpotifySearchType,
  result: {
    tracks?: SpotifyPagedResponse<SpotifyTrack>;
    artists?: SpotifyPagedResponse<SpotifyArtist>;
    albums?: SpotifyPagedResponse<SpotifyAlbum>;
    playlists?: SpotifyPagedResponse<SpotifyPlaylist>;
    shows?: SpotifyPagedResponse<SpotifyShow>;
    episodes?: SpotifyPagedResponse<SpotifyEpisode>;
    audiobooks?: SpotifyPagedResponse<SpotifyAudiobook>;
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
          : type === "playlist"
            ? result.playlists?.items
            : type === "show"
              ? result.shows?.items
              : type === "episode"
                ? result.episodes?.items
                : result.audiobooks?.items;
  if (!items?.length) return [...lines, "No results."].join("\n");

  lines.push(
    ...items.map((item, index) => {
      if (type === "track") return `${index + 1}. ${trackLabel(item as SpotifyTrack)}${spotifyUrlSuffix(item as SpotifyTrack)}`;
      if (type === "artist") return `${index + 1}. ${artistLabel(item as SpotifyArtist)}${spotifyUrlSuffix(item as SpotifyArtist)}`;
      if (type === "album") return `${index + 1}. ${albumLabel(item as SpotifyAlbum)}${spotifyUrlSuffix(item as SpotifyAlbum)}`;
      if (type === "playlist") return `${index + 1}. ${playlistLabel(item as SpotifyPlaylist)}${spotifyUrlSuffix(item as SpotifyPlaylist)}`;
      if (type === "show") return `${index + 1}. ${(item as SpotifyShow).name || (item as SpotifyShow).id}${spotifyUrlSuffix(item as SpotifyShow)}`;
      if (type === "episode") return `${index + 1}. ${(item as SpotifyEpisode).name || (item as SpotifyEpisode).id}${spotifyUrlSuffix(item as SpotifyEpisode)}`;
      return `${index + 1}. ${(item as SpotifyAudiobook).name || (item as SpotifyAudiobook).id}${spotifyUrlSuffix(item as SpotifyAudiobook)}`;
    })
  );
  return lines.join("\n");
}

export function formatTrack(track: SpotifyTrack): string {
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

export function formatArtist(artist: SpotifyArtist): string {
  return [
    `Spotify artist: ${artistLabel(artist)}`,
    artist.external_urls?.spotify ? `- URL: ${artist.external_urls.spotify}` : null,
    "Supplied by Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatAlbum(album: SpotifyAlbum): string {
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

export function formatShow(show: SpotifyShow): string {
  const description = stripHtml(show.description ?? "").trim();
  return [
    `Spotify show: ${show.name || show.id}`,
    show.publisher ? `- Publisher: ${show.publisher}` : null,
    show.total_episodes != null ? `- Episodes: ${show.total_episodes}` : null,
    description ? `- Description: ${truncateForDiscord(description, 300)}` : null,
    show.external_urls?.spotify ? `- URL: ${show.external_urls.spotify}` : null,
    "Supplied by Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatEpisode(episode: SpotifyEpisode): string {
  const description = stripHtml(episode.description ?? "").trim();
  return [
    `Spotify episode: ${episode.name || episode.id}`,
    episode.show?.name ? `- Show: ${episode.show.name}` : null,
    episode.release_date ? `- Release date: ${episode.release_date}` : null,
    episode.duration_ms != null ? `- Duration: ${formatDuration(episode.duration_ms)}` : null,
    episode.explicit ? "- Explicit: yes" : null,
    description ? `- Description: ${truncateForDiscord(description, 300)}` : null,
    episode.external_urls?.spotify ? `- URL: ${episode.external_urls.spotify}` : null,
    "Supplied by Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatAudiobook(audiobook: SpotifyAudiobook): string {
  return [
    `Spotify audiobook: ${audiobook.name || audiobook.id}`,
    audiobook.authors?.length ? `- Authors: ${namesList(audiobook.authors)}` : null,
    audiobook.narrators?.length ? `- Narrators: ${namesList(audiobook.narrators)}` : null,
    audiobook.publisher ? `- Publisher: ${audiobook.publisher}` : null,
    audiobook.total_chapters != null ? `- Chapters: ${audiobook.total_chapters}` : null,
    audiobook.external_urls?.spotify ? `- URL: ${audiobook.external_urls.spotify}` : null,
    "Supplied by Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatChapter(chapter: SpotifyChapter): string {
  return [
    `Spotify chapter: ${chapter.name || chapter.id}`,
    chapter.audiobook?.name ? `- Audiobook: ${chapter.audiobook.name}` : null,
    chapter.chapter_number != null ? `- Chapter number: ${chapter.chapter_number}` : null,
    chapter.duration_ms != null ? `- Duration: ${formatDuration(chapter.duration_ms)}` : null,
    chapter.external_urls?.spotify ? `- URL: ${chapter.external_urls.spotify}` : null,
    "Supplied by Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatPlaylist(playlist: SpotifyPlaylist): string {
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

export function formatPlaylistTrackSummary(
  playlist: SpotifyPlaylist,
  tracks: NormalizedPlaylistTrack[],
  total: number,
  maxTracks: number,
  files: AgentFile[] | undefined,
  table: AgentTable | undefined
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
    files?.length ? `- Full track list attached: ${files.map((file) => file.name).join(", ")}` : null,
    table ? `- Queryable table: ${table.name} (${table.rows.length} rows)` : null,
    "Supplied by Spotify; track links open Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatPlaylistItemsForbidden(playlist: SpotifyPlaylist): string {
  return [
    formatPlaylist(playlist),
    "",
    "I can read the playlist metadata, but Spotify returned 403 for the full item list. Current playlist item access can be limited to playlist owners/collaborators for this app."
  ].join("\n");
}

export type NormalizedPlaylistTrack = {
  position: number;
  id: string;
  name: string;
  artists: string;
  artistNames: string[];
  album: string;
  duration: string;
  durationMs: number;
  addedAt: string;
  url: string;
  explicit: boolean;
  isLocal: boolean;
};

export function normalizePlaylistTrack(entry: SpotifyPlaylistTrack, index: number): NormalizedPlaylistTrack | undefined {
  const track = entry.item ?? entry.track;
  if (!track || track.type === "episode") return undefined;
  const artistNameList = (track.artists ?? []).map((artist) => artist.name).filter((name): name is string => Boolean(name));
  return {
    position: index + 1,
    id: track.id ?? "",
    name: track.name || "(unknown track)",
    artists: artistNameList.join(", "),
    artistNames: artistNameList,
    album: track.album?.name ?? "",
    durationMs: track.duration_ms ?? 0,
    duration: track.duration_ms != null ? formatDuration(track.duration_ms) : "",
    addedAt: entry.added_at ? entry.added_at.slice(0, 10) : "",
    url: track.external_urls?.spotify ?? "",
    explicit: Boolean(track.explicit),
    isLocal: Boolean(entry.is_local)
  };
}

export function normalizePlaylistTracks(tracks: SpotifyPlaylistTrack[]): NormalizedPlaylistTrack[] {
  return tracks.map(normalizePlaylistTrack).filter((track): track is NormalizedPlaylistTrack => Boolean(track));
}

export type NormalizedAlbumTrack = {
  position: number;
  id: string;
  name: string;
  artists: string;
  duration: string;
  durationMs: number;
  explicit: boolean;
  url: string;
};

export function normalizeAlbumTrack(track: SpotifyAlbumTrack, index: number, album: SpotifyAlbum): NormalizedAlbumTrack {
  return {
    position: track.track_number ?? index + 1,
    id: track.id ?? "",
    name: track.name || "(unknown track)",
    artists: artistNames(track.artists?.length ? track.artists : album.artists),
    duration: track.duration_ms != null ? formatDuration(track.duration_ms) : "",
    durationMs: track.duration_ms ?? 0,
    explicit: Boolean(track.explicit),
    url: track.external_urls?.spotify ?? ""
  };
}

type SingleStructuredFormat = Exclude<PlaylistTrackFormat, "both">;

export function playlistTracksFile(playlist: SpotifyPlaylist, tracks: NormalizedPlaylistTrack[], format: SingleStructuredFormat): AgentFile {
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

export function playlistTrackFiles(playlist: SpotifyPlaylist, tracks: NormalizedPlaylistTrack[], format: PlaylistTrackFormat): AgentFile[] {
  if (format === "both") return [playlistTracksFile(playlist, tracks, "csv"), playlistTracksFile(playlist, tracks, "text")];
  return [playlistTracksFile(playlist, tracks, format)];
}

export function playlistTracksTable(playlist: SpotifyPlaylist, tracks: NormalizedPlaylistTrack[]): AgentTable {
  const safeName = safeFilename(playlist.name || playlist.id);
  const columns = ["position", "track", "artists", "album", "duration", "duration_ms", "explicit", "local", "added_at", "spotify_url"];
  return {
    name: `spotify-playlist-${safeName}`,
    description: `Spotify playlist tracks for ${playlistLabel(playlist)}`,
    sourceFileName: `spotify-playlist-${safeName}.csv`,
    columns,
    rows: tracks.map((track) => ({
      position: track.position,
      track: track.name,
      artists: track.artists,
      album: track.album,
      duration: track.duration,
      duration_ms: track.durationMs,
      explicit: track.explicit,
      local: track.isLocal,
      added_at: track.addedAt,
      spotify_url: track.url
    }))
  };
}

export function albumTracksFile(album: SpotifyAlbum, tracks: NormalizedAlbumTrack[], format: SingleStructuredFormat): AgentFile {
  const safeName = safeFilename(album.name || album.id);
  if (format === "csv") {
    return {
      name: `spotify-album-${safeName}.csv`,
      contentType: "text/csv",
      data: Buffer.from(formatAlbumTracksCsv(tracks), "utf8")
    };
  }
  return {
    name: `spotify-album-${safeName}.txt`,
    contentType: "text/plain",
    data: Buffer.from(formatAlbumTracksText(album, tracks), "utf8")
  };
}

export function albumTrackFiles(album: SpotifyAlbum, tracks: NormalizedAlbumTrack[], format: AlbumTrackFormat): AgentFile[] {
  if (format === "both") return [albumTracksFile(album, tracks, "csv"), albumTracksFile(album, tracks, "text")];
  return [albumTracksFile(album, tracks, format)];
}

export function albumTracksTable(album: SpotifyAlbum, tracks: NormalizedAlbumTrack[]): AgentTable {
  const safeName = safeFilename(album.name || album.id);
  const columns = ["position", "track", "artists", "duration", "duration_ms", "explicit", "spotify_url"];
  return {
    name: `spotify-album-${safeName}`,
    description: `Spotify album tracks for ${albumLabel(album)}`,
    sourceFileName: `spotify-album-${safeName}.csv`,
    columns,
    rows: tracks.map((track) => ({
      position: track.position,
      track: track.name,
      artists: track.artists,
      duration: track.duration,
      duration_ms: track.durationMs,
      explicit: track.explicit,
      spotify_url: track.url
    }))
  };
}

export function artistDiscographyFile(artist: SpotifyArtist, albums: SpotifyAlbum[], format: SingleStructuredFormat): AgentFile {
  const safeName = safeFilename(artist.name || artist.id);
  if (format === "csv") {
    return {
      name: `spotify-artist-${safeName}-discography.csv`,
      contentType: "text/csv",
      data: Buffer.from(formatArtistDiscographyCsv(albums), "utf8")
    };
  }
  return {
    name: `spotify-artist-${safeName}-discography.txt`,
    contentType: "text/plain",
    data: Buffer.from(formatArtistDiscographyText(artist, albums), "utf8")
  };
}

export function artistDiscographyFiles(artist: SpotifyArtist, albums: SpotifyAlbum[], format: AlbumTrackFormat): AgentFile[] {
  if (format === "both") return [artistDiscographyFile(artist, albums, "csv"), artistDiscographyFile(artist, albums, "text")];
  return [artistDiscographyFile(artist, albums, format)];
}

export function artistDiscographyTable(artist: SpotifyArtist, albums: SpotifyAlbum[]): AgentTable {
  const safeName = safeFilename(artist.name || artist.id);
  const columns = ["position", "album", "type", "release_date", "tracks", "spotify_url"];
  return {
    name: `spotify-artist-${safeName}-discography`,
    description: `Spotify artist discography for ${artistLabel(artist)}`,
    sourceFileName: `spotify-artist-${safeName}-discography.csv`,
    columns,
    rows: albums.map((album, index) => ({
      position: index + 1,
      album: album.name ?? album.id,
      type: album.album_type ?? "",
      release_date: album.release_date ?? "",
      tracks: album.total_tracks ?? null,
      spotify_url: album.external_urls?.spotify ?? ""
    }))
  };
}

export function formatAlbumTrackSummary(
  album: SpotifyAlbum,
  tracks: NormalizedAlbumTrack[],
  total: number,
  maxTracks: number,
  files: AgentFile[] | undefined,
  table: AgentTable | undefined
): string {
  return [
    `Spotify album: ${albumLabel(album)}`,
    album.release_date ? `- Release date: ${album.release_date}` : null,
    `- Tracks fetched: ${tracks.length} of ${total || album.total_tracks || tracks.length}${maxTracks < total ? ` (capped at ${maxTracks})` : ""}`,
    `- Total duration fetched: ${formatDuration(sum(tracks.map((track) => track.durationMs)))}`,
    tracks.some((track) => track.explicit) ? `- Explicit tracks: ${tracks.filter((track) => track.explicit).length}` : null,
    files?.length ? `- Full album track list attached: ${files.map((file) => file.name).join(", ")}` : null,
    table ? `- Queryable table: ${table.name} (${table.rows.length} rows)` : null,
    album.external_urls?.spotify ? `- URL: ${album.external_urls.spotify}` : null,
    "Supplied by Spotify; track links open Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatArtistDiscography(
  artist: SpotifyArtist,
  albums: SpotifyAlbum[],
  total: number,
  maxItems: number,
  includeGroups: ArtistDiscographyGroup[],
  files: AgentFile[] | undefined,
  table: AgentTable | undefined
): string {
  const byType = countBy(albums.map((album) => album.album_type || "unknown"));
  const oldestFetched = albums.length > 0 ? albums[albums.length - 1] : undefined;
  return [
    `Spotify artist discography: ${artistLabel(artist)}`,
    `- Groups: ${includeGroups.join(", ")}`,
    `- Items fetched: ${albums.length} of ${total || albums.length}${maxItems < total ? ` (capped at ${maxItems})` : ""}`,
    `- By type: ${formatCounts(byType, 6) || "none"}`,
    albums[0]?.release_date ? `- Newest listed: ${albums[0].name || albums[0].id} (${albums[0].release_date})` : null,
    oldestFetched?.release_date ? `- Oldest listed in fetched set: ${oldestFetched.name || oldestFetched.id} (${oldestFetched.release_date})` : null,
    files?.length ? `- Full discography list attached: ${files.map((file) => file.name).join(", ")}` : null,
    table ? `- Queryable table: ${table.name} (${table.rows.length} rows)` : null,
    artist.external_urls?.spotify ? `- URL: ${artist.external_urls.spotify}` : null,
    "Supplied by Spotify; album links open Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatPlaylistStats(
  playlist: SpotifyPlaylist,
  tracks: NormalizedPlaylistTrack[],
  total: number,
  maxTracks: number
): string {
  const artistCounts = countBy(tracks.flatMap((track) => track.artistNames.length ? track.artistNames : ["(unknown artist)"]));
  const albumCounts = countBy(tracks.map((track) => track.album || "(unknown album)"));
  const repeatedArtists = [...artistCounts.entries()].filter(([, count]) => count > 1).length;
  return [
    `Spotify playlist stats: ${playlistLabel(playlist)}`,
    `- Tracks analyzed: ${tracks.length} of ${total || playlist.tracks?.total || tracks.length}${maxTracks < total ? ` (capped at ${maxTracks})` : ""}`,
    `- Total duration: ${formatDuration(sum(tracks.map((track) => track.durationMs)))}`,
    `- Explicit tracks: ${tracks.filter((track) => track.explicit).length}`,
    `- Local/unavailable tracks: ${tracks.filter((track) => track.isLocal || !track.id).length}`,
    `- Unique artists: ${artistCounts.size}`,
    `- Repeated artists: ${repeatedArtists}`,
    `- Top artists: ${formatCounts(artistCounts, 8) || "none"}`,
    `- Top albums: ${formatCounts(albumCounts, 5) || "none"}`,
    playlist.external_urls?.spotify ? `- URL: ${playlist.external_urls.spotify}` : null,
    "Supplied by Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatPlaylistComparison(
  playlistA: SpotifyPlaylist,
  tracksA: NormalizedPlaylistTrack[],
  playlistB: SpotifyPlaylist,
  tracksB: NormalizedPlaylistTrack[],
  maxTracks: number
): string {
  const mapA = trackMap(tracksA);
  const mapB = trackMap(tracksB);
  const sharedTrackKeys = [...mapA.keys()].filter((key) => mapB.has(key));
  const unionTrackCount = new Set([...mapA.keys(), ...mapB.keys()]).size;
  const artistA = new Set(tracksA.flatMap((track) => track.artistNames.map(normalizedName)));
  const artistB = new Set(tracksB.flatMap((track) => track.artistNames.map(normalizedName)));
  const sharedArtists = [...artistA].filter((artist) => artistB.has(artist) && artist);
  const overlap = unionTrackCount > 0 ? Math.round((sharedTrackKeys.length / unionTrackCount) * 100) : 0;
  const sharedTrackLabels = sharedTrackKeys.slice(0, 10).map((key) => {
    const track = mapA.get(key);
    return track ? `${track.name}${track.artists ? ` - ${track.artists}` : ""}` : key;
  });
  return [
    `Spotify playlist comparison: ${playlistLabel(playlistA)} vs ${playlistLabel(playlistB)}`,
    `- Tracks analyzed: ${tracksA.length} vs ${tracksB.length}${maxTracks < Math.max(tracksA.length, tracksB.length) ? ` (capped at ${maxTracks})` : ""}`,
    `- Shared tracks: ${sharedTrackKeys.length}`,
    `- Track overlap score: ${overlap}%`,
    `- Shared artists: ${sharedArtists.length}`,
    sharedArtists.length ? `- Shared artist examples: ${titleList(sharedArtists.slice(0, 10)).join(", ")}` : null,
    sharedTrackLabels.length ? `- Shared track examples: ${sharedTrackLabels.join("; ")}` : null,
    `- Unique tracks in first playlist: ${[...mapA.keys()].filter((key) => !mapB.has(key)).length}`,
    `- Unique tracks in second playlist: ${[...mapB.keys()].filter((key) => !mapA.has(key)).length}`,
    "Supplied by Spotify."
  ]
    .filter(Boolean)
    .join("\n");
}

export function spotifySearchResultCount(
  type: SpotifySearchType,
  result: {
    tracks?: SpotifyPagedResponse<SpotifyTrack>;
    artists?: SpotifyPagedResponse<SpotifyArtist>;
    albums?: SpotifyPagedResponse<SpotifyAlbum>;
    playlists?: SpotifyPagedResponse<SpotifyPlaylist>;
    shows?: SpotifyPagedResponse<SpotifyShow>;
    episodes?: SpotifyPagedResponse<SpotifyEpisode>;
    audiobooks?: SpotifyPagedResponse<SpotifyAudiobook>;
  }
): number {
  if (type === "track") return result.tracks?.items?.length ?? 0;
  if (type === "artist") return result.artists?.items?.length ?? 0;
  if (type === "album") return result.albums?.items?.length ?? 0;
  if (type === "playlist") return result.playlists?.items?.length ?? 0;
  if (type === "show") return result.shows?.items?.length ?? 0;
  if (type === "episode") return result.episodes?.items?.length ?? 0;
  return result.audiobooks?.items?.length ?? 0;
}

export function artistDiscographyGroups(input: string[] | undefined): ArtistDiscographyGroup[] {
  const allowed: ArtistDiscographyGroup[] = ["album", "single", "appears_on", "compilation"];
  const requested = (input ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is ArtistDiscographyGroup => allowed.includes(value as ArtistDiscographyGroup));
  return requested.length > 0 ? [...new Set(requested)] : allowed;
}

export function dedupeAlbums(albums: SpotifyAlbum[]): SpotifyAlbum[] {
  const seen = new Set<string>();
  const result: SpotifyAlbum[] = [];
  for (const album of albums) {
    const key = album.id || `${normalizedName(album.name)}:${album.release_date ?? ""}:${album.album_type ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(album);
  }
  return result;
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

function formatAlbumTracksText(album: SpotifyAlbum, tracks: NormalizedAlbumTrack[]): string {
  return [
    `Spotify album: ${albumLabel(album)}`,
    album.external_urls?.spotify ? `URL: ${album.external_urls.spotify}` : null,
    "Supplied by Spotify.",
    "",
    ...tracks.map((track) => {
      const parts = [
        `${track.position}. ${track.name}`,
        track.artists ? `- ${track.artists}` : null,
        track.duration ? `[${track.duration}]` : null,
        track.explicit ? "explicit" : null,
        track.url || null
      ].filter(Boolean);
      return parts.join(" ");
    })
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

function formatArtistDiscographyText(artist: SpotifyArtist, albums: SpotifyAlbum[]): string {
  return [
    `Spotify artist discography: ${artistLabel(artist)}`,
    artist.external_urls?.spotify ? `URL: ${artist.external_urls.spotify}` : null,
    "Supplied by Spotify.",
    "",
    ...albums.map((album, index) => {
      const pieces = [
        `${index + 1}. ${album.name || album.id}`,
        album.album_type ? `[${album.album_type}]` : null,
        album.release_date ? album.release_date : null,
        album.total_tracks != null ? `${album.total_tracks} tracks` : null,
        album.external_urls?.spotify || null
      ].filter(Boolean);
      return pieces.join(" - ");
    })
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

function formatPlaylistTracksCsv(tracks: NormalizedPlaylistTrack[]): string {
  const rows = [["position", "track", "artists", "album", "duration", "duration_ms", "explicit", "local", "added_at", "spotify_url"], ...tracks.map((track) => [
    String(track.position),
    track.name,
    track.artists,
    track.album,
    track.duration,
    String(track.durationMs),
    track.explicit ? "true" : "false",
    track.isLocal ? "true" : "false",
    track.addedAt,
    track.url
  ])];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function formatAlbumTracksCsv(tracks: NormalizedAlbumTrack[]): string {
  const rows = [["position", "track", "artists", "duration", "duration_ms", "explicit", "spotify_url"], ...tracks.map((track) => [
    String(track.position),
    track.name,
    track.artists,
    track.duration,
    String(track.durationMs),
    track.explicit ? "true" : "false",
    track.url
  ])];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function formatArtistDiscographyCsv(albums: SpotifyAlbum[]): string {
  const rows = [["position", "album", "type", "release_date", "tracks", "spotify_url"], ...albums.map((album, index) => [
    String(index + 1),
    album.name ?? album.id,
    album.album_type ?? "",
    album.release_date ?? "",
    album.total_tracks != null ? String(album.total_tracks) : "",
    album.external_urls?.spotify ?? ""
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

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rawValue of values) {
    const value = rawValue.trim() || "(unknown)";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function formatCounts(counts: Map<string, number>, limit: number): string {
  return [...counts.entries()]
    .slice(0, limit)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function namesList(values: Array<{ name?: string }>): string {
  return values.map((value) => value.name).filter(Boolean).join(", ");
}

function trackMap(tracks: NormalizedPlaylistTrack[]): Map<string, NormalizedPlaylistTrack> {
  const map = new Map<string, NormalizedPlaylistTrack>();
  for (const track of tracks) {
    const key = track.id || `${normalizedName(track.name)}:${normalizedName(track.artists)}`;
    if (!map.has(key)) map.set(key, track);
  }
  return map;
}

function normalizedName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function titleList(values: string[]): string[] {
  return values.map((value) => value.replace(/\b\w/g, (letter) => letter.toUpperCase()));
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
