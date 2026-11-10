import type { AppConfig } from "./env.js";

/**
 * The environment the nanocode host process runs with: its model credential,
 * the session store, and a minimal process environment. NANOCODE_STORE=memory
 * and NANOCODE_API_BASE_URL exist for local runs and tests only.
 */
export function nanocodeHostEnvironment(config: AppConfig): { env: NodeJS.ProcessEnv; apiBaseUrl?: string } {
  return {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENROUTER_API_KEY: config.openRouter.apiKey,
      DATABASE_URL: config.databaseUrl,
      ...(process.env.NANOCODE_STORE ? { NANOCODE_STORE: process.env.NANOCODE_STORE } : {}),
      ...(process.env.RUST_LOG ? { RUST_LOG: process.env.RUST_LOG } : {}),
    },
    ...(process.env.NANOCODE_API_BASE_URL ? { apiBaseUrl: process.env.NANOCODE_API_BASE_URL } : {}),
  };
}
