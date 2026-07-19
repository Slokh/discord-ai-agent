export type SpotifyConfig = {
  clientId?: string;
  clientSecret?: string;
  market?: string;
};

export type SpotifyItemType = "track" | "artist" | "album" | "playlist" | "show" | "episode" | "audiobook" | "chapter";
export type SpotifySearchType = Exclude<SpotifyItemType, "chapter">;
export type PlaylistTrackFormat = "text" | "csv" | "both";
export type AlbumTrackFormat = "text" | "csv" | "both";
export type ArtistDiscographyGroup = "album" | "single" | "appears_on" | "compilation";

export type SpotifyExternalUrls = { spotify?: string };

export type SpotifyArtist = {
  id: string;
  name?: string;
  external_urls?: SpotifyExternalUrls;
};

export type SpotifyAlbum = {
  id: string;
  name?: string;
  album_type?: string;
  release_date?: string;
  total_tracks?: number;
  artists?: SpotifyArtist[];
  external_urls?: SpotifyExternalUrls;
};

export type SpotifyShow = {
  id: string;
  name?: string;
  publisher?: string;
  description?: string;
  total_episodes?: number;
  external_urls?: SpotifyExternalUrls;
};

export type SpotifyEpisode = {
  id: string;
  name?: string;
  description?: string;
  release_date?: string;
  duration_ms?: number;
  explicit?: boolean;
  external_urls?: SpotifyExternalUrls;
  show?: SpotifyShow;
};

export type SpotifyAudiobook = {
  id: string;
  name?: string;
  authors?: Array<{ name?: string }>;
  narrators?: Array<{ name?: string }>;
  publisher?: string;
  total_chapters?: number;
  external_urls?: SpotifyExternalUrls;
};

export type SpotifyChapter = {
  id: string;
  name?: string;
  duration_ms?: number;
  chapter_number?: number;
  external_urls?: SpotifyExternalUrls;
  audiobook?: SpotifyAudiobook;
};

export type SpotifyTrack = {
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

export type SpotifyPlaylist = {
  id: string;
  name?: string;
  description?: string;
  owner?: { id?: string; display_name?: string; external_urls?: SpotifyExternalUrls };
  tracks?: { total?: number };
  external_urls?: SpotifyExternalUrls;
};

export type SpotifyPlaylistTrack = {
  added_at?: string | null;
  is_local?: boolean;
  item?: SpotifyTrack | null;
  track?: SpotifyTrack | null;
};

export type SpotifyAlbumTrack = SpotifyTrack & { track_number?: number };

export type SpotifyPagedResponse<T> = {
  items?: T[];
  next?: string | null;
  limit?: number;
  offset?: number;
  total?: number;
};
