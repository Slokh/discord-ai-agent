# Provably Fair RNG

The `drawRandom` and `revealRandomness` tools give the bot verifiable randomness for games of chance (blackjack, dice, coin flips, raffles, shuffles). Outcomes are computed in code — never by the model — using a commit–reveal scheme, so players can prove after the fact that no result was invented or altered.

## How it works

Each conversation thread has an RNG **session** with a secret 32-byte `serverSeed`. The session publishes `commitment = SHA-256(serverSeed)` **before** any outcome is produced, in the proof footer of the first draw's reply.

Every entropy-consuming draw gets a monotonically increasing `nonce`. Its random bytes come from a deterministic stream:

```
block_i = HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${i}`)
```

- `clientSeed` is the Discord id of the message that triggered the first draw. Discord assigns message ids (snowflakes), not the bot, so the bot cannot pick a seed pair that favors it.
- Integers use rejection sampling over 32-bit blocks (no modulo bias); shuffles use Fisher–Yates driven by the same stream.
- Card draws (`kind: "cards"`) come from a persistent per-thread **shoe**: one shuffle nonce fixes the full deck order, and cards are dealt without replacement by advancing a stored position. Dealing more cards than remain automatically shuffles a fresh shoe.

Because the commitment binds the server seed before outcomes exist, and the client seed comes from Discord, neither side can bias results without detection.

## What players see

Every reply that consumed randomness carries a non-model footer (Discord subtext) appended by the delivery pipeline — the model cannot alter it:

- the draw outcome, nonce, and session id
- on the first draw of a session: the commitment and client seed
- after a reveal: the server seed and the next session's commitment

## Verifying fairness

Ask the bot to **"reveal randomness"**. This ends the current session, publishes its `serverSeed`, lists every draw, and starts a successor session with a fresh commitment (draws after a reveal stay unpredictable).

With database access:

```sh
npm run verify:rng -- --session rng_ab12cd34ef56
```

This recomputes every stored draw from the revealed seed and deep-compares it against what was recorded and reported.

Without database access, using only values from the Discord messages:

```sh
# check the commitment
npm run verify:rng -- --server-seed <hex> --commitment <hex>

# recompute a dice draw
npm run verify:rng -- --server-seed <hex> --client-seed <messageId> --nonce 0 --kind dice --sides 6 --count 2

# recompute a card draw (nonce = the shoe's shuffle nonce)
npm run verify:rng -- --server-seed <hex> --client-seed <messageId> --nonce 1 --kind cards --deck-count 1 --start 0 --count 2
```

Or independently, with any tooling: check `SHA-256(serverSeed) == commitment`, then recompute each draw from `HMAC-SHA256(serverSeed, "clientSeed:nonce:block")` per the scheme above. The reference implementation is [`src/rng/provable.ts`](../src/rng/provable.ts); the live tool and the verifier share it, so a verified recomputation is exactly the computation that produced the result.

## Data model

`migrations/002_provable_rng.sql` adds two tables:

- `rng_sessions` — one active session per `thread_key` (enforced by a partial unique index), holding the server seed, commitment, client seed, nonce counter, shoe state (`deck_count`, `shuffle_nonce`, `deck_position`), and reveal status. Sessions link to their predecessor via `prev_session_id`.
- `rng_draws` — one row per recorded draw with `nonce`, `kind`, `params`, and the exact `outcome` that was reported, plus the request/message/user that triggered it.

Nonce assignment and shoe-position advancement are single atomic `UPDATE ... RETURNING` statements, so concurrent draws in one thread cannot reuse entropy or deal the same card twice.

## Design notes

- **Generic, not blackjack-specific.** The tool exposes draw kinds (`integers`, `dice`, `coin`, `pick`, `shuffle`, `cards`); game rules stay with the model. The provable part is exactly the part the model must not control: the entropy and its mapping to outcomes.
- **The model reports, code decides.** `drawRandom` returns computed outcomes and instructs the model to report them exactly; the proof footer repeats the values from code so any model tampering is visible by comparison.
- **Reveal is rollover, not shutdown.** Revealing a seed would let future draws be predicted, so `revealRandomness` always starts a new committed session in the same thread.
