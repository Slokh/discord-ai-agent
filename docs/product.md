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
- Final content, files, components, and non-model footers are delivered through one durable response path.
- Long-running code updates edit a dedicated task status message and finish with a PR or a concrete terminal reason.
- Internal tool names, implementation jargon, canned report templates, and chain-of-thought claims do not belong in ordinary answers.

## Improvement loop

1. A member uses the bot normally.
2. A questionable result is marked with `🐛` or investigated through its Discord link; the marker requests investigation and is not itself a negative verdict.
3. The retained production run is reconstructed and triaged without changing code, including request, context, tools, typed outcomes, source revision, and delivery.
4. Only a confirmed defect with a machine-checkable regression contract unlocks repair. If evidence is missing, the bot replies on the marked message and pings the reporter for the specific missing context.
5. Confirmed review feedback records an observable failure mode and executable expected/forbidden behavior in the private regression suite.
6. A code-update task or contributor opens a reviewable PR.
7. CI, the post-deploy capability canary, and a Discord retest confirm the result.

Native bug markers are private, requester-scoped reports of a bad Discord result. A member may mark a visible reply for their own inbox, but only the original request author can authorize automatic repair and replay of that request. Frog records reusable friction through separate storage contexts: repository-development friction stays in its local file store, while normal reply agents can privately record a generalized capability or tool-contract impediment in Postgres. Product reports are silent, deduplicated, operator-only, and never automatically published or synchronized to GitHub. Neither Frog store should contain a member prompt, identity, Discord link, secret, or unrelated server context.

## Non-goals

- Slash commands as the normal product interface.
- A separate hardcoded route for every phrasing or edge case.
- A model that authorizes its own privileged action or invents changing state.
- A second execution ledger, transcript, or delivery tracker.
- Public storage of private Discord content, prompts, logs, or evals.
- Enterprise multi-tenancy or regulated-workload compliance.
- Exposure or storage of private model chain of thought.
