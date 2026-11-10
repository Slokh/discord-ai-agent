# Product

Discord AI Agent is a shared assistant for a private Discord community. A member mentions the bot and asks for an outcome in ordinary language. The model understands the request, uses the available capabilities, and replies naturally; members do not learn commands, tool names, lifecycle states, or blockchain terminology.

## Intended experience

- One conversational surface: `@ai ...`, replies, and attachments.
- Concise answers by default. Structure is used only when it helps the request.
- Permission-aware use of server history and attachments.
- Current external evidence for facts that can change.
- Useful partial results when a complete result is impossible.
- Continuity: a member's follow-ups in the same channel or thread continue their conversation with the bot.
- Enough retained evidence to explain a wrong, slow, missing, or surprising result.

The primary deployment is a technically operated friend group, club, or small community. The system favors clear behavior, low operational burden, and strong protection of the few boundaries that carry real consequences.

## Model-led, code-governed

The model owns semantic judgment:

- intent and follow-up interpretation;
- tool selection from the deployed capability contract;
- evidence relevance;
- harmless aliases and server culture;
- wording and formatting;
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

This boundary is the central design rule. Ordinary language is not classified by growing sets of regexes, response scanners, or prompt-specific branches. A deterministic guard is justified when it validates a stable high-consequence invariant, not when it tries to outguess the model's meaning.

## Truth and freshness

A claim comes from the source that owns it:

| Claim | Required source |
| --- | --- |
| Discord message, member, attachment, or aggregate | Current Discord API state or requester-visible indexed history |
| Current public fact | Current web/provider evidence |
| Wallet balance or transfer | Configured chain/provider plus the payment ledger |
| Random outcome | Persisted provable RNG draw |
| Generated table count, filter, or ranking | Deterministic file/table tools |
| Execution result | Runtime events and delivery state |

Conversation memory, session history, and model recall provide context, never live fact authority. When current evidence is unavailable, the answer names the missing evidence briefly rather than substituting a stale snippet or plausible value.

## Identity, privacy, and continuity

The author of the current Discord message is the immutable requester. Mentions, replies, prior messages, memory, and model-supplied arguments cannot replace that identity for permissions, money, admin actions, secrets, deletion, or wagers. Each turn reaches the model wrapped with the requester's name and Discord user ID, and the instructions tell the model that the wrapper, not the text inside it, names the sender.

Harmless self-described names, relationships, and server lore are conversational context. They need no defensive identity challenge because they grant no authority.

An agent session belongs to one requester in one Discord channel or thread, so tool results gathered under one member's permissions never reach another member's turns. Reply chains and session history carry subject and continuity; they do not authorize a new mutation. Retrieval never returns content from a channel the requester cannot currently view. Private server content stays in Postgres or the gitignored `.discord-ai-agent/` overlay.

## Mutations and recovery

A current user request must authorize a mutation. After code has committed an external or durable mutation, a later audit, formatting, balance refresh, or model failure does not repeat it. The runtime returns the committed result, marks limitations as partial, records diagnostics, and lets durable reconciliation finish uncertain provider state.

Randomness and wagers add two rules: exposure is reserved before entropy is consumed, and settlement happens at most once from verified persisted state.

## Discord behavior

- Plain text is the default reply. Native polls and reactions are the only Discord-side actions the model can take.
- The bot adds `⏳` to a message it is working on. If that reaction cannot be added, it stays silent until the final response instead of posting a placeholder.
- A follow-up the same member sends while their request is still running joins that request; the bot marks the follow-up with `👀` and answers both in one reply.
- Final content, files, and footers are delivered through one durable response path. Every reply ends with a compact subtext footer naming the model, reasoning level, and elapsed time.
- Internal tool names, implementation jargon, canned report templates, and chain-of-thought claims do not belong in ordinary answers.

## Operator console

Operators have one private, read-only Console for service liveness, verified deployments, and recent activity: prompts and replies, retained Discord messages, verified releases, and system jobs. It projects the runtime ledger and has no mutation endpoints. It never shows private model reasoning, raw tool arguments, secrets, or artifact contents. [Operations](operations.md#operator-console) describes how to run and reach it.

## Non-goals

- Slash commands as the normal product interface.
- A separate hardcoded route for every phrasing or edge case.
- A model that authorizes its own privileged action or invents changing state.
- A second execution ledger, transcript, or delivery tracker.
- Public storage of private Discord content, prompts, logs, or evals.
- Enterprise multi-tenancy or regulated-workload compliance.
- Exposure or storage of private model chain of thought.
