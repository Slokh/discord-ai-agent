# Product

Discord AI Agent is a shared assistant for a private Discord community. A member mentions the bot and asks for an outcome in ordinary language. The model understands the request, uses the available capabilities, and replies naturally; members do not learn commands, tool names, lifecycle states, or blockchain terminology.

## Intended experience

- One conversational surface: `@ai ...`, replies, attachments, reactions, and Discord components.
- Concise answers by default. Structure is used only when it helps the request.
- Permission-aware use of server history and attachments.
- Current external evidence for facts that can change.
- Useful partial results when a complete result is impossible.
- Reviewable code-update PRs when a member asks the bot to change itself.
- Enough retained evidence to explain a wrong, slow, missing, or surprising result.

The primary deployment is a technically operated friend group, club, or small community. The system favors clear behavior, low operational burden, and strong protection of the few boundaries that carry real consequences.

## Model-led, code-governed

The model owns semantic judgment:

- intent and follow-up interpretation;
- tool selection from the deployed capability contract;
- evidence relevance;
- harmless aliases and server culture;
- wording, formatting, and whether a rich Discord layout is useful;
- custom game narration and rules inside the supported wager lifecycle.

Code owns facts and authority that must not be improvised:

- current requester, guild, channel, reply scope, and Discord permissions;
- tool availability and administrative access;
- current external, Discord, wallet, and transaction state;
- explicit current-turn mutation intent;
- money movement, receipt verification, idempotency, and reconciliation;
- randomness, wager exposure, durable game state, and exactly-once settlement;
- queue state, cancellation, timeouts, durable delivery, and retries;
- data bounds, retention, redaction, and secret handling.

This boundary is the central design rule. Ordinary language should not be classified by growing sets of regexes, response scanners, or prompt-specific branches. A deterministic guard is justified when it validates a stable high-consequence invariant, not when it tries to outguess the model's meaning.

## Truth and freshness

A claim should come from the source that owns it:

| Claim | Required source |
| --- | --- |
| Discord message, member, attachment, or aggregate | Current Discord API state or requester-visible indexed history |
| Current public fact | Current web/provider evidence |
| Wallet balance or transfer | Configured chain/provider plus the payment ledger |
| Random outcome | Persisted provable RNG draw |
| Generated table count, filter, or ranking | Deterministic file/table tools |
| Execution result | Canonical runtime events and delivery state |

Conversation memory and model recall provide context, never live fact authority. When current evidence is unavailable, the answer should name the missing evidence briefly rather than substitute a stale snippet or plausible value.

## Identity, privacy, and continuity

The author of the current Discord message is the immutable requester. Mentions, replies, prior messages, memory, and model-supplied arguments cannot replace that identity for permissions, money, admin actions, secrets, deletion, or wagers.

Harmless self-described names, relationships, and server lore are conversational context. They need no defensive identity challenge because they grant no authority.

Reply chains and session memory carry subject and conversational continuity. They do not silently authorize a new mutation. Retrieval never returns content from a channel the requester cannot currently view. Private server content stays in Postgres or the gitignored `.discord-ai-agent/` overlay.

## Mutations and recovery

A current user request must authorize a mutation. After code has committed an external or durable mutation, a later audit, formatting, balance refresh, or model failure must not cause the system to repeat it. The runtime returns the committed result, marks limitations as partial, records diagnostics, and lets durable reconciliation finish uncertain provider state.

Randomness and wagers add two rules: exposure is reserved before entropy is consumed, and settlement happens at most once from verified persisted state.

## Discord behavior

- Plain text is the default; Components V2 is for choices, forms, media, or hierarchy that materially benefit from native UI.
- A loading reaction may indicate work. If that reaction cannot be added, the bot stays silent until the final response instead of posting a placeholder reply that competes with it.
- A member can add `🔄` or `🔃` to retry a terminal code/bug task or their own non-mutating bot reply. Each active reaction is durable and idempotent; retries never repeat a completed mutation.
- Final content, files, components, and non-model footers are delivered through one durable response path. Every terminal prompt reply includes a compact elapsed-time footer independent of operator tooling.
- Long-running code updates edit a dedicated task status message and finish with a PR or a concrete terminal reason.
- Deployment announcements explain member-visible and internal changes concretely in plain English. Technical names are included only when useful and are explained rather than presented as unexplained jargon; available details are not hidden behind generic maintenance or reliability language.
- Internal tool names, implementation jargon, canned report templates, and chain-of-thought claims do not belong in ordinary answers.

## Improvement loop

1. A member uses the bot normally.
2. A questionable result, developer impediment, runtime anomaly, or product gap enters the unified improvement stream as a signal. `🐛` is the member-facing shortcut and is not a negative verdict.
3. Signals are idempotent by source and only deterministic, high-confidence fingerprints coalesce automatically. Operators explicitly merge uncertain matches.
4. The retained evidence is reconstructed in a clean checkout. Unsupported reports are dismissed; confirmed defects require an accepted contract whose every check has a registered, available proof producer.
5. A report authorizes its confirmed repair. The repair opens an auto-merge PR; an exact ambiguity or automation blocker is the only reason to request human review.
6. CI, read-only private contract replays, post-deploy canaries, and production observation emit typed proofs. Private replay conclusions are linked automatically to their revision-matched canonical execution. An immutable receipt resolves the case only when every active contract check passes on one verified deployment.

Improvement cases are private by default and are never published as GitHub issues. All signal sources share one lifecycle without conflating a report with a defect. A confirmed repair may publish a diff-derived PR and enable auto-merge, but private prompts, identities, Discord links, secrets, and unrelated server context remain only in retained evidence and never enter source, fixtures, commits, or public PR metadata.

## Non-goals

- Slash commands as the normal product interface.
- A separate hardcoded route for every phrasing or edge case.
- A model that authorizes its own privileged action or invents changing state.
- A second execution ledger, transcript, or delivery tracker.
- Public storage of private Discord content, prompts, logs, or evals.
- Enterprise multi-tenancy or regulated-workload compliance.
- Exposure or storage of private model chain of thought.
