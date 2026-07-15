# Managed wallets

The wallet runtime uses Privy application-controlled EVM wallets on Tempo. It maintains one shared bot wallet per network and can optionally provision one wallet per Discord user and guild.

## Ownership model

- The shared bot wallet is deterministic per Tempo network. It funds initial grants, game winnings, and transaction fees.
- With `USER_WALLETS_ENABLED=true`, the bot automatically provisions a deterministic wallet after a user's first accepted mention. No command is required.
- V1 wallets are server-managed accounts. Users do not receive private keys, withdrawals, passkeys, or a wallet portal.
- Every user-wallet transfer is fee-sponsored by the shared bot wallet.
- All displayed balances and transfers use six-decimal USD-denominated `USDC.e`.

## Conversational tools

Users interact through normal `@ai` prompts:

- `getWalletBalance` reads the requester, bot, or an admin-authorized user's current onchain balance and public address.
- `listWalletBalances` joins the live Discord member roster to existing wallets. Members without wallets appear as `$0`; existing balances are read live onchain. Owner/ops can always use it, and all members can use it when `WALLET_BALANCES_PUBLIC=true`.
- `transferWalletFunds` moves USD from the current requester's wallet to another verified Discord user or the bot wallet.
- `adminTransferWalletFunds` performs an owner/ops-authorized correction between managed wallets and requires a reason.
- `reconcileWalletTransfers` lets an owner/ops requester reconcile pending or uncertain transfers. The worker also reconciles automatically.

No tool accepts an arbitrary external destination address. Request identity is captured at Discord ingress and validated again before wallet actions.

## Wagers

`drawRandom` accepts an optional wager with a positive stake, maximum total payout, and game label. Before consuming entropy, the runtime ensures both wallets exist, reads balances, and reserves the user's stake plus the bot's worst-case exposure.

`settleRandomWager` validates the requester, draw, maximum payout, and one-time settlement state. It transfers only the net difference: bot to user for a win, user to bot for a loss, and nothing for break-even. Stale reservations expire automatically.

## Transfer safety

Transfers move through `reserved → submitting → submitted → confirmed`. An exception after signing is recorded as `unknown` and reconciled against the chain instead of being blindly retried. Confirmed receipts must contain the expected token transfer event, including token, sender, recipient, and amount. A confirmed transaction that did not deliver that exact transfer is recorded as a final rejected delivery and is never automatically replayed.

Idempotency keys protect initial grants, ordinary transfers, and wager settlements. Initial grants are scoped to both wallet and token address so a network or token change cannot silently reuse an unrelated grant record. Transfer and wager reservations share one available-balance calculation, including in-flight transfers and anything confirmed after the balance observation, so concurrent requests cannot spend the same onchain dollars twice.

## Rollout and operations

1. Configure `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `WALLET_ENABLED=true`, `TEMPO_NETWORK`, and `TEMPO_USD_TOKEN=USDC.e`.
2. Run migrations and provision the shared wallet with `npm run payments:provision-bot`.
3. Fund the returned address on the configured Tempo network.
4. Verify `npm run payments:status` and the authenticated `/payments` console.
5. Enable `USER_WALLETS_ENABLED=true` only when per-user wallets are desired.
6. Set `WALLET_BALANCES_PUBLIC=true` only when every member may inspect other members' balances and the server-wide directory. Owner/ops retain access when it is false.
7. Test balance reads, an initial grant, user-to-user and user-to-bot transfers, plus winning, losing, and break-even wagers.

The `/payments` console shows wallet provisioning, transfers, wagers, and shared-wallet health. `npm run payments:reconcile` is an operator fallback; normal reconciliation runs automatically.

Treat `PRIVY_APP_SECRET` as a production signing secret. Store it only in the deployment secret manager, never in source, logs, or bot replies.
