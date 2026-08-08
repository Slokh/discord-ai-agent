# Configuration

> Generated from `src/config/environment.ts`. Run `npm run config:docs` after changing the manifest.

The environment is reserved for credentials, private deployment identity, and immutable release coordinates. Models, limits, repository identity, queue topology, retention, payment rail, and other product decisions live in versioned `productConfig` in `src/config/env.ts`.

Production startup rejects retired variables so old deployment settings cannot silently pretend to work. Local shells may still contain them during migration, but the runtime never parses or uses them. Supplying both values for an optional integration enables that capability; incomplete credential pairs leave it unavailable.

`src/config/environment.ts` is the human-facing manifest and `envSchema` in `src/config/env.ts` is the parser. Startup asserts that their key sets are identical, so adding a runtime variable without documenting it—or documenting a variable the runtime ignores—fails immediately.

| Variable | Required for | Secret | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Discord bot and worker roles | yes | Discord bot token. |
| `DISCORD_CLIENT_ID` | Discord bot and worker roles | no | Discord application ID. |
| `DISCORD_GUILD_ID` | Discord bot and worker roles | no | Private community guild ID. |
| `DATABASE_URL` | all roles | yes | Postgres connection string with pgvector available. |
| `OPENROUTER_API_KEY` | agent execution | yes | OpenRouter credential for model and provider-backed tools. |
| `TASK_SIGNING_SECRET` | code updates | yes | Shared HMAC secret for isolated task callbacks. |
| `GITHUB_TOKEN` | code updates (token mode) | yes | GitHub token used for code-update publication when an App is not configured. |
| `GITHUB_APP_ID` | code updates (App mode) | no | GitHub App ID. |
| `GITHUB_APP_PRIVATE_KEY` | code updates (App mode) | yes | GitHub App private key. |
| `GITHUB_APP_INSTALLATION_ID` | code updates (App mode) | no | GitHub App installation ID. |
| `BOT_OWNER_USER_ID` | owner-only mutations | no | Discord user ID with owner authority. |
| `OPS_ALLOWLIST_USER_IDS` | restricted operations | no | Comma-separated Discord user IDs with operations authority. |
| `DISCORD_PREMIUM_SKU_IDS` | premium buttons | no | Comma-separated configured Discord premium SKU IDs. |
| `SPOTIFY_CLIENT_ID` | Spotify tools | no | Spotify application client ID. |
| `SPOTIFY_CLIENT_SECRET` | Spotify tools | yes | Spotify application client secret. |
| `PRIVY_APP_ID` | wallets | no | Privy application ID; supplying both Privy values enables wallets. |
| `PRIVY_APP_SECRET` | wallets | yes | Privy application secret; supplying both Privy values enables wallets. |
| `NODE_ENV` | runtime platform | no | Node runtime mode. |
| `APP_REVISION` | release workflow | no | Immutable deployed git revision. |
| `RELEASE_VERIFICATION_ID` | release workflow | no | Unique public identifier for this rollout's post-deploy promotion. |
| `PREVIOUS_APP_REVISION` | release announcements | no | Previously deployed git revision. |
| `DISCORD_BOT_CHANNEL_ID` | deployment announcements | no | Single Discord text channel for deployment announcements. |
| `POD_NAMESPACE` | Kubernetes worker | no | Namespace where isolated code-update Jobs are created. |
| `SANDBOX_IMAGE` | Kubernetes worker | no | Immutable code-update sandbox image reference. |

## Ownership

- Humans or the secret manager set variables marked for application credentials, GitHub, access policy, and optional integrations.
- Docker/Kubernetes and the deployment workflow inject `NODE_ENV`, revision metadata, namespace, and the immutable sandbox image.
- `.env.example` is generated from the same manifest and is the local-development template.
- `npm run config:check` verifies generated files; `npm run config:docs` rewrites them intentionally.
