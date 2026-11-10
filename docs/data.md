# Data

This guide covers Postgres ownership, Discord indexing and retrieval, conversation memory, the runtime ledger, agent sessions, permissions, privacy, migrations, and retention.

## Data model principles

- Postgres is the durable source of truth.
- Each lifecycle has one canonical repository owner.
- Read models are projections, not competing ledgers.
- Permission filtering happens before private Discord content enters model context.
- Current provider state wins over cached or conversational state for changing facts.
- Migrations move forward; production never rolls a schema backward.
- Raw private content stays out of event metadata, logs, fixtures, docs, and public evals.

## Repository ownership

Focused repositories under `src/db/` own persistence:

| Domain | Primary modules |
| --- | --- |
| Executions, runtime sessions, messages, events, artifacts | `agentRuntimeRepository.ts`, `agentRuntimeArtifactRepository.ts` |
| nanocode session ownership | `nanocodeSessionRepository.ts` |
| Discord guilds, channels, users, messages, attachments, cursors | `discordArchiveRepository.ts` |
| Retrieval and aggregates | `retrievalRepository.ts`, `retrievalAttachmentRepository.ts`, `retrievalStatsRepository.ts` |
| Embedding queue and vectors | `embeddingRepository.ts` |
| Conversation continuity and compaction | `conversationMemoryRepository.ts`, `conversationCompaction.ts` |
| Final Discord rendering obligations | `deliveryObligationsRepository.ts` |
| Audits and budgets | `auditRepository.ts`, `budgetRepository.ts` |
| Payments and randomness | focused payment repositories and `rngRepository.ts` |
| Server overlays | `serverOverlayRepository.ts` |
| Typed per-user preferences | `userPreferenceRepository.ts`; capability-owned validators interpret each key |
| Verified releases | `deploymentVerificationRepository.ts` |
| Rows of tables with no remaining writer | `retiredFeatureDataRepository.ts` (privacy deletion only) |

`src/db/repositories.ts` composes these modules for callers. New durable behavior belongs in the focused owner.

## Discord archive lifecycle

Gateway events persist new, edited, and deleted messages. `src/discord/crawler.ts` performs initial and reconciliation crawls of bot-visible channels; the worker schedules one daily. The archive records Discord identifiers, author and member metadata, reply relationships, reactions, attachment metadata, and deletion state.

The bot does not need Administrator permission. It indexes only what its Discord identity can see. Request-time visibility is stricter: tools derive the current requester's viewable channels and apply that scope to every history, attachment, stats, topic, and summary query.

Blocked users (`npm run blocked-users`), excluded channels, privacy deletion, and crawl cursors are durable data operations. Fix those paths in the archive and retrieval lifecycle rather than hiding results in a prompt.

The Console resolves retained user mentions through the archived guild-member display name, with global-name and username fallback, and role mentions through the role snapshots retained with each message. Unknown mentions stay unresolved, and the archived message is never rewritten.

## Embeddings and retrieval

Stored messages are keyword-searchable immediately. Ingress enqueues eligible human-authored messages for embedding, but the standard worker leaves the paid embedding consumer off; run `npm run embeddings:worker` or `npm run embeddings:backfill` to fill the 1536-dimensional pgvector column. Changing the embedding dimension requires migrating both the vector column and its HNSW index.

Discord polls and link previews put visible text outside the message body. Persistence derives bounded poll and preview text into `normalized_content` while keeping the original payload in `raw`, so those messages participate in retrieval without exposing the raw payload to the model. Preview extraction keeps only a bounded title, description, provider, and canonical HTTP(S) URL; it strips credentials and fragments and ignores unsupported URLs. Discord may finish a preview after message creation, so message updates repair persisted text and a queued turn force-fetches its source message to refresh preview context. After changing this derived text, run `npm run discord-text:backfill -- --apply` from a configured environment, then `npm run embeddings:backfill`. The backfill scans in bounded batches; `--limit=<count>` and `--batch-size=<count>` constrain a run.

History search combines lexical and, when vectors exist, semantic candidates. Queries apply requester-visible channels plus explicit channel, thread, author, and date filters. A semantic-provider failure degrades to lexical and recent candidates with an explicit limitation; it never widens scope.

High-volume recent-message and overall-stat queries resolve the small permission, channel, bot, and privacy dimensions before scanning messages. Recent retrieval uses the live-message time index with only concrete channel and author predicates; overall stats use one grouping-set scan and roll thread groups into their parent channels afterward. Keep optional-filter `OR` branches and repeated joins to small dimension tables out of these scans, because they defeat bounded index plans.

Retrieval output is bounded and carries provenance: matched snippets, authors and channels, timestamps, links where available, applied filters, result counts, and degradation notes.

Attachments are resolved from permission-filtered archive metadata, then refreshed through the Discord API before download because CDN URLs expire. Downloads, archive expansion, extracted text, media transcription, and batch size are bounded. Attachment content is untrusted model evidence and is not copied into audit summaries.

## Conversation memory and agent sessions

Two stores carry continuity:

- **Conversation memory** (`conversation_sessions`, `conversation_messages`) is keyed to the Discord channel or thread and keeps compact user, assistant, and tool continuity. Worker maintenance compacts older messages into snapshots (`conversationCompaction.ts`) and keeps recent raw messages. Turn preparation copies a bounded slice into the turn envelope.
- **nanocode sessions** (schema `nanocode`) hold the model's own history for one requester in one channel or thread under one prompt-and-tool contract. A new session receives the envelope's conversation slice once as bootstrap context; after that the session carries its own history. `nanocode_sessions` maps each session ID to its `user_id` and `thread_key`, with `created_at` and `last_used_at`.

Neither store can change the current requester, grant access to a channel, authorize a new mutation, establish a current price, balance, availability, or transaction state, or replace a persisted game or wager record.

Preferences that apply across conversations live in the generic `user_preferences` store, not conversational memory. Each key has a capability-owned validator and tool contract; arbitrary prompt-derived values never become settings. Timezone is the current key: the requester may set a validated IANA timezone or remove the override, with UTC as the unstored default.

## Runtime ledger

The `agent_runtime_*` tables explain chat turns and durable background jobs:

- sessions group work by conversation scope;
- executions represent queued, running, and terminal attempts;
- messages store structured transcript entries;
- events store typed lifecycle transitions and safe metadata;
- session and execution rows allocate event sequence numbers atomically, so concurrent model, tool, and delivery writers cannot overwrite or drop evidence;
- artifacts and chunks store turn envelopes, redacted model I/O, files, and larger diagnostics;
- background-job executions record crawl and embedding progress.

Artifacts have explicit content type, size, checksum, sensitivity, and retention behavior. Binary delivery artifacts are stored once and referenced by the delivery intent.

## Permissions and authority

The stored turn envelope captures the immutable requester, guild, channel, message, reply scope, and visible-channel data needed to replay a turn. Tool code prefers this trusted context over model arguments.

- Retrieval is limited to channels the current requester can view.
- Explicit Discord message IDs and links do not bypass visibility checks.
- The owner and ops allowlists (`BOT_OWNER_USER_ID`, `OPS_ALLOWLIST_USER_IDS`) gate `strict_ops` tools.
- Model-supplied user IDs do not replace the requester for wallet or wager authority.
- Diagnostic artifact access requires authorization to the underlying run.

## Private overlay

Tracked files contain neutral behavior only. Private data lives in:

- `.discord-ai-agent/prompt-overlay.md` for deployment-specific prompt guidance;
- `.discord-ai-agent/evals/` for private eval and replay cases;
- Postgres for server overlays, Discord content, aliases, runtime records, sessions, and memory.

`npm run scan:release` rejects secret-shaped values, private markers, and real-looking Discord identifiers in tracked content. Never paste production prompt artifacts, member names, message links, dumps, or replay cases into public GitHub metadata.

## Migrations and consistency

Add a numbered forward migration for schema or index changes. Keep migrations safe for a fresh install and for upgrade from every supported prior migration. Repository methods that claim idempotency, exactly-once transition, reservation, or queue handoff enforce it in SQL transactions or constraints, not only in application memory.

Use row locks, unique keys, compare-and-set versions, and explicit terminal-state checks where concurrent workers or retries can collide. Keep job payloads small: durable context belongs in rows or artifacts, and the queue carries the identifiers needed to resume.

nanocode creates and upgrades its own tables in schema `nanocode` when the host starts; application migrations never touch that schema.

DB integration tests mirror this ownership. Each test file creates, migrates, and drops an isolated schema, so suites keep file-level parallelism.

## Retention and deletion

Worker maintenance (`src/observability/dataRetention.ts`, `artifactRetention.ts`) applies the windows in `productConfig.retention`:

| Data | Window |
| --- | --- |
| Runtime events and budget reservations | 60 days |
| Tool audit logs | 90 days |
| Runtime sessions and nanocode sessions unused since the cutoff | 90 days |
| Terminal `scheduled_reminders` rows | 90 days |
| Runtime artifacts | each artifact's own expiry |

A window of zero disables that cleanup. Conversation compaction separately bounds raw continuity rows.

Privacy deletion (`requestUserDeletion` in `src/db/repositories.ts`) removes a member's agent-runtime sessions, conversation threads they took part in, nanocode sessions, typed preferences, and emoji-derived state, blanks their archived identity and message content, deletes their attachments and guild membership, and records the deletion in `privacy_deletions` so later ingestion cannot rehydrate it. Whole conversation threads are removed because summaries and assistant turns may derive from the deleted messages even when another member wrote them. Deleting nanocode sessions hands any deduplicated content record still linked from another session to that session and deletes the rest. Privacy deletion also clears the member's rows from the improvement, reminder, and task tables that remain in the schema without a writer. Operator projections exclude privacy-deleted users. Payment and randomness evidence may keep redacted structure needed to explain a transaction, but not deleted message bodies.

## Verification

Repository and migration changes require `npm run verify:db`. Add concurrency, idempotency, and upgrade coverage for lifecycle changes. Retrieval changes test permission filters before ranking quality. Privacy changes test every derived store, including the `nanocode` schema (`tests/native/` covers deletion with shared records). Finish with `npm run verify`.
