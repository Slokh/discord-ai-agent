# Pre-Release Hardening Plan

This is the concrete cleanup/hardening checklist to complete before new feature work. It comes from a full-repo review (2026-07) plus a reference review of `paradigmxyz/centaur` and `tempoxyz/centaur-tempo`.

Relationship to other docs:

- `docs/improvement-plan.md` is the long-term product roadmap (phases and exit criteria).
- This file is the tactical plan: workstreams, tasks, and verification for the current cleanup pass.
- When a task here changes architecture, update `docs/architecture.md` in the same PR.

How to use this file:

- Check off tasks as they merge. Keep the checkbox line intact so progress stays visible in diffs.
- Tasks are sized to be independently shippable (one PR each, sometimes a few small ones per PR).
- Do not start WS6 (structural splits) before WS2 (ledger consolidation) lands.

## Decisions

These decisions drive every workstream. If one is reversed, re-plan the affected workstreams before continuing.

- **D1. One canonical execution ledger.** The agent-runtime session (sessions, messages, executions, events, keyed by thread key) is the single source of execution truth. Legacy process runs, codegen mirrors, and task events become read-only projections and are then removed. This mirrors Centaur: the session event stream is the client contract; everything else replays it.
- **D2. Chat runs in-process, permanently.** Sandboxes are for code-update tasks only. The former warm chat prompt server and child-process transport are removed, not "experimental". Centaur's pod-per-conversation runtime serves a company-platform threat model that does not apply here.
- **D3. Discord owns delivery state only.** The bot process persists delivery obligations (which message to edit, last event applied) and can recover rendering after a crash by replaying session events. It never owns execution truth.
- **D4. Local-process is the default code-update backend.** Kubernetes stays supported as the advanced isolation mode, but new adopters get a working code-update flow without a cluster.
- **D5. Private content lives in the overlay boundary.** Server-specific persona, emoji, examples, evals, and config live in `.discord-ai-agent/` or DB overlays/skills. The base repo ships neutral defaults. `scripts/scanRelease.ts` enforces the boundary.
- **D6. Cost governance is a first-class feature.** Scoped toolsets, prompt-cache-friendly ordering, model tiering, and per-user/guild budgets. This goes beyond the Centaur references (they have operational limits only) because unattended hobby cost is a project goal.

## Workstream Order

```diagram
╭──────────────╮   ╭──────────────────╮   ╭─────────────────╮
│ WS1 Hygiene  │   │ WS2 Ledger       │──▶│ WS6 Structural  │
│ & Overlay    │   │ Consolidation    │   │ Splits          │
╰──────┬───────╯   ╰────────┬─────────╯   ╰─────────────────╯
       │                    │
       ▼                    ▼
╭──────────────╮   ╭──────────────────╮   ╭─────────────────╮
│ WS9 Docs/CI/ │   │ WS3 Cost         │──▶│ WS4 Budgets &   │
│ Release      │   │ Reduction        │   │ Abuse Guards    │
╰──────────────╯   ╰──────────────────╯   ╰─────────────────╯

Parallel any time: WS5 Retention, WS7 Robustness, WS8 Defaults
```

Suggested sequence: WS1 → WS2 → WS3 → WS7 → WS4/WS5 → WS6 → WS8 → WS9 final pass. WS5, WS7, and WS8 have no hard dependencies and can interleave.

---

## WS1: OSS Hygiene And Overlay Contract

Goal: nothing private in the tracked repo; a defined home for private content; a scanner that enforces both.

### Scrub tracked private data

- [x] Replace the private custom loading-emoji snowflake default with `⏳` in `src/config/env.ts` and `src/discord/responseSink.ts`; update `tests/unit/config.test.ts`, `tests/unit/discord-response-sink.test.ts`, `tests/unit/core-tools.test.ts`, `tests/unit/kubernetes-backend.test.ts`, `tests/unit/sandbox-runner.test.ts` fixtures.
- [x] Replace `example/discord-ai-agent` with `example/discord-ai-agent` in test fixtures and `src/control/console/fixtures.ts` (`tests/integration/agent.test.ts`, `tests/unit/codegen-lease-scheduler.test.ts`, `tests/unit/codegen-status.test.ts`).
- [x] Replace the real-looking channel ID and `#example-channel` fixture in `tests/unit/sandbox-runner.test.ts`.
- [x] Replace the "Alex" example in `src/tools/registry.ts` and generalize personal names in `tests/integration/agent.test.ts` fixtures.
- [x] Neutralize "Discord server assistant" / "server fun" wording in `src/agent/router.ts` and `src/tools/imageTools.ts` system prompts ("your Discord server" phrasing).
- [x] Make the Spotify market configurable (`SPOTIFY_MARKET`, default `US`) instead of the constant in `src/tools/spotifyTools.ts`.

### Define the overlay boundary

- [x] Document the overlay contract in `README.md` and `docs/architecture.md`: base repo = neutral defaults; `.discord-ai-agent/` (gitignored) and DB overlays/skills = private persona, emoji, evals, examples, per-server config.
- [x] Add an optional persona/prompt overlay file (for example `.discord-ai-agent/prompt-overlay.md`) loaded into the system prompt when present, so tone customization never requires editing tracked source.
- [x] Move any remaining server-specific eval content out of `evals/prompts/` (niche private product prompts) into `.discord-ai-agent/evals/`.

### Enforce with the release scanner

- [x] Extend `scripts/scanRelease.ts`: report line numbers; detect generic key shapes (`sk-*`, `xox*`, `Bearer <token>`); flag Discord snowflakes outside an explicit fixture allowlist; flag the original owner name and known-private strings.
- [x] Add a scanner self-test so a seeded fake leak fails CI.

Exit criteria: `npm run scan:release` fails on any of the leaks listed above if reintroduced; a fresh clone contains nothing tied to the original server.

---

## WS2: Runtime Ledger Consolidation

Goal: one execution ledger (D1), no dual-writes, dead executor paths removed (D2). This deletes more code than it adds and unblocks WS6.

### Ratify and document the end state

- [x] Rewrite the "Centaur-style" migration paragraph in `docs/architecture.md` to state D1–D3 explicitly: canonical = agent-runtime session events; chat = in-process; sandboxes = code tasks only; Discord = delivery obligations.

### Collapse ingress dual-writes

- [x] Make `src/discord/client.ts` ingress write only the agent-runtime session (message + execution). Remove the parallel `upsertProcessRun`/`storeProcessRunArtifact` writes; derive run-console views from session data via a read adapter.
- [x] Remove the dual queue handoff: one enqueue path through `src/agent/runtimeControlPlane.ts` for all Discord executions; delete the legacy branch in `client.ts`.
- [x] Deduplicate prompt-text representations (request text, envelope text, input lines, loaded artifact) down to the envelope + input-lines artifact in `src/agent/runtimeEnvelope.ts`.

### Collapse code-update task mirrors

- [x] Make `src/jobs/agentTaskEnqueue.ts` write one canonical record (runtime session/execution) plus at most one projection; remove the triple-write (task row + codegen mirror + runtime mirror).
- [x] Fold `src/jobs/agentTaskCodegenMirror.ts` and `src/jobs/agentTaskRuntimeMirror.ts` into the single write path or delete them.
- [x] Remove the "legacy queue-side mirror" fallback in `src/tools/agentTaskTools.ts` once all callers carry agent-runtime context.
- [x] Move remaining direct codegen-table writes out of `src/db/repositories.ts` task-lifecycle methods into `CodegenRepository`/`AgentRuntimeRepository`.

### Unify event recording

- [x] Record each model/tool event once (runtime transcript/events) in `src/agent/router.ts`; derive trace events, spans, and tool-audit views from it or write them from one shared helper rather than four call sites.
- [x] Verify `src/discord/taskNotifications.ts`, the run console, and `getAgentTaskStatus` read from `agent.task.*` runtime events only, then delete the legacy task-event fallback ordering.

### Remove dead executor machinery

- [x] Delete the old warm chat executor paths: the old warm chat prompt executor files, HTTP/child-process transports, related config, scripts, and tests.
- [x] Delete `src/discord/commands.ts` (empty payload) or convert `registerCommands.ts` into an explicit `clear-commands`-only script.
- [x] Remove the unused queued Discord agent request alias in `src/discord/client.ts`.

Exit criteria: a Discord turn and a code-update task each produce exactly one write path into the ledger; `rg` finds no remaining "mirror"/"compatibility fallback" writes; `npm run verify` and `npm run verify:db` pass.

---

## WS3: Cost Reduction

Goal: cut typical per-turn input tokens by 50–80%. Today every model round carries ~13k static tokens (41 tool schemas ≈ 11k + system prompt ≈ 2.3k), up to 4 rounds plus synthesis/recovery.

### Scoped toolsets

- [x] Add tool groups to `src/tools/registry.ts` and deterministic per-turn selection. Follow-up hardening split the former 11-tool `core` group into minimal core, generated-data, and Discord-action groups so ordinary chat starts with two local schemas rather than 21 core/retrieval schemas.
- [x] Register Spotify tools only when `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` are configured (deployment-level allowlist, mirroring Centaur's `TOOL_ALLOWLIST` behavior).
- [x] Add eval prompts covering toolset-selection misses before enabling by default (`docs/evals.md` flow).

### Prompt-cache-friendly ordering

- [x] Reorder `chatMessages()` in `src/agent/router.ts` so the large static system prompt is the first message; move requester/skills/overlay/session/reply context after it.
- [x] Enable OpenRouter prompt caching in `src/models/openrouter.ts` (cache markers / provider preferences as supported); confirm `cached_tokens` shows up in usage metadata via `npm run runs:inspect`.

### Model tiering

- [x] Add `OPENROUTER_UTILITY_MODEL` config and use it for nested calls in `src/tools/coreTools.ts` (`summarizeDiscordHistory`, `getDiscordChannelTopics`, `summarizeCurrentThread`) and any classification/compression calls.

### Trim per-turn context

- [x] Reduce default session memory from 24 to ~8 messages in `src/discord/client.ts` (`SESSION_CONTEXT_MESSAGE_LIMIT`); use the larger window only for reply-chain follow-ups.
- [x] Exclude prior tool-result bodies from session memory by default unless the turn references them.
- [x] Cap tool result bytes entering the prompt (truncate with a stored-artifact pointer), following the existing `storedContent` pattern.

### Bound retry amplification

- [x] Cap logical model calls per turn (rounds + recovery + synthesis) with a hard ceiling in `src/agent/router.ts`.
- [x] Stop auto-retrying 429s on expensive chat/image calls in `src/models/openrouter.ts` unless `Retry-After` is short; make empty-response recovery use a minimal prompt.

Exit criteria: `npm run runs:inspect` shows typical-turn input tokens reduced ≥50% versus a captured baseline; eval suite shows no answer-quality regression.

---

## WS4: Budgets And Abuse Guards

Goal: a friend spamming `@ai` cannot create surprise spend. Uses the `estimatedCostUsd` already recorded in tool audits.

- [x] Per-user rolling limits (config-driven defaults, e.g. N turns/day, M image generations/day, 1 codegen task/day) checked at ingress before any model call.
- [x] Per-guild daily estimated-spend cap; when exceeded, reply with a cheap static "budget exhausted" message.
- [x] Owner/allowlist gating for `runCodingAgent`, `updateBotAvatar`, and optionally `generateImage` (config, default owner-only for codegen).
- [x] Surface spend on demand: an ops-tool answer for "how much have we spent today/this month" (replaces the reverted cost-footer approach from PR #150/#151).
- [x] Per-execution silence timeout + hard timeout (Centaur-style `EXECUTION_SILENCE_TIMEOUT`/`HARD_TIMEOUT`) replacing the single 30-minute blanket for chat; keep long timeouts for code tasks only.

Exit criteria: limits verifiably trip in tests; a spam loop costs bounded dollars; expensive tools are permission-gated.

---

## WS5: Data Retention And Storage Bounds

Goal: no unbounded tables; a long-running deployment stays small without manual DB work.

- [x] Add a configurable retention job (worker-side, like `artifactRetention.ts`) for: `trace_events`, `tool_audit_logs`, `task_events`, `process_run_*`, `codegen_events`, `sandbox_command_events` (default 30–90 days), and embedding-batch process runs/artifacts (7–14 days).
- [x] Conversation-memory compaction: after N turns per thread key, summarize older turns into a snapshot row and prune raw rows (`conversation_messages`).
- [x] Add missing hot-path indexes (migration 009): `tool_audit_logs(guild_id, created_at DESC)`; `process_run_artifacts(expires_at) WHERE expires_at IS NOT NULL`; `agent_tasks(updated_at DESC, created_at DESC)`; partial index for stale-running task scans; partial live-message indexes for backlog/recent scans.
- [x] Document (not fix) the filtered vector-search scaling limit in `src/db/README.md`: the filtered branch bypasses the IVFFLAT index; revisit with ANN-first + candidate escalation or an HNSW index if any deployment approaches ~1M messages.

Exit criteria: retention job covered by a DB-gated test; steady-state DB size bounded; `EXPLAIN` on the hot queries uses the new indexes.

---

## WS6: Structural Splits

Goal: no god files; each domain owned by a focused module. Do this after WS2 so you do not split code that is about to be deleted. Preserve compatibility exports first, then migrate imports.

### `src/db/repositories.ts` (6.1k lines → facade)

Extraction order (smallest/highest-value first):

- [x] `embeddingRepository.ts`: embeddings, backlog selection, batch storage.
- [x] `retrievalRepository.ts`: visible channels, keyword/vector/recent/context/attachment search, user/channel lookup, stats/topic candidates.
- [x] `discordArchiveRepository.ts`: guilds/channels/users/members/messages/attachments, privacy deletion, crawl cursors, exclusions.
- [x] `conversationMemoryRepository.ts`: sessions/messages/turn deletion/memory stats (add WS5 compaction here).
- [x] `processRunRepository.ts` + `auditRepository.ts`: runs/spans/events/artifacts, traces, tool audits (add WS5 retention here).
- [x] `agentTaskRepository.ts`: remaining task lifecycle after WS2 removes codegen-table writes.
- [x] `skillsRepository.ts`: skills and skill changes.
- [x] Reduce `repositories.ts` to a delegating facade; update `src/db/README.md` ownership map.

### `src/discord/client.ts` (2.1k lines)

- [x] `messageIngress.ts`: mention handling, persistence, session creation, queue handoff.
- [x] `agentDelivery.ts`: queued execution, reply delivery, run finalization.
- [x] `turnPreparation.ts`: envelope build/replay, input lines.
- [x] `replyContext.ts`: reply-chain and attachment context.
- [x] `reactions.ts`: reaction persistence, undo, regeneration.
- [x] `mentionParsing.ts` and `api.ts` (Discord API helpers; WS7's wrapper lands here).
- [x] Keep `client.ts` as the thin bot construction/event-wiring entrypoint.

### `src/agent/router.ts` (2.1k lines)

- [x] `modelLoop.ts`: round loop and route selection.
- [x] `toolDispatcher.ts`: local tool dispatch + argument coercion.
- [x] `promptBuilder.ts`: message assembly (carries WS3 ordering).
- [x] `finalSynthesis.ts` and `modelRecovery.ts`: synthesis, empty-response and hosted-tool recovery.
- [x] `runtimeTranscript.ts`: single event-recording helper (from WS2).
- [x] Keep `handleAgentRequest` as the compatibility entrypoint.

### `src/tools/coreTools.ts` (1.25k lines → true facade)

- [x] `discordResolverTools.ts`, `discordRetrievalTools.ts`, `discordSummaryTools.ts`, `discordOpsTools.ts`, `agentMemoryTools.ts`; `coreTools.ts` becomes export-only.
- [x] While splitting, add the shared tool-result status envelope (`status`, `errorCode`, `retryable`, `limitation` on `AgentResponse` in `src/tools/types.ts`) and standardize each family's error mapping.
- [x] Move Spotify under `src/tools/spotify/` with conditional registration (from WS3).

### `src/execution/sandboxRunner.ts` (2.8k lines)

- [x] `runnerPipeline.ts`: `runCodeUpdate` orchestration only.
- [x] `repoWorkspace.ts`: mirror/worktree/branch/git state/push.
- [x] `dependencyCache.ts`: install/restore/manifest cache.
- [x] `harness/codex.ts` and `harness/opencode.ts` behind a `CodegenHarnessAdapter` interface; rename Codex-centric shared types (`CodexAttemptSummary` → `AgentAttemptSummary`).
- [x] `contextPack.ts`, `callbacks.ts`, `commands.ts`.
- [x] Decide: keep both harnesses behind the adapter, or keep OpenCode (current default) and drop the Codex app-server + exec fallback until wanted.

Exit criteria: no source file over ~800 lines in these domains; folder READMEs updated; `npm run verify` green after each extraction.

---

## WS7: Robustness Hardening

Goal: common Discord/API/sandbox failures degrade gracefully instead of sinking a turn.

### Discord delivery

- [x] Shared Discord write wrapper (in `src/discord/api.ts`) for reply/edit/send/react/delete with error classification: `Unknown Message` → fresh reply; `Missing Access`/permission → log + fallback; 429 → respect retry-after (reuse the retry helpers already in `src/discord/crawler.ts`); route `responseSink.ts` through it.
- [x] Durable delivery obligations (Centaur render-obligation pattern): persist channel/status-message/execution/last-event per in-flight turn; on bot startup, scan pending obligations and finish rendering from session events. Removes the "bot restart loses the reply" failure.
- [x] Log/metric shard lifecycle events (`shardDisconnect`, `shardReconnecting`, `shardResume`, `invalidated`) in `src/discord/client.ts`.

### Sandbox callbacks and launch

- [x] Harden callback auth in `src/execution/token.ts` + `src/control/internalApi.ts`: bind tokens to `{taskId, sandboxRunId}`, sign body + timestamp, reject callbacks for terminal tasks, accept the terminal callback once.
- [x] Close the orphan window: record the sandbox run row (with deterministic job name from taskId) before creating Kubernetes resources in `src/execution/backend.ts`; add an "already has active run" guard in the worker path in `src/jobs/queue.ts`.
- [x] Label-based orphan sweep in `src/execution/reconciler.ts`: scan cluster Jobs/Secrets/ConfigMaps by `discord-ai-agent/task-id` label and clean ones with no DB row.
- [x] Scope the GitHub credential: prefer GitHub App installation tokens limited to the target repo; document that `GITHUB_TOKEN` for local dev should be fine-grained and single-repo.

Exit criteria: killing the bot mid-turn still delivers the reply after restart; a forged/replayed callback is rejected in tests; a worker crash during launch leaves no unreconciled cluster resources.

---

## WS8: Defaults And Proportionality

Goal: the out-of-box posture matches a small private server; heavy infrastructure is opt-in.

- [x] Flip `CODEGEN_EXECUTION_BACKEND` default to `local-process` (D4); keep Kubernetes documented as the advanced isolation mode. Decouple local-process config from `execution.kubernetes.*` field names in `src/config/env.ts`/`src/execution/backend.ts` (now `execution.sandbox.cacheDir`/`taskTimeoutSeconds`).
- [x] Disable the code-update feature unless GitHub credentials are configured; reply with a clear "not configured" message instead of failing mid-task (`missingCodegenConfig` gates tool scoping, `createAgentUpdateFromRequest`, and `retryAgentTask`).
- [x] Enforce a branch policy for self-update pushes (only `agent/`-prefixed branches; never default/protected branches) in `src/execution/repoWorkspace.ts` + `runnerPipeline.ts`. New branches are generated as `agent/...`; legacy `ai/...` branches stay allowed for follow-ups on existing PRs.
- [x] Add requester attribution to code-update context (Centaur pattern): requester is resolved once at ingress (`agentTaskTools.ts`) and every PR body ends with a `Prompted by:` line (`prFormatting.ts`, covered by `tests/unit/sandbox-runner.test.ts`).
- [x] Move `docs/eks-deploy.md`/`docs/local-kubernetes.md` under an explicit "advanced deployment" framing in the README; quickstart should be Docker Compose + `npm run dev` only.

Exit criteria: a new adopter reaches a working bot (chat + memory + code-update PRs via local-process) with Docker, Node, a Discord token, an OpenRouter key, and a GitHub token — no cluster.

---

## WS9: Docs, CI, And Release Readiness

Goal: docs match the code; CI catches what matters; the repo has public-project scaffolding.

### Config and onboarding accuracy

- [x] Sync `.env.example` with `src/config/env.ts` (63 vars read, 24 documented): add at minimum `DATABASE_URL`, `CONTROL_UI_AUTH_PASSWORD`, `OPENROUTER_CODEGEN_MODEL`, `CODEGEN_HARNESS`, `CODEGEN_EXECUTION_BACKEND`, worker toggles, and sandbox resource knobs — or generate a full env reference doc from the config schema and link it.
- [x] Fix README: quickstart `.env` includes `DATABASE_URL`; document `CONTROL_UI_AUTH_PASSWORD`; align the loading-reaction default; clarify which roles (`bot`/`worker`/`api`) are needed for which features.
- [x] Update `docs/architecture.md` and folder READMEs after WS2/WS6 land (remove aspirational "migration direction" phrasing that no longer applies).

### Project scaffolding

- [x] `package.json`: add `license`, `repository`, `bugs`; decide on `private: true` (keep if never publishing to npm, but document why).
- [x] Add `CONTRIBUTING.md` (dev setup, `npm run verify`, PR expectations) and a security contact in `SECURITY.md`.
- [x] Add issue/PR templates and a Dependabot config under `.github/`.

### CI

- [x] Add `npm run build` (includes the Vite console build) to CI so bundling breaks fail PRs.
- [x] Add a CodeQL (or equivalent) workflow and scheduled dependency audit.
- [x] Fix/clarify the `GITHUB_REPOSITORY` Helm value in `.github/workflows/deploy-eks.yml` (implicit Actions default vs intended repo).
- [x] Add coverage reporting (no threshold gate required initially).

Exit criteria: a new contributor can go clone → `.env` → running bot using only the README; CI fails on build, lint, type, test, scan, or seeded-leak regressions.

---

## Verification Baseline

Capture these before starting, re-run after each workstream:

```sh
npm run verify          # lint + typecheck + tests + audit
npm run verify:db       # migrations + DB-gated tests
npm run scan:release    # private-data scanner
npm run eval -- --dry-run
npm run runs:inspect -- --list --limit 5   # token/cost baseline for WS3
```

Baseline as of 2026-07: verify green (466 passed / 56 skipped), scan:release green (but see WS1 scanner gaps), typical turn ≈ 13k static input tokens/round with up to 4 rounds.

## Post-plan cleanup (completed)

The settled runtime cleanup removed the compatibility surfaces that were still present while this checklist was being executed: the `src/tools/coreTools.ts` barrel/facade is gone, durable workflow code and tables are gone, `task_events` and its dual-write/fallback path are gone, and the former `codegen_*` runtime ledger has been renamed to `agent_runtime_*` with `harness_thread_id`. Migrations are now squashed into the single `migrations/001_initial.sql` baseline, with `scripts/legacy-schema-transition.sql` for one-time upgrades of pre-squash databases. Legacy `/api/codegen/*` routes were removed in favor of `/api/agent/sessions/:threadKey` and `/api/tasks/status`.
