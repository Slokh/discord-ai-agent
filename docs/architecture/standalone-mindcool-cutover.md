# Standalone production cutover

## Decision

Run the production application directly on the Discord AI Agent runtime and retire the Centaur application, Discord transport, sandboxes, Console, and chart after a verified single-bot cutover.

The production profile contains only the Discord bot and durable worker. It keeps permission-scoped archive retrieval, preferences and privacy deletion, images, generated files, web research, reactions and polls, Tempo wallets/transfers, and money-backed games. It does not expose reminders, Spotify, self-repair or code-update tasks, retry or undo reactions, arbitrary Discord components, emoji/avatar administration, model/spend administration, or the operator Console.

## Why

The direct runtime already owns the complete Discord ingress, durable queue, model loop, tool execution, and append-only delivery lifecycle. Reusing those boundaries removes the extra application-to-framework signing and sandbox layers while retaining the product behavior needed by this server. It also leaves one repository as the owner of Discord-specific behavior.

## Data boundary

The existing Centaur Helm release owns the live Postgres StatefulSet and PVC. It must not be uninstalled until a replacement database workload is ready. The small `deploy/helm/postgres` chart first installs in bridge mode, giving the database stable replacement-owned DNS while the current pod still serves traffic. Its workload is enabled only after all application pods and the previous StatefulSet are stopped; it then mounts the retained claim directly with the same image and server settings.

The Discord AI Agent schema is incompatible with the current application schema, so the replacement uses a separate database. `scripts/importExistingDatabase.ts` performs an idempotent, one-way import after the destination migrations run:

- managed Privy wallet identities are copied without initiating transactions or moving funds;
- funded-member markers are copied so starter funds are not granted twice;
- normalized Discord members, channels, messages, attachments, preferences, and privacy deletions are copied;
- historical prototype wagers, RNG sessions, executions, and application receipts are intentionally not migrated.

The configured production rail remains Tempo mainnet (`chain_id` 4217) and `USDC.e` at `0x20c000000000000000000000b9537d11c60e8b50`. Deployment must validate those values against the source database before enabling wallet tools.

## Cutover

1. Back up the live database and record source row counts and wallet identity hashes.
2. Create a separate destination database and role on the existing Postgres server.
3. Run the replacement migrations and idempotent import while Centaur remains live.
4. Deploy the replacement bot at zero replicas and its worker at one replica.
5. Validate configuration, database readiness, queue health, image identity, wallet identity parity, and Discord permissions without making a model call or spending funds.
6. Scale the Centaur Discord bot to zero, then scale the replacement bot to one. Never run both gateway clients concurrently.
7. Verify gateway readiness, reaction/typing feedback, one non-paid operator debugging prompt if needed, reply targeting, and delivery logs.
8. Keep the old workloads and source database available for rollback through an observation window.
9. Install `deploy/helm/postgres` in bridge mode and update the application database URL to its stable service name.
10. Stop application pods, stop the previous Postgres StatefulSet, enable the standalone Postgres workload, and verify the destination database and wallet identity hash.
11. Restart the standalone worker and bot, then remove Centaur and the thin application overlay.

Rollback before step 9 is to scale the replacement bot to zero and the Centaur Discord bot back to one. The data import is one-way and does not mutate the source database.

## Security and cost

- Discord identity and channel visibility are resolved by trusted code from the triggering event.
- Wallet mutations remain requester-bound and use Privy-managed Tempo wallets.
- The bot and worker use a service account with token automount disabled; no sandbox RBAC is installed.
- Production readiness checks are content-free and do not call paid models or place wagers.
- Scheduled production observation, private regression, and smoke workflows remain disabled unless a concrete, non-duplicative readiness gain justifies them.
