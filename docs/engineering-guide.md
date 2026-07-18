# Engineering Guide

This guide helps a new coding agent move from an unfamiliar request to a complete, reviewable change without needing a repository-wide tour from the operator.

Read [`product-principles.md`](product-principles.md) and [`architecture.md`](architecture.md) first for complex work. The root [`AGENTS.md`](../AGENTS.md) is the concise mandatory rule set.

## First 15 Minutes

1. Confirm the worktree and branch with `git status --short` and `git branch --show-current`.
2. Read the user-visible behavior in [`product-principles.md`](product-principles.md).
3. Find the owning domain in [`../src/README.md`](../src/README.md).
4. Read the nearest folder README and its listed tests.
5. Use `rg` for the exact tool, event, response text, schema field, or lifecycle named in the request.
6. For a reported Discord behavior, inspect the run before changing code:

```bash
npm run runs:inspect -- <discord-message-link-or-id> --terminal
```

Use `--artifact <selector>` only when the summary identifies a relevant artifact. Exact prompt/model excerpts are sensitive and should be loaded only when the task requires model-I/O diagnosis.

For a marked-bug batch, start with the permission-filtered `listDiscordBugMarkers` tool from Discord or the corresponding repository/tool implementation. Do not scrape Discord in a browser when the trace and archive paths already resolve message links.

Resolve internal implementation choices from the repository and these contracts. Ask the operator only when a missing decision changes the user-facing product, grants new authority, moves external state beyond the request, or creates meaningfully different valid outcomes.

## Build A Lifecycle Map Before Editing

For a small local bug, the nearest owner and one regression test may be enough. For a feature that crosses domains, write down the lifecycle in this order:

1. **Ingress:** What current Discord message, requester identity, mentions, reply context, attachments, and visible channels enter the request?
2. **Durable state:** Which repository is authoritative? What is the idempotency or concurrency key? How is state deleted or expired?
3. **Capability selection:** Is this model intent, deterministic routing, or both? Which tool group exposes it?
4. **Execution:** Which provider, local tool, external API, queue, or sandbox performs the work? What are the timeout and retry rules?
5. **Delivery:** How do acknowledgement, status, files, formatting, reactions, footers, and errors reach Discord?
6. **Observability:** Which typed events, spans, audits, artifacts, costs, and latencies explain the run?
7. **Recovery:** What happens after a crash, timeout, duplicate request, stale reply, partial external success, or deployment restart?
8. **Verification:** Which unit, integration, DB, E2E, and eval coverage proves the behavior?

If the proposed design cannot name these owners, it is not ready to implement.

## Sources Of Truth

Do not create parallel state because an existing read path is inconvenient.

| Concern | Canonical source | Important projection or adapter |
| --- | --- | --- |
| Chat and code-update execution | `agent_runtime_*` via `src/db/agentRuntimeRepository.ts` | `src/observability/runs.ts`, run console, task projections |
| Discord archive and attachment metadata | Discord archive repositories in `src/db/` | Retrieval/stats repositories and `src/memory/` |
| Per-channel conversation continuity | Conversation memory repository | Prompt assembly in `src/agent/promptBuilder.ts` |
| Request identity and scope | Immutable Discord turn envelope/requester scope | `ToolContext`, permission and action guards |
| Discord delivery obligations | `delivery_obligations` repository | `src/discord/responseSink.ts` and startup sweeps |
| Code-update task compatibility state | `agent_tasks` projection linked to an agent-runtime execution | Discord task notifications and task APIs |
| Wallet accounts, transfers, and wagers | Payment repository plus receipt-verified onchain state | Wallet service, payment tools, payments console |
| Chance sessions and draws | RNG repository | Non-model proof footers and verifier script |
| Private skills and server overlay | Postgres | Prompt loader and skill tools |
| Server-specific local content | `.discord-ai-agent/` | Prompt overlay, private evals, exported skills |

See [`agent-runtime.md`](agent-runtime.md), [`wallets.md`](wallets.md), and [`provable-rng.md`](provable-rng.md) before changing those high-risk areas.

## Decide What The Model And Code Should Do

Use the model when the task needs meaning: intent, relevance, tool selection, summarization, wording, formatting, or social judgment.

Use deterministic code when the answer must be verifiable: permissions, identities, balances, transfers, receipt matching, randomness, probability bounds, idempotency, current-time evidence, parser limits, message delivery, or durable transitions.

A common good pattern is:

1. code constructs a bounded, requester-safe capability and result contract;
2. the model decides whether and how to use it;
3. code validates any high-consequence action against the immutable current request;
4. the model presents the verified result conversationally;
5. code adds exact non-model footers or metadata where tamper resistance matters.

Avoid these failure modes:

- adding regex for one wording instead of improving a general intent/tool path;
- asking the model to count rows, generate randomness, remember a balance, or authorize itself;
- returning a canned user-facing block from a tool when normal synthesis can present structured evidence;
- putting a storage/indexing fix only in a tool description;
- adding a second runtime/task/history table instead of extending the canonical ledger;
- routing Discord writes around `responseSink.ts` and losing acknowledgement cleanup or retry behavior.

## Feature Recipes

### Add or change a model-facing tool

1. Read [`tool-design.md`](tool-design.md) and [`../src/tools/README.md`](../src/tools/README.md).
2. Decide whether an existing tool can gain a generic argument/result before adding another name.
3. Add registry taxonomy, group, schema, examples, permission requirements, audit events, and output contract in `src/tools/registry.ts`.
4. Implement it in the focused tool-family module, not the registry.
5. Add deployment gating or toolset scoping only when the capability is unavailable or materially costly.
6. Return compact structured evidence and explicit limitations.
7. Add schema, implementation, routing, audit, and model-loop coverage.
8. Add an eval prompt for tool choice or answer behavior.

### Change Discord knowledge or retrieval

Start at archive/persistence/repository ownership, not prompt wording. Account for create, edit, delete, reaction changes, excluded channels, privacy deletion, crawl/backfill, embeddings, current requester permissions, and query cost. Then expose the improved primitive through the existing retrieval or stats tool.

### Change response behavior or formatting

Start with the trace to distinguish bad model output from renderer behavior. General Discord style belongs in prompt guidance; exact renderer responsibilities such as message splitting, table normalization, trace/transfer/version footers, files, and reaction cleanup belong in Discord response code. Do not special-case one table or prompt.

### Add an external data provider

Prefer the general hosted web tools when they provide reliable current evidence. Add a local integration when it offers a stable capability, structured results, or authentication the general web path cannot provide. Bound time, bytes, pages, and result counts; identify freshness; classify errors; audit cost and latency; and fail honestly when data is unavailable. Never present snippets or estimates as live inventory.

### Add a file format

Extend the generic file-inspection registry. Detect by signature/container structure when possible, parse in memory without executing content, bound downloads and extraction, deduplicate batch evidence, and describe opaque fields honestly. Use official exports or SDK representations for exact proprietary values rather than reverse-engineering claims the evidence cannot support.

### Change wallets, transfers, or games

Read [`wallets.md`](wallets.md) and [`provable-rng.md`](provable-rng.md). Preserve requester scoping, current-turn mutation intent, live balances, bot fee sponsorship, managed destinations, reservations, receipt verification, reconciliation, exposure limits, provable entropy, durable continuation ownership, and exactly-once settlement. Add DB-backed concurrency/idempotency coverage, not only mocked unit tests.

### Change the run console or tracing

Define or extend typed runtime events first. Put reusable normalization and diagnostics in `src/observability/`; keep React focused on rendering. Show observed model I/O, tools, events, latency, cost, cache use, and artifacts without claiming private chain-of-thought. Add pure-helper unit tests and Playwright coverage for important workflows.

### Change code-update tasks

Read [`agent-runtime.md`](agent-runtime.md) and [`../src/execution/README.md`](../src/execution/README.md). Keep chat in-process and sandboxes limited to repository changes. Prefer better ownership docs, exact request anchors, context packaging, cache behavior, progress, and failure diagnosis before changing harnesses. A task must end with a PR or a clear terminal reason.

## Database And Migration Rules

- New schema changes are forward-only numbered migrations. Do not edit a released migration to change production state.
- Update the migration-upgrade fixture/test when the previous released schema must be proven upgradeable.
- Put a query in the focused repository that owns the lifecycle; keep `src/db/repositories.ts` as a compatibility facade.
- Serialize competing mutations with transactions, row locks, advisory locks, unique constraints, or idempotency keys appropriate to the invariant.
- Test cleanup and privacy deletion alongside creation when the state is derived from Discord content.
- Run `npm run verify:db` before publishing DB-backed changes.

Fresh installs currently use the squashed baseline plus later forward migrations. Older pre-squash installs use the documented one-time legacy transition; do not assume every deployed database was created from the latest baseline.

## Observability Requirements

Use typed runtime events from `src/observability/runtimeEventSchema.ts` for important lifecycle facts. Prefer one event that answers a debugging question over several noisy status duplicates.

Record, where relevant:

- operation and stable outcome/error code;
- trace, execution, span, parent-span, requester, and Discord message correlation;
- provider/model/tool name and purpose;
- latency, token/cache use, estimated cost, byte/row/result counts;
- retry or fallback reason;
- external status without secret-bearing payloads;
- durable state transition or delivery outcome.

Large or sensitive debug payloads belong in redacted artifacts with retention, not event metadata. User-facing traces should link to the authenticated console when configured.

## Testing Matrix

Choose coverage by behavior, not file type.

| Change | Minimum focused coverage | Broader command |
| --- | --- | --- |
| Pure helper, formatting, parser | Unit test beside the owning domain | `npm run verify` |
| Tool schema or routing | Registry/unit test plus agent integration case | `npm run verify` |
| Prompt/tool-choice behavior | Agent integration test and eval schema/case | `npm run eval -- --dry-run` |
| Repository or migration | DB integration and upgrade test where relevant | `npm run verify:db` |
| Wallet/RNG concurrency or idempotency | Unit plus DB-backed invariant test | `npm run verify:db` |
| Discord delivery lifecycle | Response-sink/API/delivery unit test | `npm run verify` |
| Run-console interaction | Pure projection test plus Playwright | `npm run build && npm run test:e2e` |
| Deployment/Helm/Terraform | Render/lint/validate the changed layer | CI production checks |
| Documentation links | `npm run docs:check` | `npm run verify` |

`npm run verify` runs lint, typecheck, unit/integration tests that do not require the DB flag, a critical-level production dependency audit, documentation checks, and the release scanner. CI additionally runs coverage, changed-file coverage, production build, Playwright, Helm, Terraform, DB coverage, CodeQL, and container security.

Live evals can call providers and use configured private data. Run them only when that is intended; keep server-specific cases under `.discord-ai-agent/evals`.

## Debugging Order

For a Discord link or “what happened here” report:

1. Run `npm run runs:inspect -- <link> --terminal` or use `inspectAgentLogs` from a Discord reply.
2. Identify whether the failure was ingress/context, tool scope, model selection, tool execution, guard rejection, synthesis, timeout, or Discord delivery.
3. Inspect exact model I/O only if aggregate evidence cannot answer the question.
4. Check durable state directly for wallet, RNG, queue, task, or delivery issues; chat text is not authoritative state.
5. Add a regression test at the earliest layer that should have prevented the failure.
6. Fix the general contract or invariant, then rerun the original scenario or private eval.

For CI, use the failed check logs and reproduce the exact command locally. For deployments, distinguish merge, image build, migration, rollout, readiness, and patch-note posting rather than treating “deployed” as one state.

## Documentation And PR Handoff

Update documentation when a change alters product behavior, a source of truth, ownership, an operator command, a permission boundary, or an invariant. Put the fact in one canonical place and link to it instead of duplicating long explanations.

Before opening a PR:

1. Review `git diff` for accidental private content and unrelated changes.
2. Run the focused tests, then the proportional broad checks.
3. Run `git diff --check` and `npm run docs:check`.
4. Summarize user-visible behavior, architecture decisions, risks, migration/rollout needs, and exact verification.
5. Open a non-draft PR when the change is ready for review.
6. Do not merge or deploy unless the operator explicitly asks.

Inside a sandboxed Discord code-update task, the execution runner owns commit, push, and PR creation. The coding harness should leave a tested worktree and report what changed; it must not publish independently.
