# Data

This guide covers Postgres ownership, Discord indexing and retrieval, conversation memory, the agent runtime ledger, permissions, privacy, migrations, and retention.

## Data model principles

- Postgres is the durable source of truth.
- Each lifecycle has one canonical repository owner.
- Read models and task/status rows are projections, not competing ledgers.
- Permission filtering happens before private Discord content enters model context.
- Current provider state wins over cached or conversational state for changing facts.
- Migrations move forward; production is never expected to roll a schema backward.
- Raw private content stays out of event metadata, logs, fixtures, docs, and public evals.

## Repository ownership

Focused repositories under `src/db/` own persistence:

| Domain | Primary modules |
| --- | --- |
| Runtime sessions, executions, messages, events, snapshots | `agentRuntimeRepository.ts`, `agentRuntimeArtifactRepository.ts` |
| Discord guilds, channels, users, messages, attachments, cursors | `discordArchiveRepository.ts` |
| Retrieval and aggregates | `retrievalRepository.ts`, `retrievalStatsRepository.ts` |
| Embedding queue and vectors | `embeddingRepository.ts` |
| Conversation continuity and compaction | `conversationMemoryRepository.ts`, `conversationCompaction.ts` |
| Unified improvement cases, signals, evidence, contracts, and events | `improvementRepository.ts` |
| Original-report replies and clarification ingestion | `improvementReporterConversationRepository.ts` |
| Final Discord rendering obligations | `deliveryObligationsRepository.ts` |
| Components V2 actions | `discordComponentActionRepository.ts` |
| Code-update projections | `agentTaskRepository.ts`, `agentTaskPublicationRepository.ts`, and focused read repositories |
| Audits and costs | `auditRepository.ts` |
| Payments and randomness | focused payment repositories and `rngRepository.ts` |
| Server overlays and model settings | `serverOverlayRepository.ts`, `agentSettingsRepository.ts` |
| Typed per-user preferences | `userPreferenceRepository.ts`; capability-owned validators interpret each key |
| Scheduled notification/agent state and delivery claims | `reminderRepository.ts` |

`src/db/repositories.ts` delegates to these modules for existing callers. New durable behavior belongs in the focused owner.

## Discord archive lifecycle

Gateway events persist new, edited, and deleted messages. `src/discord/crawler.ts` performs initial and reconciliation crawls for bot-visible channels. The archive records Discord identifiers, author/member metadata, reply relationships, reactions, attachment metadata, and deletion state.

The bot must not have Administrator permission merely to make retrieval convenient. It indexes only what its Discord identity can see. Request-time visibility is stricter: tools derive the current requester's viewable channels and apply that scope to every history, attachment, stats, topic, and summary query.

Private Console message projections resolve retained Discord user mentions through the archived guild-member display name with global-name and username fallback, and resolve role mentions through the role snapshots retained with each message. Overview previews contain the resolved `@name`; lazy detail keeps raw message content in the response alongside bounded user- and role-ID label maps so the shared trace renders the same names. Unknown mentions remain unresolved rather than guessing an identity, and the canonical archived message is never rewritten.

Blocked users, excluded channels, privacy deletion, and crawl cursors are durable data operations. Fix those paths in the archive/retrieval lifecycle rather than hiding results in a prompt.

## Embeddings and retrieval

Stored messages are keyword-searchable immediately. Embedding jobs add 1536-dimensional vectors asynchronously. Changing the embedding dimension requires a migration of both the vector column and HNSW index.

Discord polls and link previews put visible text outside the ordinary message body. Persistence derives bounded poll and preview text into `normalized_content` while retaining the original payload in `raw`, so those messages participate in retrieval without exposing the raw payload to the model. Preview extraction keeps only a bounded title, description, provider, and canonical HTTP(S) URL; it strips credentials and fragments and ignores unsupported URLs. Because Discord may finish a preview after message creation, message updates repair persisted/indexed text and a queued turn force-fetches its source message to refresh only this non-authoritative preview context. After deploying a change to this derived text, run `npm run discord-text:backfill -- --apply` from a trusted configured environment, then `npm run embeddings:backfill`, to invalidate and rebuild historical embeddings. The backfill scans matching messages in bounded batches; `--limit=<count>` and `--batch-size=<count>` can constrain an operator run.

History search can combine lexical and semantic candidates. Queries apply requester-visible channels plus explicit channel, thread, author, and date filters. A semantic-provider failure may degrade to lexical/recent candidates with an explicit limitation; it never widens scope.

High-volume recent-message and additive or active-day overall-stat queries resolve the small permission, channel, bot, and privacy dimensions before scanning messages. Recent retrieval then uses the live-message time index with only concrete channel and author predicates; those overall stats use one grouping-set scan and roll thread groups into their effective parent channels afterward. Keep optional-filter `OR` branches and repeated joins to small dimension tables out of these hot message scans, because they prevent bounded index plans and amplify work across the archive.

Retrieval output is bounded and includes enough provenance for the model to distinguish evidence from summary: matched snippets, authors/channels, timestamps, links where available, applied filters, result counts, and degradation notes.

Attachments are resolved from permission-filtered archive metadata, then refreshed through the Discord API before download because CDN URLs expire. Downloads, archive expansion, extracted text, media transcription, and batch size are bounded. Attachment content is untrusted model evidence and is not copied into audit summaries.

## Conversation memory

Conversation memory is keyed to the Discord conversation scope and retains compact user/assistant/tool continuity. `promptBuilder.ts` selects bounded recent context and reply-chain evidence. Current-message and reply-chain link previews enter as explicitly untrusted context, never as requester instructions or mutation authority. Older messages can be summarized into snapshots by `conversationCompaction.ts`; recent raw messages remain available.

Memory may preserve a subject, preference, or prior result. It cannot:

- change the current requester;
- grant access to a channel;
- authorize a new mutation;
- establish a current price, balance, availability, or transaction state;
- replace a persisted game or wager record.

Explicit user preferences that must apply across conversation scopes live in the generic `user_preferences` store rather than conversational memory. Each preference key has a capability-owned validator and model/tool contract; arbitrary prompt-derived values never become settings. Timezone is the first key: the current requester may set a validated IANA timezone or remove the override, with UTC as the unstored default.

Undo operations update both visible Discord output when possible and durable conversation state. They do not rewrite the canonical audit history.

## Schedule lifecycle

`scheduled_reminders` is the source of truth for requester-owned one-shot and recurring schedules. `delivery_kind` selects a literal notification or a due-time read-only agent execution without creating a second scheduler. A deterministic request key makes repeat execution of the same create call idempotent. A recurring row stores its validated local-time rule, timezone, next occurrence, and monotonic occurrence sequence. Rows move from `scheduled` to an atomic `delivering` claim. A one-shot then becomes `delivered`; a recurring row atomically advances its sequence and returns to `scheduled`, or may be `paused`. Either kind may become `failed` or `cancelled`, and stale delivery claims become eligible for recovery. The canonical runtime execution retains each agent occurrence and its `succeeded`, `partial`, or `failed` work outcome; the schedule row stores only the latest-run projection, execution reference, consecutive failure count, and automatic-pause time for control and member reads. Discord delivery success is not evidence that the scheduled work succeeded. Three consecutive failed outcomes pause a recurring agent schedule, while success or partial success resets the streak; manual resume also clears the automatic-pause projection. Literal notifications retain the short recovery lease; agent occurrences use a fifteen-minute lease longer than the bounded ten-minute agent runtime so reconciliation cannot start a concurrent duplicate. Request text, mode, schedule, timezone, and recurrence edits update one active row atomically; an edit racing an active delivery loses cleanly. The queue carries only the schedule ID and desired wake time; its singleton identity includes that time so advancing or rescheduling a series cannot collide with another occurrence. A stale wakeup must claim the row at its current due time, so obsolete jobs no-op. Deterministic Discord and runtime identities include the occurrence sequence and close the crash windows around execution, network delivery, and committing the delivered message ID.

Schedule request text is private member content and stays in the schedule row and authorized runtime artifacts, never queue payloads, event metadata, logs, fixtures, or public artifacts. List and mutation queries require both current guild and immutable requester. Listing includes active rows and terminal rows updated within the bounded recent-history window. The latest delivery message ID has a unique partial index for bounded direct-reply resolution; lookup additionally requires its stored delivery channel, and the list tool exposes its result link only when the requester can currently view that channel. Delivery uses the stored origin channel but revalidates current Discord visibility before sending. Agent occurrences get current visible-channel scope, no ambient channel-memory carryover, non-mutating tool contracts only, and no current-message mutation authority. Paused rows are not due; old delayed jobs safely fail their claim. Resume preserves a still-future occurrence or deterministically selects the next future occurrence, so missed intervals never create a catch-up flood.

## Canonical runtime ledger

The `agent_runtime_*` tables explain chat, code-update, and durable background-job attempts:

- sessions group retained work by conversation/task scope;
- executions represent queued, running, and terminal attempts;
- messages store structured transcript entries;
- events store typed lifecycle transitions and safe metadata;
- session and execution rows atomically allocate event sequence numbers, so concurrent model, tool, and delivery writers cannot overwrite or drop ledger evidence;
- artifacts and chunks store replay inputs, redacted model I/O, snapshots, files, and larger diagnostics;
- task-linked executions record isolated code-update lifecycle and outcomes;
- background-job executions retain crawl and embedding progress without a parallel ledger.

Chat, code updates, crawls, and embedding batches record only in the canonical runtime ledger. Code-update task rows are projections linked to the task runtime execution, which is also the sole artifact store for sandbox callbacks. Publication reconciliation adds the exact GitHub PR head, state, merge revision, and merge time to that projection; verified release promotion adds deployment identity only when its revision exactly matches the recorded merge. Both transitions append typed runtime events, so the Console can group attempts without losing their chronology.

Artifacts have explicit content type, size, checksum, sensitivity, and retention behavior. Binary delivery artifacts are stored once and referenced by the delivery manifest.

## Permissions and authority

The stored turn envelope captures the immutable requester, guild, channel, message, reply scope, and relevant visible-channel data needed to replay a turn. Tool code must prefer this trusted context over model arguments.

Permission rules:

- Retrieval is limited to channels the current requester can view.
- Explicit Discord message IDs and links do not bypass visibility checks.
- Owner/ops allowlists protect administrative capabilities.
- Model-supplied user IDs do not replace the requester for user-wallet or wager authority.
- Component actions validate stored audience, message, guild, channel, expiry, and one-time state.
- Diagnostic artifact access requires authorization to the underlying run.

## Private overlay

Tracked files contain neutral behavior only. Private data lives in:

- `.discord-ai-agent/prompt-overlay.md` for local deployment-specific prompt guidance;
- `.discord-ai-agent/evals/` for private regression prompts;
- Postgres for server overlays, Discord content, aliases, improvement cases, model settings, canonical runtime records, and memory.

`npm run scan:release` rejects secret-shaped values, private markers, and real-looking Discord identifiers in tracked content. Never paste production prompt artifacts, member names, message links, dumps, or eval cases into public GitHub metadata.

`improvement_cases` is the canonical materialized lifecycle. `improvement_signals` preserves source-specific provenance and exact idempotency; `improvement_evidence` records bounded conclusions and retained-ledger references; `improvement_contracts` versions observable expected behavior and executable checks; `improvement_verification_proofs` retains content-free source-owned results; `improvement_verification_receipts` binds all check conclusions to one contract version and deployment; `improvement_case_events` is the append-only operator stream. A member report resolves its source message against both prompt- and reply-side runtime identifiers. Its private assessment packet includes bounded archive context from only the signal's exact guild and channel, subject to channel exclusion and privacy deletion, plus linked canonical execution evidence when available. `improvement_reporter_conversations` projects that lifecycle into one Discord conversation per reported source message, while `improvement_reporter_conversation_signals` maps every original reporter signal into the shared conversation. Projection rows remain undelivered until an exact clarification is required or deployed verification resolves the case. Every visible turn is an explicit channel reply to the original source message with the reporter mentioned; no improvement thread or DM is created, and intermediate repair states stay silent. The reporter's explicit reply to a clarification is persisted as a new private signal on the existing case, never as a parallel report or public artifact. Internal evidence and ingested clarification detail remain private. Cases are private unless explicitly marked publication-safe.

Coalescing is conservative. A unique source key prevents duplicate intake, while a deterministic fingerprint may attach a new signal to one open case in the same guild/privacy boundary. Semantic similarity never merges automatically. Merging moves signals and evidence to the target while retaining the source case as a dismissed audit record.

Actionable cases require supporting evidence and an active contract whose every check has a registered proof adapter. `improvement_work_attempts` is the source of truth for authorized agent-task and GitHub-PR work; `agent_tasks.improvement_case_id` is only a rolling-deploy projection. Terminal success or merge moves the case to verification, while failure, cancellation, no diff, or close-without-merge returns it to actionable. Resolution requires a passed receipt plus supporting `deployment_verification` evidence written in the same transaction. Private replay checks export to `.discord-ai-agent/evals/`; release gates, delivery checks, production quality, and deployment canaries remain executable in their owning producers.

The evaluator restores requester and channel scope from retained runtime evidence but does not reproduce Discord attachments. Required file-inspection checks are therefore rejected until a dedicated proof adapter exists. Replays run without mutating tools or current-turn mutation authority. Their proof rows retain only the revision-matched canonical execution ID and hashed per-check conclusions; prompt and answer content stays in the runtime ledger. A content-free deployment verification row still gates release promotion by revision and unique rollout ID; it is separate from case-specific acceptance evidence.

## Migrations and consistency

Add a numbered forward migration for schema or index changes. Keep migrations safe for both a fresh baseline install and upgrade from every supported prior migration. Repository methods that claim idempotency, exactly-once transition, reservation, or queue handoff must enforce it in SQL transactions or constraints, not only in application memory.

Use row locks, unique keys, compare-and-set versions, and explicit terminal-state checks where concurrent workers or retries can collide. Keep job payloads small: durable context belongs in rows or artifacts, while the queue carries identifiers required to resume.

DB integration tests mirror that ownership boundary. Each test file creates, migrates, and drops an isolated schema, so destructive fixture cleanup cannot race another file and the suite can retain normal file-level parallelism.

## Retention and deletion

Worker maintenance bounds canonical runtime events, runtime sessions, artifacts, transient budget reservations, audit logs, and terminal reminder rows using the configured retention windows. Scheduled reminders are retained until delivered, cancelled, failed, or explicitly deleted. A value of zero disables the corresponding automatic cleanup. Conversation compaction separately limits raw continuity rows.

Privacy deletion covers the archive, guild-member identity, embeddings, attachments, emoji-derived state, typed user preferences, scheduled reminders, reporter-owned improvement signals, orphaned reporter-conversation projections and linked private evidence, conversation threads and snapshots derived from the requester, agent-runtime sessions/artifacts, and code-update tasks. Deleted guild identity cannot be rehydrated by later Discord message ingestion, and operator identity projections exclude privacy-deleted users. Empty cases are removed; shared cases and reporter conversations retain only independently sourced evidence and reporter mappings. Entire affected agent conversation threads are removed because summaries and assistant/tool turns may derive from the deleted message even when they have another author. Operational payment/randomness evidence may retain redacted structure when required to explain a transaction, but it must not retain deleted private message bodies unnecessarily.

## Verification

Repository and migration changes require `npm run verify:db`. Add concurrency, idempotency, and upgrade coverage for lifecycle changes. Retrieval changes should test permission filters before ranking quality. Privacy changes should test every derived store. Finish with `npm run verify` and `npm run scan:release`.
