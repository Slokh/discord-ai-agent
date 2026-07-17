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
- `listWalletBalances` reads existing balances live onchain and renders a compact directory. Balance views include the AI treasury and funded member wallets while omitting zero/no-wallet rows; address views include the AI and every existing member wallet. Owner/ops can always use it, and all members can use it when `WALLET_BALANCES_PUBLIC=true`.
- `transferWalletFunds` moves USD from the current requester's wallet to another verified Discord user or the bot wallet. Usernames and display names are resolved inside the guarded transfer path; ambiguity fails without moving funds.
- Every Discord request runs a deterministic starter-funds preflight before model/tool selection. It sends the configured `$1` amount from the AI treasury only when the requester's verified balance is exactly zero, so users never need special refill wording. Positive balances are untouched. Concurrent requests after the same zero-balance observation are rejected by the existing guarded second balance check and transfer lock. `requestStarterFunds` remains available as a safe fallback/recheck path.
- `adminTransferWalletFunds` performs an owner/ops-authorized correction between managed wallets and requires a reason.
- `reconcileWalletTransfers` lets an owner/ops requester reconcile pending or uncertain transfers. The worker also reconciles automatically.

No tool accepts an arbitrary external destination address. Request identity is captured at Discord ingress and validated again before wallet actions.

## Wagers

`drawRandom` accepts an optional wager with a positive stake, maximum total payout, and game label. Before consuming entropy, the runtime ensures both wallets exist, reads balances, and reserves the user's stake plus the bot's worst-case exposure. Leading-decimal amounts such as `.05` are treated as real money, and a bare amount reply must match the reserved stake instead of inheriting a different amount from history. Exactly one wager can be reserved per Discord request, enforced transactionally before entropy is consumed. Vague repeats inherit the wager requirement only from the same requester's latest wager prompt. A game can settle in the same turn or pause through `awaitRandomWagerAction`, which stores bounded, versioned JSON state, allowed actions, and the next prompt. Replies in the same Discord chain resume only the original requester's active game. Each decision must either save the next version or settle exactly once; ordinary transfers cannot substitute for settlement.

Paused games renew a 10-minute inactivity window, capped at one hour from the original wager. Optimistic state versions reject simultaneous or stale replies, and the Discord message id makes a repeated state update idempotent. Expiration releases the ledger reservation without moving money. The model owns game-specific rules and state shape; code owns player/thread scoping, state bounds, verified randomness, reservation accounting, and exactly-once settlement. The payments console shows active versions, allowed actions, and pending prompts for debugging.

`settleRandomWager` treats the model's settlement as a proposal, not authority. The runtime resolves the canonical active wager from the requester and Discord game-session scope; opaque database ids are not exposed in continuation-tool schemas or trusted from model output. The ledger validates the requester, draw, maximum payout, one-time settlement state, and that the structured outcome agrees with the payout direction. It transfers only the net difference: bot to user for a win, user to bot for a loss, and nothing for break-even. A verified opening draw that already determines a terminal outcome settles immediately even for an otherwise interactive game. When a genuine player decision remains, the game must persist state and receive a later Discord reply from the original player before a player-decision settlement; confirmation or settlement cannot be stored as fake player actions. Real-money challenges based on an uncommitted player secret are rejected before funds are reserved or randomness is consumed. Stale reservations expire automatically.

## Transfer safety

Transfers move through `reserved → submitting → submitted → confirmed`. An exception after signing is recorded as `unknown` and reconciled against the chain instead of being blindly retried. Confirmed receipts must contain the expected token transfer event, including token, sender, recipient, and amount. A confirmed transaction that did not deliver that exact transfer is recorded as a final rejected delivery and is never automatically replayed.

Idempotency keys protect initial grants, restart grants, ordinary transfers, and wager settlements. Initial grants are scoped to both wallet and token address so a network or token change cannot silently reuse an unrelated grant record. Restart grants lock both wallets and reject a second incoming transfer after the qualifying zero-balance observation. Transfer and wager reservations share one available-balance calculation, including in-flight transfers and anything confirmed after the balance observation, so concurrent requests cannot spend the same onchain dollars twice.

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
