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
| Final Discord rendering obligations | `deliveryObligationsRepository.ts` |
| Components V2 actions | `discordComponentActionRepository.ts` |
| Code-update projections | `agentTaskRepository.ts` and focused read repositories |
| Audits and costs | `auditRepository.ts` |
| Payments and randomness | focused payment repositories and `rngRepository.ts` |
| Server overlays and model settings | `serverOverlayRepository.ts`, `agentSettingsRepository.ts` |

`src/db/repositories.ts` delegates to these modules for existing callers. New durable behavior belongs in the focused owner.

## Discord archive lifecycle

Gateway events persist new, edited, and deleted messages. `src/discord/crawler.ts` performs initial and reconciliation crawls for bot-visible channels. The archive records Discord identifiers, author/member metadata, reply relationships, reactions, attachment metadata, and deletion state.

The bot must not have Administrator permission merely to make retrieval convenient. It indexes only what its Discord identity can see. Request-time visibility is stricter: tools derive the current requester's viewable channels and apply that scope to every history, attachment, stats, topic, and summary query.

Blocked users, excluded channels, privacy deletion, and crawl cursors are durable data operations. Fix those paths in the archive/retrieval lifecycle rather than hiding results in a prompt.

## Embeddings and retrieval

Stored messages are keyword-searchable immediately. Embedding jobs add 1536-dimensional vectors asynchronously. Changing the embedding dimension requires a migration of both the vector column and HNSW index.

Native Discord polls put their visible question and answers outside the ordinary message body. Persistence derives bounded poll text into `normalized_content` while retaining the original payload in `raw`, so poll choices participate in retrieval without treating raw payload as model context. After deploying this behavior, run `npm run polls:backfill -- --apply` from a trusted configured environment, then `npm run embeddings:backfill`, to repair historical poll retrieval.

History search can combine lexical and semantic candidates. Queries apply requester-visible channels plus explicit channel, thread, author, and date filters. A semantic-provider failure may degrade to lexical/recent candidates with an explicit limitation; it never widens scope.

Retrieval output is bounded and includes enough provenance for the model to distinguish evidence from summary: matched snippets, authors/channels, timestamps, links where available, applied filters, result counts, and degradation notes.

Attachments are resolved from permission-filtered archive metadata, then refreshed through the Discord API before download because CDN URLs expire. Downloads, archive expansion, extracted text, media transcription, and batch size are bounded. Attachment content is untrusted model evidence and is not copied into audit summaries.

## Conversation memory

Conversation memory is keyed to the Discord conversation scope and retains compact user/assistant/tool continuity. `promptBuilder.ts` selects bounded recent context and reply-chain evidence. Older messages can be summarized into snapshots by `conversationCompaction.ts`; recent raw messages remain available.

Memory may preserve a subject, preference, or prior result. It cannot:

- change the current requester;
- grant access to a channel;
- authorize a new mutation;
- establish a current price, balance, availability, or transaction state;
- replace a persisted game or wager record.

Undo operations update both visible Discord output when possible and durable conversation state. They do not rewrite the canonical audit history.

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

Chat, code updates, crawls, and embedding batches record only in the canonical runtime ledger. Code-update task rows are projections linked to the task runtime execution, which is also the sole artifact store for sandbox callbacks.

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

`improvement_cases` is the canonical materialized lifecycle. `improvement_signals` preserves source-specific provenance and exact idempotency; `improvement_evidence` records bounded conclusions and retained-ledger references; `improvement_contracts` versions observable expected behavior and executable checks; `improvement_case_events` is the append-only operator stream. Cases are private unless explicitly marked publication-safe.

Coalescing is conservative. A unique source key prevents duplicate intake, while a deterministic fingerprint may attach a new signal to one open case in the same guild/privacy boundary. Semantic similarity never merges automatically. Merging moves signals and evidence to the target while retaining the source case as a dismissed audit record.

Actionable cases require supporting evidence and an active contract with a machine-executable check. Linked code tasks use `agent_tasks.improvement_case_id`; terminal success moves the case to verification and failure returns it to actionable. Resolution requires supporting `deployment_verification` evidence. Prompt-compatible contract checks export to `.discord-ai-agent/evals/`; tests, database invariants, delivery checks, and deployment canaries remain executable in their owning harness.

The evaluator restores requester and channel scope from retained runtime evidence but does not reproduce Discord attachments. File-inspection contracts therefore require another executable check or manual review. A content-free deployment verification row still gates release promotion by revision and unique rollout ID; it is separate from case-specific acceptance evidence.

## Migrations and consistency

Add a numbered forward migration for schema or index changes. Keep migrations safe for both a fresh baseline install and upgrade from every supported prior migration. Repository methods that claim idempotency, exactly-once transition, reservation, or queue handoff must enforce it in SQL transactions or constraints, not only in application memory.

Use row locks, unique keys, compare-and-set versions, and explicit terminal-state checks where concurrent workers or retries can collide. Keep job payloads small: durable context belongs in rows or artifacts, while the queue carries identifiers required to resume.

DB integration tests mirror that ownership boundary. Each test file creates, migrates, and drops an isolated schema, so destructive fixture cleanup cannot race another file and the suite can retain normal file-level parallelism.

## Retention and deletion

Worker maintenance bounds canonical runtime events, runtime sessions, artifacts, transient budget reservations, and audit logs using the configured retention windows. A value of zero disables the corresponding automatic cleanup. Conversation compaction separately limits raw continuity rows.

Privacy deletion covers the archive, embeddings, attachments, emoji-derived state, reporter-owned improvement signals and linked private evidence, conversation threads and snapshots derived from the requester, agent-runtime sessions/artifacts, and code-update tasks. Empty cases are removed; shared cases retain only evidence not derived from the deleted reporter. Entire affected conversation threads are removed because summaries and assistant/tool turns may derive from the deleted message even when they have another author. Operational payment/randomness evidence may retain redacted structure when required to explain a transaction, but it must not retain deleted private message bodies unnecessarily.

## Verification

Repository and migration changes require `npm run verify:db`. Add concurrency, idempotency, and upgrade coverage for lifecycle changes. Retrieval changes should test permission filters before ranking quality. Privacy changes should test every derived store. Finish with `npm run verify` and `npm run scan:release`.
