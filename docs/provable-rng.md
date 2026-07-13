# Provably Fair RNG

The `drawRandom` and `revealRandomness` tools give the bot verifiable randomness for games of chance (blackjack, dice, coin flips, raffles, shuffles). Outcomes are computed in code — never by the model — using a commit–reveal scheme, so players can prove after the fact that no result was invented or altered.

## How it works

Each Discord reply chain has an RNG **session** with a secret 32-byte `serverSeed`. A fresh top-level prompt starts a separate session; a reply continues the session rooted at the original prompt. The first draw's proof footer publishes `commitment = SHA-256(serverSeed)`, which binds every later outcome in that session to the same seed.

Every entropy-consuming draw gets a monotonically increasing `nonce`. Its random bytes come from a deterministic stream:

```
block_i = HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${i}`)
```

- `clientSeed` is the Discord id of the message that triggered the first draw. Discord assigns message ids (snowflakes), not the bot, so the bot cannot pick a seed pair that favors it.
- Integers use rejection sampling over 32-bit blocks (no modulo bias); shuffles use Fisher–Yates driven by the same stream.
- Card draws (`kind: "cards"`) come from a persistent per-session **shoe**: one shuffle nonce fixes the full deck order, and cards are dealt without replacement by advancing a stored position. Dealing more cards than remain automatically shuffles a fresh shoe.

Once published, the commitment binds the server seed before later outcomes exist, and the client seed comes from Discord, so neither side can change later results without detection. The first-draw caveat is documented below.

## What players see

Every reply that consumed randomness carries a non-model footer (Discord subtext) appended by the delivery pipeline — the model cannot alter it:

- the draw outcome, nonce, and session id
- on the first draw of a session: the commitment and client seed
- after a reveal: the server seed and the next session's commitment

## Verifying fairness

Reply **"reveal randomness"** to a game result to reveal that reply chain's session. A standalone request resolves to the requester's most recently used active RNG session in the channel. Revealing publishes the `serverSeed`, lists every draw, and starts a successor session with a fresh commitment (draws after a reveal stay unpredictable).

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

- `rng_sessions` — one active session per RNG-scoped `thread_key` (the conversation key plus the Discord reply-root message id, enforced by a partial unique index), holding the server seed, commitment, client seed, nonce counter, shoe state (`deck_count`, `shuffle_nonce`, `deck_position`), and reveal status. Sessions link to their predecessor via `prev_session_id`. Legacy channel-scoped keys remain discoverable for standalone reveals during cutover.
- `rng_draws` — one row per recorded draw with `nonce`, `kind`, `params`, and the exact `outcome` that was reported, plus the request/message/user that triggered it.

All writes go through two serialized paths in [`src/db/rngRepository.ts`](../src/db/rngRepository.ts): draws run inside a transaction that holds a `FOR UPDATE` row lock on the reply chain's active session, and `revealAndRollover` flips the session to `revealed`, snapshots its draws, and inserts the committed successor under the same lock. Concurrent draws in one reply chain therefore cannot reuse a nonce or deal the same card twice, and no draw can slip into a session after its reveal listed the draws.

Beyond recomputing each stored outcome, `npm run verify:rng -- --session <id>` checks transcript-level invariants: every nonce in `[0, nonce_counter)` was consumed by exactly one entropy draw, every card row references a recorded shoe shuffle with a matching deck count, and card slices per shoe are contiguous from position 0 with no overlaps or gaps.

## Design notes

- **Generic, not blackjack-specific.** The tool exposes draw kinds (`integers`, `dice`, `coin`, `pick`, `shuffle`, `cards`); game rules stay with the model. The provable part is exactly the part the model must not control: the entropy and its mapping to outcomes.
- **The model reports, code decides.** `drawRandom` returns computed outcomes and instructs the model to report them exactly; the proof footer repeats the values from code so any model tampering is visible by comparison.
- **Reveal is rollover, not shutdown.** Revealing a seed would let future draws be predicted, so `revealRandomness` always starts a new committed session in the same reply chain.
- **Outcomes are public at draw time.** The proof footer publishes every drawn outcome immediately — that is the anti-tampering mechanism, and it cannot be suppressed. Games with hidden information (a blackjack dealer's hole card, face-down cards) must therefore defer those draws until play reveals them. The shoe order is committed by the shuffle nonce, so a card drawn later is exactly as fair as one drawn earlier — and deferring also keeps the card out of the model's context, so it cannot leak *or* inform the model's play. The tool description instructs the model to deal this way, and the `random-blackjack-deal` eval asserts no dealer draw of 2+ cards sneaks into the audit trail.

## Known limitations

- **First-draw grinding window.** A reply chain's very first draw publishes the commitment, the client seed, and the first outcome in the same reply — the session is created lazily when that draw runs, after the triggering message (and thus the client seed) exists. A malicious operator could regenerate server seeds until the first outcome favored them, for that one draw only; every later draw is bound by the already-published commitment. Rolled-over sessions don't have this window either: their commitment appears in the reveal reply, before any of their draws. Closing it entirely would need a commitment published before the first request (e.g. an explicit "start session" step), which isn't worth the friction for this bot's private-server threat model.
- **Footer truncation.** Proof footers truncate long outcomes (many cards, large picks) for readability. The stored transcript is the source of truth; `npm run verify:rng` always verifies the full outcome.
