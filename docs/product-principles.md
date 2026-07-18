# Product Principles

Discord AI Agent is a shared assistant for private Discord communities. It should feel like a capable member of the server: easy to talk to, aware of permitted server context, willing to act, and easy to debug when it gets something wrong.

This document is the product contract for design and engineering decisions. It describes the intended behavior, not the current implementation of every feature.

## Who It Is For

The primary users are friends and small communities, not engineers operating an enterprise platform. They should not need to learn bot commands, tool names, blockchain terminology, or internal architecture.

The primary operator is a technically capable server owner who wants to:

- add useful and entertaining capabilities quickly;
- inspect exactly what happened when a response is slow, wrong, or surprising;
- correct state through ordinary Discord prompts;
- let the bot improve itself through reviewable PRs;
- run the service at hobby-project cost without babysitting it.

## The Experience We Want

### One conversational interface

Users express outcomes in ordinary language: ask a question, attach or reply to a file, request a transfer, play a game, flag a bug, or ask the bot to debug itself. The bot resolves the needed tools and context.

Do not expose slash commands, lifecycle commands, or required tool jargon as the normal product surface. Operator scripts and authenticated consoles may exist for deployment and recovery, but Discord interactions stay conversational.

### Concise by default

Simple questions should get simple answers. The bot should lead with the result, use one short paragraph when that is enough, and stop. Lists, headings, tables, and longer explanations are for genuinely structured or multi-part requests.

Avoid canned report templates, repeated summaries, unnecessary caveats, and closing offers. Formatting should serve the answer rather than announce the implementation.

### Native to the server

The bot should use Discord reply context, permitted server history, member resolution, attachments, reactions, links, and learned custom-emote culture naturally. It should not pretend public internet facts are server knowledge or leak context across channels the requester cannot view.

The bot may use a learned custom emote inline or react to the source message when the server's usage supports it. It should not force an emote into every response or use both styles at once.

### Useful before impressive

Prefer a reliable primitive that solves many prompts over a demo tailored to one message. File inspection should gain format adapters; data analysis should produce queryable tables; Discord knowledge should improve at the indexing and retrieval layer; external data should use reusable provider contracts.

If part of a request is possible, do that part and state the real limitation briefly. Do not invent unsupported values to make a feature look complete.

## Model-Led, Code-Governed

The model should own semantic work:

- interpreting user intent and follow-ups;
- choosing among available tools;
- deciding what evidence matters;
- selecting conversational wording and useful formatting;
- applying game-specific rules inside the allowed random/wager lifecycle;
- deciding whether an emote fits the social context.

Code should own hard guarantees:

- immutable requester, guild, channel, and reply-chain scope;
- Discord permissions and private-data filtering;
- tool authorization and explicit mutation intent;
- live wallet balances, transfer endpoints, receipts, fee sponsorship, and idempotency;
- random entropy, wager exposure, continuation ownership, and exactly-once settlement;
- durable execution, queue handoff, retry bounds, cancellation, and delivery state;
- bounded file parsing, secret redaction, retention, and non-model footers.

When a failure can be fixed by a better schema, result, prompt, data lifecycle, or general guard, prefer that over matching one exact prompt with hidden code.

Deterministic intent guards are appropriate when a model mistake could move money, fabricate live facts, invent chance outcomes, cross a permission boundary, or lose durable state. They should recognize a stable capability and remain narrow enough not to replace normal language understanding.

## Truth And Freshness

The bot should never state a changing fact as verified without fresh evidence from the current turn.

- Discord facts come from permission-filtered indexed history or the Discord API.
- Prices, fares, schedules, seat availability, weather, and similar public facts use current external evidence, with web search as the first general option.
- Wallet balances come from the configured token onchain; absent wallets are reported honestly as `$0` where the product permits that view.
- Transfers come from receipt-verified ledger state.
- Chance outcomes come from the provable RNG tool, never model selection.
- Generated-file counts, rankings, and filters come from deterministic table/file tools, not visual counting by the model.

When exact current data is unavailable, say what is missing in the shortest useful way. Historical averages or snippets are not substitutes for purchasable offers or live availability.

## Identity And Continuity

Every request is scoped to the member who sent the current Discord message. Mentions, replies, old memory, model arguments, and tool results cannot replace that requester.

Reply chains provide continuity, not authority. They may identify the subject of a follow-up or resume the original player's durable game, but they cannot authorize a new transfer, admin action, deletion, or wager without explicit current-turn intent.

Prompts sharing a Discord thread are serialized. Unrelated threads may run concurrently. Deployment announcements and other background bot messages must not cancel or steal an in-flight user request.

## Money And Games

Managed balances use six-decimal USDC.e but are presented to users as USD or `$`. Users should not need blockchain knowledge.

- User wallets are created automatically when enabled.
- The shared bot wallet sponsors user-wallet network fees.
- Ordinary users can transfer only from their own managed wallet to another verified member or the bot.
- Owner/ops corrections can move funds between managed wallets with an explicit reason.
- Arbitrary external addresses and private-key export are outside the current product.
- Starter funding is automatic and tops an eligible below-target balance up to the configured amount.
- Games reserve real exposure before consuming entropy and settle through the wallet ledger exactly once.
- The bot should reject games whose stated rules guarantee player profit or whose supported probability contract is provably unfair to the treasury.

See [`wallets.md`](wallets.md) and [`provable-rng.md`](provable-rng.md) for implementation invariants.

## Debuggability Is A Feature

Every user-visible run should be explainable without guessing. We want visibility into observed model inputs and outputs, selected and rejected tools, timings, token/cache use, costs, retries, external calls, state transitions, delivery, and failures.

The product does not claim to expose private chain-of-thought. Debugging uses the evidence the system actually observed and the deterministic decisions it made.

Operators should be able to reply to a Discord message and ask what happened. Coding agents should begin with the run inspector or `inspectAgentLogs`, not browser automation or speculative source reading. The console and terminal tooling should derive from the same typed runtime events.

## Improvement Loop

The intended loop is:

1. A member uses the bot normally.
2. The operator marks a bad message with the configured bug reaction or asks for debugging in a reply.
3. The bot retrieves the marked, permission-visible cases and their prompt context.
4. A code-update task reproduces the issue, adds regression coverage, and opens a reviewable PR.
5. Deployment posts concise, casual patch notes linked to the exact version diff.
6. The operator retests in Discord and uses traces/evals to confirm the outcome.

Features should strengthen this loop instead of introducing opaque side paths.

## Cost, Latency, And Proportionality

- Acknowledge Discord requests quickly and keep the user informed only when work is genuinely long-running.
- Avoid an extra model call when deterministic code can safely complete the step.
- Scope tool schemas and dynamic prompt context to what the turn may need.
- Move repeated expensive work to ingestion, indexing, caching, or reusable artifacts.
- Run independent read-only work concurrently where ordering does not matter.
- Record cost and critical-path timing before optimizing from intuition.
- Apply defenses proportionally to a private friend-server deployment, while keeping strict controls around secrets, privacy, money, and destructive actions.

Current performance targets are recorded in [`continuation-plan.md`](continuation-plan.md). Treat measurements from the run console as more authoritative than those historical targets when the system evolves.

## Definition Of A Complete Feature

A feature is not complete only because the happy path produces an answer. A complete slice includes, in proportion to its risk:

- natural Discord behavior with no new command vocabulary;
- correct data ownership and requester scope;
- a model-facing tool or prompt contract if semantic selection is needed;
- deterministic guards for high-consequence invariants;
- failure, retry, timeout, concurrency, and cleanup behavior;
- typed observability with latency/cost visibility;
- focused unit or integration tests and an eval case where model behavior matters;
- operator/debugging support;
- updated ownership and behavior documentation.

Large cohesive PRs are acceptable when these pieces must land together for a safe cutover. Do not split a feature so narrowly that intermediate states violate the product contract.

## Non-Goals

- An enterprise multi-tenant security platform.
- A slash-command bot with a conversational wrapper.
- A model that silently improvises financial state, randomness, or live data.
- A separate hardcoded tool for every prompt or file edge case.
- Public exposure of private Discord content, prompts, evals, credentials, or member-specific behavior.
- A claim to expose or store private model chain-of-thought.
