# Payments and games

This guide covers managed wallets, transfers, reconciliation, wagers, durable games, and provably fair randomness. These capabilities are optional and remain absent from the deployed tool contract until configured.

## System boundary

The payment runtime uses Privy application wallets on Tempo and one configured six-decimal USD token, normally `USDC.e`. Discord presents values as USD; members do not need addresses, gas, or chain terminology for ordinary use.

`src/payments/privyTempoWalletProvider.ts` owns provider interaction: wallet provisioning, token resolution, balances, fee sponsorship, transfers, receipt verification, fee accounting, and confirmed-block balance snapshots. `walletService.ts` owns product lifecycle and orchestration. `src/db/paymentRepository.ts` and focused payment repositories own durable wallets, transfers, reservations, wagers, and locks.

Never expose Privy secrets, signing credentials, private keys, or signed transactions to Discord, model context, logs, or sandboxes.

## Enablement

Supplying both `PRIVY_APP_ID` and `PRIVY_APP_SECRET` enables the complete wallet capability: the shared bot wallet, automatic member wallets, grants, transfers, and wallet-backed wagers. The product uses Tempo mainnet and `USDC.e`; changing that rail is a reviewed code and migration decision, not a deployment toggle.

The bot wallet sponsors member-wallet fees and acts as the treasury for grants and games. The managed identity-to-wallet balance directory is visible to members; protected administrative operations still require owner/ops authority.

## Authority model

- The current Discord requester is the only ordinary user authorized to spend from their managed wallet.
- Recipients must resolve to a verified Discord member or the bot wallet; arbitrary external addresses are unsupported.
- A new transfer, grant, correction, or wager requires explicit current-turn intent.
- Reply chains can clarify a prior request but cannot turn another user's instruction into authority.
- Owner/ops corrections use a dedicated administrative tool and require an explicit reason.
- Tool/model arguments are proposals. Code resolves canonical wallets, requester identity, network, and token.

Starter funding tops an eligible requester toward the configured target; it is not a repeatable fixed giveaway. The service prevents concurrent or duplicate grants and records the durable transfer.

## Transfer lifecycle

1. Resolve the immutable requester and typed recipient.
2. Load canonical managed wallets and current configured network/token.
3. Validate amount, available balance, feature flags, access policy, and idempotency key.
4. Persist the transfer intent before provider submission.
5. Submit through the provider with fee sponsorship as configured.
6. Verify the receipt and persist the terminal ledger result.
7. Refresh balances from a confirmed block when available.
8. Return the committed receipt-backed result with explorer metadata.

A failure before provider submission can be retryable. A timeout or audit failure after confirmed submission must not cause an automatic duplicate transfer. Uncertain/submitted transfers remain durable and are reconciled by `src/payments/reconciler.ts`.

Post-transfer balance refresh is secondary. If the transfer committed but the refresh failed, return a partial success with the transaction result and record the limitation.

## Wager lifecycle

A wallet-backed game is a money transaction wrapped around provable randomness:

1. Parse a typed wager rule and compute probability, stake, and maximum payout.
2. Reject malformed, impossible, or treasury-guaranteed-loss rules.
3. Resolve the immutable requester and ensure one applicable reservation/game for the scope.
4. Reserve both player and treasury exposure before drawing.
5. Consume randomness through `drawRandom`; the model never chooses the outcome.
6. If the result is terminal, recompute supported standard-game settlement from persisted draws and settle immediately.
7. If a real player decision remains, persist a versioned game state with exact allowed actions.
8. On a later reply from the original player, accept only a currently allowed action, then persist the next state or settle once.
9. Expire stale reservations and reconcile uncertain transfers.

Continuation tools resolve the active wager from requester and Discord game-session scope. Opaque database IDs copied by the model are not authority. `expectedVersion` prevents concurrent or replayed actions. Confirmation, acknowledgement, or “settle” is not a fake gameplay action.

Standard coin-flip and blackjack settlement is recalculated by `src/tools/standardWagerSettlement.ts` from the durable wager and verified draw transcript. The model's payout, explanation, or claimed winner cannot override it. `standardWagerRuntime.ts` applies the verified result at the money-moving boundary.

## Provable randomness

`src/rng/provable.ts` implements commit/reveal randomness:

1. Generate a secret server seed and publish `SHA-256(serverSeed)` before draws.
2. Combine the server seed, client seed, nonce, and block counter with HMAC-SHA256.
3. Use rejection sampling to map bytes into an unbiased bounded value.
4. Persist the session, nonce, parameters, and outcome atomically.
5. Reveal the server seed on request and roll to a fresh commitment for future draws.

The proof footer publishes the commitment and every drawn outcome. Anyone can verify a retained session with:

```bash
npm run verify:rng -- --session <session-id>
```

Without database access, verify that `sha256(serverSeed)` equals the commitment and recompute each draw from `HMAC-SHA256(serverSeed, "clientSeed:nonce:block")` using the stored parameters.

Draws are public when made. Hidden-information games therefore defer hidden cards until the action that reveals them. A blackjack opening draw contains two player cards and the dealer upcard; the dealer hole and later cards are drawn only after play reaches that point. The committed sequence remains fair without leaking hidden state to the model.

## Randomness without money

Non-wager chance requests still use `drawRandom`. The random-outcome guard ensures the final answer reflects the actual persisted result and proof rather than an invented model choice. A draw is scoped to the current Discord request/session and audited even when no funds are involved.

## Operations and verification

Useful commands:

```bash
npm run payments:status
npm run payments:rebalance
npm run payments:reconcile
npm run payments:provision-bot
npm run verify:rng -- --session <session-id>
```

Before enabling a real-value network, verify provisioning, requester transfers, whole-balance sends, fee sponsorship, starter grants, administrative corrections, reservation concurrency, win/loss/push settlement, restart recovery, and reconciliation.

Payment, wager, RNG, or migration changes require focused unit tests and `npm run verify:db`. Include duplicate submission, concurrent reservation/action, post-commit failure, expiry, and exactly-once settlement cases in proportion to the change.
