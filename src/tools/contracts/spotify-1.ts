import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const spotifyPart1ToolContracts = [
  defineTool({
    name: "getSpotifyPlaylistTracks",
    description:
      "Fetch a Spotify playlist's track list with Spotify's Web API, using current playlist item pagination and attaching the full list as CSV and text by default when available. Use this for Spotify playlist URLs/URIs or playlist IDs, especially when the user asks for every track. The result also exposes a queryable generated table for exact follow-up counts, filters, and rankings. Do not use web_fetch on open.spotify.com for playlist track lists. If Spotify denies playlist item access, return the limitation clearly instead of guessing.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["playlist metadata", "track count returned", "attached full track list when available", "queryable table when available", "Spotify URLs", "explicit limitation on 403"],
    parameters: {
      type: "object",
      properties: {
        playlistIdOrUrl: {
          type: "string",
          description: "Spotify playlist ID, spotify:playlist URI, or open.spotify.com/playlist/<id> URL."
        },
        limit: {
          type: "number",
          description: "Maximum tracks to include in the attached list. Defaults to 10000 and is capped at 10000."
        },
        format: {
          type: "string",
          enum: ["text", "csv", "both"],
          description: "Attachment format for the full track list. Defaults to both (CSV + text). Use csv to attach only CSV and text to attach only text."
        }
      },
      required: ["playlistIdOrUrl"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "getSpotifyAlbumTracks",
    description:
      "Fetch a Spotify album's ordered track list with Spotify's Web API and attach the full list as CSV and text by default when available. Use this for Spotify album URLs/URIs or album IDs when the user asks what tracks are on an album, wants album duration, or wants an album tracklist. The result also exposes a queryable generated table for exact follow-up counts, filters, and rankings.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["album metadata", "track count returned", "attached full track list when available", "queryable table when available", "Spotify URLs"],
    parameters: {
      type: "object",
      properties: {
        albumIdOrUrl: {
          type: "string",
          description: "Spotify album ID, spotify:album URI, or open.spotify.com/album/<id> URL."
        },
        limit: {
          type: "number",
          description: "Maximum tracks to include in the attached list. Defaults to 200 and is capped at 500."
        },
        format: {
          type: "string",
          enum: ["text", "csv", "both"],
          description: "Attachment format for the full album track list. Defaults to both (CSV + text). Use csv to attach only CSV and text to attach only text."
        }
      },
      required: ["albumIdOrUrl"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "getSpotifyArtistDiscography",
    description:
      "Fetch a Spotify artist's public discography: albums, singles, compilations, and appearances. Use this for artist URLs/URIs or artist IDs when the user asks for releases, discography, albums, singles, or where to start with an artist. The result attaches the release list as CSV and text by default and exposes a queryable generated table.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["artist metadata", "discography groups requested", "ranked release list", "attached release list when available", "queryable table when available", "Spotify URLs"],
    parameters: {
      type: "object",
      properties: {
        artistIdOrUrl: {
          type: "string",
          description: "Spotify artist ID, spotify:artist URI, or open.spotify.com/artist/<id> URL."
        },
        includeGroups: {
          type: "array",
          items: { type: "string", enum: ["album", "single", "appears_on", "compilation"] },
          description: "Release groups to include. Defaults to all four public discography groups."
        },
        limit: {
          type: "number",
          description: "Maximum releases to include. Defaults to 50 and is capped at 200."
        },
        format: {
          type: "string",
          enum: ["text", "csv", "both"],
          description: "Attachment format for the discography list. Defaults to both (CSV + text). Use csv to attach only CSV and text to attach only text."
        }
      },
      required: ["artistIdOrUrl"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "getSpotifyPlaylistStats",
    description:
      "Compute deterministic, fun stats from a Spotify playlist track list: total duration, explicit count, local/unavailable count, top artists, top albums, unique artists, and repeated artists. Use this for quick rating or summarizing a playlist without using deprecated audio features or recommendations. For custom filters/rankings over the full playlist rows, export a CSV with getSpotifyPlaylistTracks and query it with queryGeneratedCsv.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["playlist metadata", "track count analyzed", "duration", "top artists", "top albums", "explicit/local counts", "Spotify URL"],
    parameters: {
      type: "object",
      properties: {
        playlistIdOrUrl: {
          type: "string",
          description: "Spotify playlist ID, spotify:playlist URI, or open.spotify.com/playlist/<id> URL."
        },
        limit: {
          type: "number",
          description: "Maximum tracks to analyze. Defaults to 10000 and is capped at 10000."
        }
      },
      required: ["playlistIdOrUrl"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "compareSpotifyPlaylists",
    description:
      "Compare two Spotify playlists using public playlist item metadata: shared tracks, shared artists, unique tracks, and a track-overlap score. Use this when the user asks how similar two playlists are, what overlaps, or what one playlist has that the other does not.",
    userVisible: true,
    mutates: false,
    group: "spotify",
    category: "external",
    toolClass: "external",
    outputContract: ["both playlist names", "track counts analyzed", "shared tracks", "shared artists", "unique counts", "overlap score"],
    parameters: {
      type: "object",
      properties: {
        playlistAIdOrUrl: {
          type: "string",
          description: "First Spotify playlist ID, spotify:playlist URI, or open.spotify.com/playlist/<id> URL."
        },
        playlistBIdOrUrl: {
          type: "string",
          description: "Second Spotify playlist ID, spotify:playlist URI, or open.spotify.com/playlist/<id> URL."
        },
        limit: {
          type: "number",
          description: "Maximum tracks per playlist to compare. Defaults to 10000 and is capped at 10000."
        }
      },
      required: ["playlistAIdOrUrl", "playlistBIdOrUrl"],
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
