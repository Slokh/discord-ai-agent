import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const spotifyCatalogToolContracts = [
  defineTool({
    name: "searchSpotify",
    examples: ["@ai search Spotify for Running Up That Hill"],
    description:
      "Search Spotify's public catalog for tracks, artists, albums, playlists, shows, episodes, or audiobooks using the Spotify Web API. Use this when the user asks to find music or podcasts/audiobooks on Spotify by name. Results are deterministic Spotify metadata and should be returned directly with Spotify links.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["search query", "result type", "ranked Spotify metadata", "Spotify URLs"],
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query, such as track title, artist name, album name, or playlist name."
        },
        type: {
          type: "string",
          enum: ["track", "artist", "album", "playlist", "show", "episode", "audiobook"],
          description: "What to search for. Defaults to track."
        },
        limit: {
          type: "number",
          description: "Maximum results. Defaults to 5 and Spotify's current search limit caps at 10."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "getSpotifyItem",
    examples: ["@ai what is this Spotify track? https://open.spotify.com/track/abc123"],
    description:
      "Fetch deterministic public Spotify details for one track, artist, album, playlist, show, episode, audiobook, or chapter. Use this for Spotify item URLs/URIs, or for a bare Spotify ID when the type is known. For full playlist track lists, use getSpotifyPlaylistTracks; for album track lists, use getSpotifyAlbumTracks; for artist release lists, use getSpotifyArtistDiscography.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["item type", "Spotify metadata", "Spotify URL", "explicit limitation if unavailable"],
    parameters: {
      type: "object",
      properties: {
        itemIdOrUrl: {
          type: "string",
          description: "Spotify open URL, spotify: URI, or bare Spotify ID."
        },
        type: {
          type: "string",
          enum: ["track", "artist", "album", "playlist", "show", "episode", "audiobook", "chapter"],
          description: "Required only when itemIdOrUrl is a bare ID rather than a URL or URI."
        }
      },
      required: ["itemIdOrUrl"],
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
