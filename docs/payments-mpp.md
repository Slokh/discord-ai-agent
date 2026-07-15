# Wallets and MPP payments

The payment runtime can give Discord users lightweight game accounts while keeping paid API access behind one application-controlled bot wallet. It uses Privy application-controlled EVM wallets on Tempo and the official `mppx` client for MPP negotiation. User wallets are independently gated and are not required for MPP.

## Ownership model

- The bot wallet is a single deterministic application account (`__shared_bot__`) per Tempo network. Operators fund the active network's address once. It pays initial grants, game winnings, and MPP challenges for every guild on that network.
- When `USER_WALLETS_ENABLED=true`, a user wallet is deterministic per guild and Discord user (`guild_<guildId>_discord_<userId>`). It is provisioned automatically after the user's first accepted bot mention.
- These are server-side game accounts in V1. There is no login, private-key export, deposit, withdrawal, passkey, or wallet portal exposed to users.
- A new user receives the configured PathUSD grant exactly once. A failed or uncertain transfer is reconciled before it can be retried.
- Users do not need a creation command. They can ask for their bankroll or wallet and `getGameWalletBalance` returns the current onchain game balance and public address.
- Every transfer sent by a user wallet is fee-sponsored by the shared bot wallet. Users' displayed game balances therefore change only by the game settlement amount; the shared bot pays the network fee.

## Wager flow

`drawRandom` accepts an optional generic `wager` with a positive stake, maximum total payout (including returned stake), and game label. Before any RNG entropy is consumed, the runtime:

1. Ensures the user and bot wallets exist.
2. Reads onchain balances and locks the durable wallet rows.
3. Reserves the user's stake and the bot's worst-case net exposure.
4. Produces and stores the provably fair draw, then attaches its durable draw ID to the reservation.
5. Requires `settleRandomWager` to submit the deterministic total payout and calculation.

Settlement validates the requester, draw, maximum payout, and one-time status. It sends only the net difference: bot to user for a win, user to bot for a loss, and no transaction for break-even. Stale reservations expire automatically.

## MPP flow

The model can use three generic tools:

- `discoverMppServices` asks the official MPP Services MCP server to rank services and offers for the task without paying. The public catalog is a degraded fallback when MCP discovery is unavailable.
- `inspectMppService` resolves the callable service URL, reads its usage recipe and OpenAPI document, and returns a short-lived inspection ID, exact operation IDs, request shapes, and every advertised payment offer. It does not pay.
- `callMppService` accepts only an operation from that inspection and makes a bounded HTTPS request through the official `mppx` client using the shared bot wallet. Arbitrary URLs, methods, and paths are not accepted by the paid-call tool.

Discovery metadata is advisory. The signed runtime `402 Payment Required` challenge is authoritative. The client accepts only Tempo `charge` and TIP-1034 `session` intents, six-decimal USD-denominated tokens whose decimals match onchain metadata, and the configured chain. The repository atomically enforces the default `$0.50` per call, `$2` per requesting Discord user per UTC day across guilds, and `$10` shared-bot-wallet total per UTC day caps. For sessions, authorization conservatively counts the bounded opening-deposit suggestion rather than only the first unit price. Session channel access is serialized per guild and uses the Postgres-backed JSON channel store.

Read-only calls up to `MPP_AUTO_APPROVE_USD` (default `$0.05`) can run autonomously. Calls above that threshold, intentional repeats, and all external side effects require `userAuthorization` to quote the current Discord request verbatim. PUT, PATCH, and DELETE operations cannot be mislabeled read-only. POST remains usable for read-only search/inference APIs, but the model must classify its semantic effect. This is an application safety boundary in addition to the hard spend caps, not a replacement for them.

Every request is fingerprinted. Identical calls in one execution and recent calls across turns are refused for `MPP_RECENT_REQUEST_WINDOW_SECONDS` unless the current user explicitly asks to repeat them. A successful paid response must contain a parseable MPP `Payment-Receipt` matching the selected method. Receipt method, reference, status, timestamp, external ID, and the bounded receipt object are persisted. If the payment may have happened but the receipt is missing or malformed, the attempt becomes `uncertain`, remains counted against budgets, and is never reported as a clean success.

Requests require public HTTPS destinations, reject credentials and private/reserved addresses, validate the DNS answer used by the actual socket, and refuse redirects outside the inspected origin. Responses are streamed into a configurable byte cap; JSON and text are returned inline, while bounded binary responses become Discord attachments. All service output is labeled and wrapped as untrusted external data so it cannot grant permission or become agent instructions.

The inspection IDs are intentionally process-local and short-lived. A deployment or expiry requires a fresh free inspection, which prevents an old discovery result from becoming a durable capability to call a changed endpoint. Wallet records and reusable MPP session channels are chain-scoped, so a Moderato-to-mainnet cutover cannot reuse testnet payment state.

## Rollout

1. Create a Privy app and place `PRIVY_APP_ID` and `PRIVY_APP_SECRET` in the runtime secret.
2. Deploy with migrations and `TEMPO_NETWORK=moderato`.
3. For MPP-only operation, set `WALLET_ENABLED=true`, `MPP_ENABLED=true`, and `USER_WALLETS_ENABLED=false`.
4. Run `npm run payments:provision-bot`, fund the displayed bot wallet with Moderato PathUSD, and run `npm run payments:status` until `bot_wallet_balance` is healthy.
5. Open `/payments` in the authenticated console and verify the shared bot wallet, configured policy, runtime health, and event timeline.
6. Discover and inspect a service, then make one read-only call below the automatic-approval threshold. Verify the challenge, approval, receipt, and response events plus the operation and receipt columns in `/payments`.
7. Explicitly test a call above the automatic threshold and a side-effecting operation: both must fail without a verbatim authorization quote and pass only with one.
8. If game wallets are later desired, set `USER_WALLETS_ENABLED=true`, mention the bot from a test user, and verify the user wallet, initial grant, and one winning, losing, and break-even wager.
9. Exercise an oversized challenge, recent duplicate request, missing receipt, private URL, off-origin redirect, and stale transfer reconciliation.
10. Only after those checks, switch to `TEMPO_NETWORK=mainnet`, redeploy, fund the new mainnet bot wallet, and keep the conservative caps until production behavior is understood.

Disabling `MPP_ENABLED` removes all three paid-service tools. Disabling `USER_WALLETS_ENABLED` stops automatic user provisioning and removes the balance and wager surfaces while preserving the shared bot wallet for MPP. Disabling `WALLET_ENABLED` prevents all wallet construction, so MPP cannot remain enabled. None of these flags deletes existing ledger records or Privy wallets.

## Operations

The `/payments` console view shows wallet provisioning states, transfers, open wagers, MPP attempts, operation/effect/approval details, receipt references, runtime health, configured policy, and current UTC-day MPP spend. Runtime traces use the event families `wallet.provision.*`, `wallet.transfer.*`, `wallet.wager.*`, `wallet.reconciliation.*`, `mpp.discovery.*`, `mpp.challenge.*`, `mpp.payment.*`, and `mpp.response.*`.

Run `npm run payments:status` for a bounded ledger snapshot, `npm run payments:reconcile` for an explicit reconciliation pass, or `npm run payments:provision-bot` to create the shared bot wallet and print its public funding address.

Use `npm run payments:mpp-smoke -- --service <service-id-or-https-url>` for a free inspection. Add `--operation <operation-id> --confirm-spend` to execute exactly one bounded call; optional request inputs are `--path-json`, `--query-json`, and `--body-json`. Mainnet additionally requires `--allow-mainnet`, making an accidental production smoke payment less likely. This command uses the same discovery, policy, receipt, budget, and ledger path as Discord.

Transfers move through `reserved → submitting → submitted → confirmed`. An exception after signing is recorded as `unknown`, never blindly retried. The worker reconciler checks submitted/unknown transaction hashes and expires stale wager reservations every minute.

Treat `PRIVY_APP_SECRET` like a production signing secret. Store it only in your secret manager/Kubernetes Secret, never in chat, source, logs, or shell history. If it is pasted into any conversation or ticket, rotate it in Privy immediately and update the deployment Secret before the next rollout; deleting the message is not sufficient. The repository and agent tools cannot rotate this credential on your behalf.

The worker records bot-wallet balance health on startup and periodically during reconciliation. The threshold is the larger of the configured shared daily budget and per-call cap, so a `low` state means the wallet cannot safely cover the configured operating envelope even if a very small call could still succeed.
