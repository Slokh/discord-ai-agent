# Configuration

> Generated from `src/config/environment.ts`. Run `npm run config:docs` after changing the manifest.

The environment is reserved for credentials, private deployment identity, and immutable release coordinates. Models, limits, repository identity, queue topology, retention, payment rail, and other product decisions live in versioned `productConfig` in `src/config/env.ts`.

Production startup rejects retired variables so old deployment settings cannot silently pretend to work. Local shells may still contain them during migration, but the runtime never parses or uses them. Supplying both values for an optional integration enables that capability; incomplete credential pairs leave it unavailable.

`src/config/environment.ts` is the human-facing manifest and `envSchema` in `src/config/env.ts` is the parser. Startup asserts that their key sets are identical, so adding a runtime variable without documenting it—or documenting a variable the runtime ignores—fails immediately.

| Variable | Required for | Secret | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Discord bot and worker roles | yes | Discord bot token. |
| `DISCORD_CLIENT_ID` | Discord bot, worker, and hosted Console roles | no | Discord application ID. |
| `DISCORD_CLIENT_SECRET` | hosted Console authentication | yes | Discord OAuth client secret. |
| `DISCORD_GUILD_ID` | Discord bot, worker, and hosted Console roles | no | Private community guild ID. |
| `DATABASE_URL` | all roles | yes | Postgres connection string with pgvector available. |
| `OPENROUTER_API_KEY` | agent execution | yes | OpenRouter credential for model and provider-backed tools. |
| `CONSOLE_SESSION_SECRET` | hosted Console authentication | yes | HMAC secret for hosted Console sessions and OAuth state. |
| `BOT_OWNER_USER_ID` | owner-only mutations | no | Discord user ID with owner authority. |
| `OPS_ALLOWLIST_USER_IDS` | restricted operations | no | Comma-separated Discord user IDs with operations authority. |
| `PRIVY_APP_ID` | wallets | no | Privy application ID; supplying both Privy values enables wallets. |
| `PRIVY_APP_SECRET` | wallets | yes | Privy application secret; supplying both Privy values enables wallets. |
| `NODE_ENV` | runtime platform | no | Node runtime mode. |
| `APP_REVISION` | release workflow | no | Immutable deployed git revision. |
| `RELEASE_VERIFICATION_ID` | release workflow | no | Unique public identifier for this rollout's post-deploy promotion. |

## Ownership

- Humans or the secret manager set variables marked for application credentials, access policy, and optional integrations.
- Docker/Kubernetes and the deployment workflow inject `NODE_ENV` and revision metadata.
- `.env.example` is generated from the same manifest and is the local-development template.
- `npm run config:check` verifies generated files; `npm run config:docs` rewrites them intentionally.
