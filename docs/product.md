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
- Member-facing bot updates share one configured Discord channel: deployed fixes and improvements, plus repair follow-ups that need a reporter response. Private Console, automation-health, and operator-ledger changes never create Discord posts. Ordinary request replies and their task status remain in the member's originating conversation.
- A `🐛` report is triaged silently. When an exact reporter answer is required, the bot mentions that reporter in a reply to the original report; otherwise investigation and repair stay silent. The only later member-facing update is the final reply after the related fix has been deployed and verified. Improvement delivery never creates a thread or sends a DM.
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
5. A report authorizes its confirmed repair; a trusted automated detection authorizes repair once its source-owned executable contract is accepted. Both open auto-merge PRs. The case remains in progress until the exact published head actually merges; failed checks trigger bounded repair, while only an exact ambiguity, changed head, merge conflict, draft, or unresolved review requirement requests human review.
6. CI, read-only private contract replays, post-deploy canaries, production observation, reconciliation, and its external watchdog emit typed proofs or content-free producer-run receipts. The reconciler watches the boundary proof producers and external watchdog; the independently scheduled watchdog watches the reconciler, so neither component decides that its own absence is healthy. Producer failures coalesce into the private case stream and Console, and recovery is proved only by a later successful producer run. Private replay conclusions are linked automatically to their revision-matched canonical execution. Production rate and latency checks can accumulate real traffic across revisions with the same prompt, tools, model configuration, and quality-runtime semantics; hard failures and root clusters remain exact-revision evidence. An immutable receipt names the contributing cohort and resolves the case only when every active contract check passes on one verified deployment.

Improvement cases are private by default and are never published as GitHub issues. All signal sources share one lifecycle without conflating a report with a defect. A confirmed repair may publish a diff-derived PR and enable auto-merge, but private prompts, identities, Discord links, secrets, and unrelated server context remain only in retained evidence and never enter source, fixtures, commits, or public PR metadata.

Operators measure the loop from the same canonical records: throughput and phase latency, automated repair outcomes, human-review blockers, post-resolution recurrence, and observed repair cost. This effectiveness view is content-free and reports coverage when telemetry is missing rather than treating missing observations as successful or free work.

## Operator console

A retained Discord source message has exactly one Activity owner. When it starts an agent execution, the Console represents it only as the corresponding Prompt or Reply story and uses the retained source content—including the resolved bot mention—as that story's overview title. Only retained messages that did not initiate an execution become standalone Message stories.

The default Activity type selection keeps prompts and replies, improvements, and code changes visible. Its accessible multi-select can independently add messages, releases, or system activity, remove any default type, and persists non-default selections in the URL; at least one type always remains selected.

The Activity sidebar represents distinct operator problems, not the records produced while handling them. Improvement cases that share an explicitly retained source execution form one issue story. The source prompt failure and linked repository tasks become evidence in that story instead of separate rows, and the detail trace combines every related case and repair attempt. Unlinked failures remain independent; titles or semantic similarity never merge activity automatically.

For improvement work, the Console lazily joins the case milestones to every linked repair attempt when its detail is opened. It projects one coherent chronological trace using the same row grammar as prompt and reply details: content-minimized signal provenance, supporting evidence, the accepted expected behavior, linked repository work, and deployment proof appear in sequence with semantic attempt boundaries and failures. Grouped model, task, command, progress, and retained-evidence records expand through Show all with their real occurrence counts and durations. A bounded operator-safe failure category explains outcomes such as retry exhaustion or a workspace branch collision. Repetitive reconciliation heartbeats collapse to their latest state so they cannot crowd out diagnostic evidence. Raw task errors, command text, output, prompts, and artifact contents stay in the retained production ledger.

Operators have one private, read-only dashboard at `https://console.mindcool.dev` for the system's current shape: service liveness, prompts, repository work, improvements, proof producers, verified releases, messages, and typed activity. The hosted Console authenticates through Discord OAuth and admits only users whose current OAuth guild list contains the configured private server; local loopback development remains auth-free. It projects the canonical runtime and improvement records instead of introducing a parallel tracker. One compact top bar holds environment, revision, services, proof producers, and release detail, with the service and producer summaries aligned to the right and their secondary detail available on hover or keyboard focus. Below it, the Console is a master-detail workspace: a fixed Activity sidebar keeps filters and the independently scrollable story index visible while the selected story's context and execution detail update in place beside it. Current prompts and code work are pinned first, every non-terminal improvement remains present even when its latest event is outside the recent window, linked repair work folds into the same improvement story, and repeated successful system jobs collapse into rollups. Repository retries are attempts within one logical story: improvement work groups by case and direct work groups by its retry root. A task completing means the agent published its result, not that the change shipped; Activity continues through pull-request open, merged, and exact verified deployment states. Activity includes every eligible story from a uniform three-day completed-activity window for prompt and background executions, repository work, improvement events, retained Discord messages, and verified releases; all open improvements remain present regardless of age. Count ceilings never run before semantic folding, so a noisy background producer cannot hide a failure, another job kind, a prompt, or repository work. Mutually exclusive All, Running, Waiting, Issues, and Done filters answer where work stands instantly from one complete selected-type index. Issues combines open blocked work and terminal failures because both need investigation, while each row and detail retains its exact state. A separate type selector narrows the same stream to prompts and replies, messages, improvements, code changes, releases, or system activity without creating separate queues. On a desktop first load without a deep link, the first visible activity is selected automatically with a replace-state URL so the detail pane is immediately useful without adding a redundant browser-history entry; narrow screens remain list-first. Command-K on macOS or Control-K elsewhere opens a Spotlight-style search over the already-loaded eligible activity projection, with accessible arrow-key selection, Enter-to-open, Escape-to-close, and focus restoration. Outside search, menus, and editable controls, Up and Down immediately open the previous or next visible activity; J and K provide the same terminal-style traversal. Transient service and proof health remains in the top bar, while sustained actionable failures enter the improvement lifecycle. Synthetic prompt executions, legacy CLI prompts, and post-deploy canary tasks remain in their canonical ledgers and proof paths but do not enter Activity. Prompt outcomes distinguish response generation from authoritative Discord delivery. Reply-originated rows use Reply as their sole type label, while top-level rows use Prompt; parent content is not duplicated in the overview. Every activity row uses the same two-line hierarchy: an accessible lifecycle circle, type, at most one exceptional qualifier, and recency on the first line, then total duration in seconds followed by the title or prompt on the second. Failure or blocked state takes qualifier priority, followed by multiple attempts. Routine outcomes, branches, detailed phases, and navigation chevrons stay out of the feed; exact source status and metadata remain in the detail pane. Selecting a row updates the URL and browser history without reloading either pane, preserving deep links to type-appropriate facts, context, source/reply or pull-request links, and recorded history. The detail header combines identity, title, summary, status, links, and non-empty facts in one surface; its compact facts footer does not repeat status. One chronological Trace beneath the header combines retained Discord context, model and tool execution, delivery transitions, typed events, and recorded runs in a universal timestamp, state, type, detail, and duration row format. Release details join the exact deployment verification to its previous verified revision, comparison link, announcement delivery, proof-producer runs, and improvement-verification outcomes. Embedding batch rollups do not enter Activity. Instead, each eligible retained Discord message from the last three days becomes its own Message story in chronological Activity: each bounded feed preview and lifecycle indicator shows whether a vector exists, while lazy detail displays the full retained message, attachments, Discord link, creation and embedding times, model, dimensions, and input version. It collapses repeated event keys, shows direct context and diagnostically important execution highlights by default, and can reveal the complete evidence stream. The projection exposes only an explicit allowlist of bounded operational metadata such as model, reasoning level, token usage, cost, tool outcome, context size, and latency; it never exposes private model reasoning, raw prompts, tool arguments, secrets, or artifact contents. Generic lifecycle rails are not rendered because current state already belongs in the header and filters. On narrow screens the same interaction becomes an accessible list-to-detail transition with a back control. Prompt details additionally join the retained Discord ancestor chain with the execution-scoped current prompt and final runtime reply, fetched only when that detail is selected. This Context view mirrors Discord's message hierarchy, renders retained text and attachment metadata, labels deleted messages, and uses each timestamp as the link back to Discord. It initially shows only the direct reply parent, current prompt, and final reply; operators can expand the earlier ancestor chain when deeper context is useful. The overview shows a bounded prompt preview because it runs inside the trusted cluster boundary; it omits member identity, full transcripts, artifacts, secret-bearing metadata, and private model reasoning. The Console has no mutation endpoints. Its only public ingress is a dedicated AWS TLS load balancer to the Console service, with the application-level Discord membership gate in front of every page, asset, and data endpoint; health remains unauthenticated for Kubernetes and load-balancer probes.

All story families use the same integrated Trace when context and execution history are distinct records. Member-report improvement stories use a private Console-only `Reported prompt`, `Reported reply`, or `Reported message` title with a cleaned, bounded preview of the retained source instead of the generic durable case title. Message detail places the retained message and its embedding outcome in sequence. Release detail places the previous verified revision, producer checks, announcements, improvement receipts, and final verification in sequence. Code-change detail shows aggregate runtime and attempt counts, pull-request and deployment facts, and the retained event history across every attempt in its logical story, including durable merge and deployment transitions. One-off system executions load their full bounded runtime history and repeated jobs stay readable as run-level rollups.

Linked repair and assessment attempts never become parallel Activity issues: they fold into their canonical improvement. Repository task retry lineages likewise render only the latest task, with the lineage's combined attempt count retained as metadata.

Prompt, reply, and standalone message rows include the retained Discord author's resolved display name immediately after duration; rows whose legacy source identity is unavailable say `Unknown author`, and other activity types omit author metadata.

The Console transport uses three explicit read models rather than a monolithic snapshot: a compact overview, a complete selected-type activity index bounded to three days, and a targeted lazy detail response that never reconstructs that index. Lifecycle filters operate locally over the index; type changes and Command-K remain server-backed. Cursoring is only a safety boundary above 2,000 summaries. The index contains bounded previews and the retained author's resolved display label, but not user IDs, full transcripts, artifacts, secret-bearing metadata, or private model reasoning. Privacy-deleted and unavailable identities render as `Unknown author`. Clients retain the last successful view during transient failures, identify it as stale, bound requests with a timeout, and retry automatically.

Deployment and scheduled health checks independently prove the hosted Console route, unauthenticated OAuth/API boundary, exact deployed revision, projection freshness, activity index, and a sampled lazy detail. Their content-free receipts appear with the other proof producers; sustained failure enters the unified improvement stream and a later successful receipt proves recovery.

## Non-goals

- Slash commands as the normal product interface.
- A separate hardcoded route for every phrasing or edge case.
- A model that authorizes its own privileged action or invents changing state.
- A second execution ledger, transcript, or delivery tracker.
- Public storage of private Discord content, prompts, logs, or evals.
- Enterprise multi-tenancy or regulated-workload compliance.
- Exposure or storage of private model chain of thought.
