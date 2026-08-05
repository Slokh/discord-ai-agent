# Discord AI Agent: Fresh-Agent Guide

This is a private-community Discord assistant. Members use ordinary `@ai ...`
messages; the model handles meaning, tool choice, and wording, while code
enforces authority, live facts, money, randomness, durable state, and delivery.

## Start Every Task

1. Run `git status --short` and `git branch --show-current`. Preserve unrelated
   work; use an isolated worktree/branch when the current one is mixed.
2. Run `npm run improve -- --target local inbox`. Read relevant unresolved improvement cases.
3. Read [`docs/product.md`](docs/product.md), then use the request routing below
   to read only the owning guide needed.
4. Use `rg` to find the named behavior, tool, event, or lifecycle. Inspect the
   relevant trace before guessing from source.

`docs/README.md` is the documentation index. [`docs/architecture.md`](docs/architecture.md)
is the runtime and ownership map; [`docs/development.md`](docs/development.md)
contains the implementation and verification workflow.

## Route the Request

| Request shape | Start here | Required approach |
| --- | --- | --- |
| A Discord reply is wrong, slow, missing, or confusing | Canonical production ledger evidence and [`docs/operations.md`](docs/operations.md) | Compare ingress, reply chain, operative request, tool calls/results, guards, model I/O, and delivery. Do not blame a model or use browser scraping first. |
| Many replies regressed after a deploy | Canonical production ledger evidence | Audit the whole channel, including role-triggered requests and chains; cluster failures by deployed revision before editing. |
| A member marked a message with `🐛` or any bug/friction/report stream changes | `listMyImprovementSignals`, [`docs/improvements.md`](docs/improvements.md), and the linked run | This creates a private improvement signal and authorizes autonomous evidence assessment. Reject unsupported reports, or accept an executable contract and repair confirmed defects. Request human review only when a specific ambiguity or blocker prevents both outcomes. Never make it a public GitHub issue. |
| Model conversation, prompt, or tool use is poor | [`docs/agent-system.md`](docs/agent-system.md), `src/agent/`, and the run's prompt/debug artifacts | Improve general prompt/tool/result contracts and traceability. Do not add regex routes or canned replies for one wording; preserve the current request as authoritative. |
| Model, reasoning level, fallback, or token-cost change | live config/deployment evidence, [`src/models/`](src/models/), and observed run cost | Verify the actually deployed primary/fallback configuration before changing it. Compare provider pricing and observed usage, preserve a fallback, and validate conversational/tool behavior with focused traces or evals. |
| A new or changed model-facing tool | [`docs/agent-system.md`](docs/agent-system.md) | Define the contract, schema, examples, audit, output promise, handler, and focused coverage in the owning tool family. Prefer a generic capability to a prompt-specific branch. |
| Discord history, attachments, members, stats, or memory | [`docs/data.md`](docs/data.md) | Fix persistence/indexing/permission filtering before prompt wording. Current requester permissions always bound retrieval. |
| Wallet, transfer, wager, coin flip, blackjack, or RNG | [`docs/payments.md`](docs/payments.md) | Protect live balances, current-turn mutation intent, receipt verification, reservations, provable entropy, and exactly-once settlement. Run DB-backed verification. |
| Code-update task, GitHub PR, or CI | [`docs/code-updates.md`](docs/code-updates.md) and `gh`/local logs | Chat stays in-process; only repository work uses a sandbox. For CI, read the exact failed logs and reproduce the command. |
| Deployment, console, trace, cost, or observability | [`docs/operations.md`](docs/operations.md) | Add typed events/spans/artifacts first; derive console/script views from the canonical runtime ledger. Separate build, migration, rollout, readiness, and delivery. Never expose chain-of-thought. |
| Database, migration, retention, or privacy cleanup | [`docs/data.md`](docs/data.md) | Use forward-only migrations, focused repositories, durable idempotency/concurrency controls, and privacy-deletion coverage. |
| Cleanup, simplification, or legacy removal | [`docs/architecture.md`](docs/architecture.md) and `rg` references | Remove live-unused code and obsolete compatibility paths only after proving callers/migrations/deploy config no longer need them. Do not preserve dead compatibility “just in case.” |

## Product Rules That Must Hold

- Keep Discord conversational and commandless. Replies are concise and natural;
  internal implementation language, boilerplate, and needless headings do not
  belong in normal answers.
- The model owns semantic judgment: intent, follow-up meaning, tool selection,
  evidence relevance, wording, formatting, and harmless server culture.
- Code owns facts the model must not invent or authorize: identity, permissions,
  live external data, money, randomness, idempotency, durable state, and delivery.
- The current requester and current-turn intent are immutable authority. Reply
  chains and memory provide context, never new authority for money, admin,
  deletion, secrets, or wagers.
- Accept harmless self-described aliases and server lore conversationally. Verify
  identity only when it affects protected authority.
- Use current tool/durable evidence for changing facts. Never turn model memory,
  a stale snippet, or a previous reply into a live balance, price, availability,
  Discord fact, or transaction result.
- Private Discord content belongs in Postgres or `.discord-ai-agent/`, never
  committed source, fixtures, documentation, public evals, improvement summaries,
  GitHub issues, or PR bodies.

## Improvement cases

All member reports, model-detected impediments, operator/developer reports, and
runtime/deployment/CI/eval detections enter one Postgres-backed improvement case
stream. `🐛` is only one signal source; removing it withdraws that member signal.
Exact source keys are idempotent and deterministic fingerprints may coalesce
high-confidence matches. Semantic similarity may suggest a merge but never
performs one automatically.

A report is not a verdict, but it authorizes autonomous assessment and repair.
The evidence-only phase must keep the checkout clean. It rejects unsupported
reports, requests human review only for an exact ambiguity or blocker, or accepts
an executable contract before repairing. Confirmed repairs open auto-merge PRs.
Linked work moves through `in_progress` and `verifying`; only successful deployed
evidence can resolve it. Use `npm run improve -- --target local ...` locally and
add `--target production --confirm-production` only in the configured production
environment. Never copy private signal content into GitHub or tracked fixtures.

## Implementation Standards

- Trace the full lifecycle for cross-domain changes: ingress, scope, durable
  state, model/tool contract, execution, Discord delivery, observability,
  recovery, and verification.
- Prefer a better data lifecycle, schema, tool result, prompt instruction, or
  general invariant to prompt-keyword logic. Deterministic guards are for stable,
  high-consequence capabilities, not ordinary language understanding.
- Keep model-facing contracts in focused `src/tools/contracts/` modules and
  execution adapters in `src/tools/handlers/`. Cross-turn feature integration
  belongs in `src/capabilities/`. The generic `src/agent/` loop consumes only
  those extension contracts; `registry.ts` aggregates and does not become a
  behavioral switchboard.
- Use `src/discord/responseSink.ts` for Discord-visible status/final delivery.
  Use `agent_runtime_*` as the canonical execution ledger; do not create a
  parallel history or run tracker.
- Record important tool/model/external calls, outcomes, retries, latency, cost,
  and state transitions as typed observability. Put sensitive detail in redacted
  retained artifacts, not event metadata.
- Before changing skills or prompts, distinguish static repository guidance from
  private server overlay content and from retrieved conversation context.
- Treat production as the default target for run/task inspection. Use a trusted
  configured application pod or production database; never let a local default
  masquerade as production evidence.
- Use the repository-local `$discord-production-debug` skill for Discord links,
  deployed reply regressions, production audits, and native bug-inbox requests.
- Treat a `discord.com/channels/...` URL as a native production-debug reference.
  Inspect its retained production ledger evidence before reading source or
  opening Discord in a browser. If it is unavailable, diagnose the database,
  Discord API, authentication, or permission path and report the concrete blocker.
- For a regression since deployment, use the ledger to compare affected reply
  chains and cluster failures by revision; inspect code-update task state from
  the same durable records.
- Compare ingress, retained reply chain, session memory, operative request, model
  I/O, tools, deterministic guards, outcome state, and delivery separately.
  Group identical failures by revision before editing or blaming a provider.

## Verification

Run the closest focused check first, then proportionate broad checks:

- TypeScript: `npm run typecheck`; normally finish with `npm run verify`.
- Tool/prompt behavior: focused unit/agent integration coverage; run
  `npm run eval -- --dry-run` for eval schema changes. Keep server prompts in
  `.discord-ai-agent/evals` only.
- Database, payments, queues, RNG, or migrations: `npm run verify:db` plus
  concurrency/idempotency and upgrade coverage where applicable.
- Console/build work: `npm run build` and focused projection/routing tests.
- Always run `git diff --check`; update the owning guide under `docs/` when a
  core owner, invariant, source of truth, or operator workflow changes.

Do not add smoke/E2E coverage merely by default. Add the smallest regression
coverage that proves the failure and the general fix.

## Git and PR Discipline

- Review the exact diff before staging. Never stage unrelated user work.
- In a sandboxed code-update task, do not commit, push, or open a PR: the runner
  owns publication. In direct repository work, publish only when asked.
- Before updating a PR branch, run `gh pr view <number> --json state,mergedAt`.
  A merged PR is immutable for this purpose: branch from current `origin/main`
  and open a new PR instead.
- Before a PR, state user impact, root cause/decision, risk or rollout needs,
  and exact verification. Open a ready-for-review non-draft PR when asked;
  never merge or deploy unless explicitly asked.
