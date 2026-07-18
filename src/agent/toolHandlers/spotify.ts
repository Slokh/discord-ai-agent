import { compareSpotifyPlaylists, getSpotifyAlbumTracks, getSpotifyArtistDiscography, getSpotifyItem, getSpotifyPlaylistStats, getSpotifyPlaylistTracks, searchSpotify } from "../../tools/spotify/spotifyTools.js";
import { cleanAgentResponse, stringArgument, stringArrayArgument, numberArgument } from "./arguments.js";
import type { ToolName } from "../../tools/registry.js";
import type { LocalToolHandler } from "./types.js";

// Uniform signatures intentionally expose only the inputs each tool needs.
 
export const spotifyToolHandlers = {
  "getSpotifyPlaylistTracks": async (ctx, route, originalText) => {
    return cleanAgentResponse(
          await getSpotifyPlaylistTracks(ctx, {
            playlistIdOrUrl:
              stringArgument(route.arguments, "playlistIdOrUrl") ?? originalText,
            limit: numberArgument(route.arguments, "limit"),
            format: stringArgument(route.arguments, "format"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "getSpotifyAlbumTracks": async (ctx, route, originalText) => {
    return cleanAgentResponse(
          await getSpotifyAlbumTracks(ctx, {
            albumIdOrUrl:
              stringArgument(route.arguments, "albumIdOrUrl") ?? originalText,
            limit: numberArgument(route.arguments, "limit"),
            format: stringArgument(route.arguments, "format"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "getSpotifyArtistDiscography": async (ctx, route, originalText) => {
    return cleanAgentResponse(
          await getSpotifyArtistDiscography(ctx, {
            artistIdOrUrl:
              stringArgument(route.arguments, "artistIdOrUrl") ?? originalText,
            includeGroups: stringArrayArgument(route.arguments, "includeGroups"),
            limit: numberArgument(route.arguments, "limit"),
            format: stringArgument(route.arguments, "format"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "getSpotifyPlaylistStats": async (ctx, route, originalText) => {
    return cleanAgentResponse(
          await getSpotifyPlaylistStats(ctx, {
            playlistIdOrUrl:
              stringArgument(route.arguments, "playlistIdOrUrl") ?? originalText,
            limit: numberArgument(route.arguments, "limit"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "compareSpotifyPlaylists": async (ctx, route, originalText) => {
    return cleanAgentResponse(
          await compareSpotifyPlaylists(ctx, {
            playlistAIdOrUrl:
              stringArgument(route.arguments, "playlistAIdOrUrl") ?? originalText,
            playlistBIdOrUrl:
              stringArgument(route.arguments, "playlistBIdOrUrl") ?? originalText,
            limit: numberArgument(route.arguments, "limit"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "searchSpotify": async (ctx, route, originalText) => {
    return cleanAgentResponse(
          await searchSpotify(ctx, {
            query: stringArgument(route.arguments, "query") ?? originalText,
            type: stringArgument(route.arguments, "type"),
            limit: numberArgument(route.arguments, "limit"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "getSpotifyItem": async (ctx, route, originalText) => {
    return cleanAgentResponse(
          await getSpotifyItem(ctx, {
            itemIdOrUrl:
              stringArgument(route.arguments, "itemIdOrUrl") ?? originalText,
            type: stringArgument(route.arguments, "type"),
          }),
          ctx.config.maxReplyChars,
        );
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
 
