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
- Durable conversational schedules that can deliver a reminder or run fresh read-only work, survive restarts, and be managed by ordinary replies.

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
- All bot-owned updates share one configured Discord channel: deployment announcements, improvement questions, repair progress, verification, and fixes. Ordinary request replies and their task status remain in the member's originating conversation.
- A `🐛` report is triaged silently. A standalone public thread appears in that bot channel only when the bot needs a reporter answer or repair work begins; once opened, it carries later verification and resolution turns. The bot mentions the reporter in the first turn, and DM is the fallback when the channel is unconfigured, unavailable, outside the guild, or inaccessible to the reporter.
- Final content, files, components, and non-model footers are delivered through one durable response path. Every terminal prompt reply includes a compact elapsed-time footer independent of operator tooling.
- Long-running code updates edit a dedicated task status message and finish with a PR or a concrete terminal reason.
- Deployment announcements explain member-visible and internal changes concretely in plain English. Technical names are included only when useful and are explained rather than presented as unexplained jargon; available details are not hidden behind generic maintenance or reliability language.
- Internal tool names, implementation jargon, canned report templates, and chain-of-thought claims do not belong in ordinary answers.

## Schedules and reminders

A member may create a one-shot or recurring schedule in ordinary language. A schedule either delivers literal reminder text or runs its stored request with fresh read-only agent capabilities at delivery time. Members may list, cancel, pause, resume, or update either kind through the same flow. A returned ID is an explicit reference; replying directly to the latest delivered notification or result is an equally authoritative reference without exposing an ID in the delivery. The model resolves natural language using the requester's validated timezone context. Code accepts only an exact future first instant and, for recurrence, a matching daily, weekly, or monthly local wall-clock rule. Postgres owns one row for the whole series; a delayed queue job is only a wakeup, and periodic reconciliation restores missed wakeups after downtime.

A scheduled agent occurrence is autonomous but never gains new authority. It receives only contracts declared non-mutating, its execution context independently denies current-message mutation authority, and it resolves current facts from fresh tools. It cannot transfer funds, mutate Discord, change settings, start code work, create another schedule, or perform any other mutation. Each occurrence has a deterministic runtime execution and delivery identity, and scheduled traffic is observed separately from member-initiated answers. The occurrence records whether the requested work succeeded, partially succeeded, or failed independently of whether Discord delivery succeeded. Three consecutive failed runs pause a recurring agent schedule and notify the requester; a successful or partial run clears the failure streak.

Delivery returns to the originating channel, mentions only the requester, and revalidates that the requester can still view the channel. Agent schedules replace one nonce-deduplicated status message with the final normal response. Listing schedules includes active and recent terminal schedules, their latest run outcome, an authorized result link, and any automatic pause so a member can ask naturally what happened. Reply resolution requires the exact latest delivery message, channel, guild, and immutable requester; other reply-chain context never selects a schedule. A recurring time change names either the next occurrence or the whole series, and ambiguous requests ask rather than silently choosing. Schedule, mode, and recurrence replacement is atomic, and obsolete queue wakeups re-check the new durable time and no-op. A removed member, deleted channel, or lost visibility fails closed rather than moving private request text to another channel or DM. Each delivered occurrence advances a durable sequence before enqueueing the next wakeup. Downtime collapses missed intervals into one overdue delivery followed by the next future occurrence, rather than flooding the channel. Recurrence stays in the requester's IANA timezone: a repeated fall-back wall time fires once at the earlier instant, while a nonexistent spring-forward wall time moves to the first valid minute after the gap. Monthly rules skip months without their requested day.

## Improvement loop

1. A member uses the bot normally.
2. A questionable result, developer impediment, runtime anomaly, or product gap enters the unified improvement stream as a signal. `🐛` is the member-facing shortcut and is not a negative verdict.
3. Signals are idempotent by source and only deterministic, high-confidence fingerprints coalesce automatically. Production incidents fingerprint their typed root cause rather than generic wrapper errors or a deployment-wide gate. Operators explicitly merge uncertain matches.
4. The retained evidence is reconstructed in a clean checkout. Unsupported reports are dismissed; confirmed defects require an accepted contract whose every check has a registered, available proof producer.
5. A report authorizes its confirmed repair; a trusted automated detection authorizes repair once its source-owned executable contract is accepted. Both open auto-merge PRs, and only an exact ambiguity or automation blocker requests human review.
6. CI, read-only private contract replays, post-deploy canaries, and production observation emit typed proofs. Private replay conclusions are linked automatically to their revision-matched canonical execution. Production rate and latency checks can accumulate real traffic across revisions with the same prompt, tools, model configuration, and quality-runtime semantics; hard failures and root clusters remain exact-revision evidence. An immutable receipt names the contributing cohort and resolves the case only when every active contract check passes on one verified deployment.

Improvement cases are private by default and are never published as GitHub issues. All signal sources share one lifecycle without conflating a report with a defect. A confirmed repair may publish a diff-derived PR and enable auto-merge, but private prompts, identities, Discord links, secrets, and unrelated server context remain only in retained evidence and never enter source, fixtures, commits, or public PR metadata.

Operators measure the loop from the same canonical records: throughput and phase latency, automated repair outcomes, human-review blockers, post-resolution recurrence, and observed repair cost. This effectiveness view is content-free and reports coverage when telemetry is missing rather than treating missing observations as successful or free work.

## Non-goals

- Slash commands as the normal product interface.
- A separate hardcoded route for every phrasing or edge case.
- A model that authorizes its own privileged action or invents changing state.
- A second execution ledger, transcript, or delivery tracker.
- Public storage of private Discord content, prompts, logs, or evals.
- Enterprise multi-tenancy or regulated-workload compliance.
- Exposure or storage of private model chain of thought.
