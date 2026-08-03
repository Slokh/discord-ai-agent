import type { AppConfig } from "../config/env.js";

export function spotifyAvailable(config: AppConfig) {
  return Boolean(config.spotify.clientId.trim() && config.spotify.clientSecret.trim());
}
