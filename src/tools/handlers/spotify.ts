import { compareSpotifyPlaylists, getSpotifyAlbumTracks, getSpotifyArtistDiscography, getSpotifyItem, getSpotifyPlaylistStats, getSpotifyPlaylistTracks, searchSpotify } from "../spotify/spotifyTools.js";
import { cleanAgentResponse, stringArgument, stringArrayArgument, numberArgument } from "./arguments.js";
import type { ToolName } from "../registry.js";
import type { LocalToolHandler } from "./types.js";

// Uniform signatures intentionally expose only the inputs each tool needs.
 
export const spotifyToolHandlers = {
  "getSpotifyPlaylistTracks": async (ctx, route, _originalText) => {
    return cleanAgentResponse(
          await getSpotifyPlaylistTracks(ctx, {
            playlistIdOrUrl:
              stringArgument(route.arguments, "playlistIdOrUrl")!,
            limit: numberArgument(route.arguments, "limit"),
            format: stringArgument(route.arguments, "format"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "getSpotifyAlbumTracks": async (ctx, route, _originalText) => {
    return cleanAgentResponse(
          await getSpotifyAlbumTracks(ctx, {
            albumIdOrUrl:
              stringArgument(route.arguments, "albumIdOrUrl")!,
            limit: numberArgument(route.arguments, "limit"),
            format: stringArgument(route.arguments, "format"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "getSpotifyArtistDiscography": async (ctx, route, _originalText) => {
    return cleanAgentResponse(
          await getSpotifyArtistDiscography(ctx, {
            artistIdOrUrl:
              stringArgument(route.arguments, "artistIdOrUrl")!,
            includeGroups: stringArrayArgument(route.arguments, "includeGroups"),
            limit: numberArgument(route.arguments, "limit"),
            format: stringArgument(route.arguments, "format"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "getSpotifyPlaylistStats": async (ctx, route, _originalText) => {
    return cleanAgentResponse(
          await getSpotifyPlaylistStats(ctx, {
            playlistIdOrUrl:
              stringArgument(route.arguments, "playlistIdOrUrl")!,
            limit: numberArgument(route.arguments, "limit"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "compareSpotifyPlaylists": async (ctx, route, _originalText) => {
    return cleanAgentResponse(
          await compareSpotifyPlaylists(ctx, {
            playlistAIdOrUrl:
              stringArgument(route.arguments, "playlistAIdOrUrl")!,
            playlistBIdOrUrl:
              stringArgument(route.arguments, "playlistBIdOrUrl")!,
            limit: numberArgument(route.arguments, "limit"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "searchSpotify": async (ctx, route, _originalText) => {
    return cleanAgentResponse(
          await searchSpotify(ctx, {
            query: stringArgument(route.arguments, "query")!,
            type: stringArgument(route.arguments, "type"),
            limit: numberArgument(route.arguments, "limit"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "getSpotifyItem": async (ctx, route, _originalText) => {
    return cleanAgentResponse(
          await getSpotifyItem(ctx, {
            itemIdOrUrl:
              stringArgument(route.arguments, "itemIdOrUrl")!,
            type: stringArgument(route.arguments, "type"),
          }),
          ctx.config.maxReplyChars,
        );
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
 
