# Development

This guide is the working method for humans and coding agents. `AGENTS.md` contains mandatory repository-specific rules; this file explains how to investigate, implement, verify, and hand off a change.

## Start with evidence

At the beginning of a task:

```bash
git status --short
git branch --show-current
npx frog list
```

Preserve unrelated work. Read [Product](product.md), [Architecture](architecture.md), and only the domain guide that owns the request. Use `rg` to find the named behavior, contract, event, or lifecycle. For production behavior, inspect the retained run before reasoning from source.

Frog records repository-development friction. Discord `🐛` markers are the private product bug inbox. Do not move private Discord evidence between them.

## Find the owner

Map the observed failure to one owner before editing:

| Observation | Start with |
| --- | --- |
| Wrong/missing Discord reply | `npm run discord:debug -- <link>`, then Discord ingress, agent execution, and delivery evidence |
| Broad post-deploy regression | `npm run discord:audit -- --channel <id> --since-deploy --include-reply-chains` |
| Wrong tool or response behavior | [Agent system](agent-system.md), contract, handler, prompt artifact, and closest test |
| Missing/stale Discord knowledge | [Data](data.md), persistence/indexing/retrieval before prompt text |
| Wallet, wager, or random result | [Payments and games](payments.md), durable ledger and provider/RNG evidence |
| Code-update/PR/CI problem | [Code updates](code-updates.md), exact task or CI logs |
| Deployment or console problem | [Operations](operations.md), deployed revision and typed events |

Follow the full lifecycle for cross-domain work: ingress, authority, durable state, model/tool contract, external side effect, delivery, observability, recovery, and verification.

## First-principles change rules

- Prefer better schemas, typed outcomes, data ownership, prompt instructions, and lifecycle invariants to prompt-keyword logic.
- Let the model decide semantics and presentation. Use deterministic code for permission, identity, live fact, money, randomness, mutation, state, and delivery guarantees.
- Preserve the current request as authoritative; context cannot expand authority.
- Remove dead compatibility once callers, migrations, and deployed configuration no longer need it.
- Add a capability to the narrowest durable owner. The capability catalog installs it; aggregators such as `registry.ts` and `repositories.ts` remain projections rather than behavior owners.
- Record important transitions once in the canonical runtime ledger and derive views from it.
- After a mutation commits, return its durable result even if a secondary step fails.
- Keep private community content out of tracked source, tests, evals, docs, Frog, and GitHub metadata.

## Model-facing tools

Before adding a new tool, confirm that an existing primitive cannot satisfy the request with a clearer contract or result. For a new or changed tool:

1. Define the canonical schema and examples in the owning `src/tools/contracts/` family and assign its name to the appropriate capability group in `toolDefinition.ts`.
2. Declare deployment requirements, access policy, mutation status, output promise, and audit events.
3. Bind a focused handler under `src/tools/handlers/` and add that handler family to `src/capabilities/catalog.ts`.
4. Validate permission and authority at execution time.
5. Return a typed `AgentResponse`, including partial/error metadata where appropriate.
6. Add contract, handler-conformance, and focused behavior coverage.
7. Add or update an eval only when model selection or wording is the behavior under test.

Do not create a natural-language router, hidden tool list, mid-turn expansion protocol, or regex response guard.

If a feature needs prompt context, model selection, result observation, or a final-response invariant outside its tool call, add one focused module under `src/capabilities/` and register it in the capability composition root. Do not import that feature into the generic files under `src/agent/`. The architecture test enforces this separation.

## Tests and checks

Run the closest test first. Examples:

```bash
npm test -- tests/unit/nanocodex-agent-runtime.test.ts
npm test -- tests/unit/tool-contract-validation.test.ts
npm test -- tests/unit/discord-response-sink.test.ts
```

Then use the proportionate broad checks:

| Change | Required checks |
| --- | --- |
| TypeScript behavior | focused tests, `npm run typecheck`, normally `npm run verify` |
| Prompt/tool/eval | focused agent tests, `npm run eval -- --dry-run` |
| Database/queue/payment/RNG/migration | focused tests, `npm run verify:db` |
| Console/build | focused UI/API tests, `npm run build` |
| Documentation | `npm run docs:check` |
| Any publishable change | `git diff --check`, `npm run scan:release` (also included in verify) |

`npm run verify` runs lint, typecheck, unit/integration tests that do not require the DB gate, critical production dependency audit, docs links, and release scanning. `npm run verify:db` migrates the test database and runs DB integration suites.

Do not add smoke or end-to-end coverage by reflex. Use it when the changed boundary cannot be proven below that level and external credentials/mutations are intentionally in scope.

## Evals

Committed suites live under `evals/prompts/` and must remain generic. Private server cases live under `.discord-ai-agent/evals/`.

```bash
npm run eval -- --dry-run
npm run eval
npm run eval -- --include-private
npm run eval:regressions
```

Dry-run validates every registered eval definition without provider calls. Live evals use configured model/database capabilities and may incur cost. `eval:regressions` exports reviewed, capture-enabled run feedback into the private eval directory and runs the complete private suite. A captured case without a machine-grade assertion is skipped until a reviewer adds expected/forbidden tools or required/forbidden answer text in the run console. Keep assertions about observable behavior; do not encode one server member, channel, message link, or private prompt in committed evals.

Use an eval failure to choose the correct owner: tool selection, schema, result quality, retrieval, prompt context, code-update context, or lifecycle. Do not make the eval pass with an exact-phrase branch.

## Database changes

- Add a numbered forward migration.
- Test both fresh migration and upgrade from prior supported state.
- Put lifecycle methods in the focused repository owner.
- Use database constraints/transactions for idempotency and concurrency.
- Cover deletion and retention when new private or derived data is introduced.
- Never edit production state manually as a substitute for a migration or repair path.

## Documentation changes

Update documentation when a source of truth, trust boundary, lifecycle, deployment step, or operator workflow changes. Put the explanation in the single owning guide under `docs/`; do not add a tiny source-folder README or historical implementation plan. Remove obsolete instructions rather than labeling them “legacy.”

Keep `README.md` focused on evaluating and starting the project, `AGENTS.md` focused on task routing and non-negotiable rules, and the generated `.env.example` synchronized with `src/config/environment.ts` through `npm run config:check`.

## Git and PR handoff

Review the exact diff and preserve unrelated work. Before updating an existing PR, verify its state; never append to a merged PR. A PR description should state:

- user impact;
- root cause or architectural decision;
- risk and rollout considerations;
- exact verification performed.

Titles describe the actual change, not task IDs, validation metadata, or the tool that produced it. Keep private Discord content out of commits and PRs. Merge and deploy only when explicitly requested.
