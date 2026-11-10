# Development

This guide is the working method for humans and coding agents. `AGENTS.md` holds the mandatory repository rules; this file explains how to investigate, implement, verify, and hand off a change.

## Start with evidence

```bash
git status --short
git branch --show-current
```

Preserve unrelated work. Read [Product](product.md), [Architecture](architecture.md), and only the guide that owns the request. Use `rg` to find the named behavior, contract, event, or lifecycle. For production behavior, inspect the retained run before reasoning from source.

## Find the owner

| Observation | Start with |
| --- | --- |
| Wrong or missing Discord reply | Production ledger evidence for ingress, agent execution, and delivery ([Operations](operations.md#debug-a-discord-result)) |
| Broad post-deploy regression | Production ledger evidence grouped by deployed revision |
| Wrong tool or response behavior | [Agent system](agent-system.md), the contract, handler, prompt artifact, and closest test |
| Session, steering, or host problem | [Agent system](agent-system.md#sessions), `src/agent/nanocodeHost.ts`, `native/nanocodex-runtime/` |
| Missing or stale Discord knowledge | [Data](data.md): persistence, indexing, retrieval before prompt text |
| Wallet, wager, or random result | [Payments and games](payments.md): durable ledger and provider or RNG evidence |
| CI failure | The exact failed job log, reproduced locally |
| Deployment problem | [Operations](operations.md), deployed revision, and typed events |

Follow the full lifecycle for cross-domain work: ingress, authority, durable state, model and tool contract, external side effect, delivery, observability, recovery, and verification.

## Change rules

- Prefer better schemas, typed outcomes, data ownership, prompt instructions, and lifecycle invariants to prompt-keyword logic.
- Let the model decide semantics and presentation. Use deterministic code for permission, identity, live fact, money, randomness, mutation, state, and delivery guarantees.
- Preserve the current request as authoritative; context cannot expand authority.
- Remove dead compatibility once callers, migrations, and deployed configuration no longer need it.
- Add a capability to the narrowest durable owner. The capability catalog installs it; aggregators such as `registry.ts` and `repositories.ts` stay projections.
- Read deployment configuration through `AppConfig`. Direct `process.env` access belongs only in `src/config/`; the architecture test enforces it.
- Record important transitions once in the runtime ledger and derive views from it.
- After a mutation commits, return its durable result even if a secondary step fails.
- Keep private community content out of tracked source, tests, public evals, and GitHub metadata.

## Model-facing tools

Before adding a tool, confirm that an existing primitive cannot satisfy the request with a clearer contract or result. A capability is an installation record, not a new agent subsystem:

1. Add the tool name to one capability in `TOOL_NAMES_BY_CAPABILITY` (`src/tools/toolDefinition.ts`), and to `MUTATING_TOOL_NAMES` if it mutates.
2. Put its schema, examples, availability predicate, access policy, mutation flag, and output promise in the closest `src/tools/contracts/` family.
3. Put execution in the matching `src/tools/handlers/` family. The handler revalidates requester scope and returns a typed `AgentResponse`.
4. Declare the capability once with `defineCapability` in `src/capabilities/catalog.ts`. Add `prepareTurn` only when the feature needs per-turn prompt context.
5. Add contract-validation, catalog, and focused behavior coverage. The catalog rejects missing, unknown, and duplicate contracts and handlers, and empty summaries.
6. Measure model selection and wording with evals.

```ts
defineCapability({
  id: "existingCapabilityId",
  summary: "One sentence describing the installed product boundary.",
  toolNames: TOOL_NAMES_BY_CAPABILITY.existingCapabilityId,
});
```

Do not add feature imports to `src/agent/`, a feature-name switch to `registry.ts`, a hidden tool list, a natural-language router, a regex response guard, a separate runtime ledger, or an environment flag for behavior that can be versioned in source.

Changing instructions, a tool description or schema, or the chat model changes the session contract hash, so every requester starts a fresh nanocode session after the deploy.

## The native runtime

`native/nanocodex-runtime/` builds exactly what nanocode builds. Its `Cargo.toml` pins `nanocode` and `nanocode-backend-codex` to one nanocode rev, uses the same version requirements as nanocode's workspace, and mirrors nanocode's `[patch.crates-io]` entries at that rev; `Cargo.lock` is seeded from nanocode's lockfile. To move to a newer nanocode:

1. Read nanocode's `DECISIONS.md` diff between the current and target revs.
2. Update the rev everywhere in `Cargo.toml`, match any changed version requirements, and reseed `Cargo.lock` from nanocode's lockfile at the target rev.
3. Commit the bump on its own.

Check it with:

```bash
cargo fmt --check --manifest-path native/nanocodex-runtime/Cargo.toml
cargo clippy --locked --all-targets --manifest-path native/nanocodex-runtime/Cargo.toml -- -D warnings
cargo test --locked --manifest-path native/nanocodex-runtime/Cargo.toml
cargo build --locked --manifest-path native/nanocodex-runtime/Cargo.toml
npx vitest run tests/native
```

`tests/native` drives the debug binary against a fake Responses server (`tests/support/fakeResponsesServer.ts`): parallel tools, session continuity, images, bootstrap, steering, cancellation, durable restart and replay, and deletion with shared records. Set `NANOCODE_TEST_DATABASE_URL` for the Postgres cases and `NANOCODE_HOST_BINARY` to test another build. The suites skip when the binary is missing.

## Tests and checks

Run the closest test first:

```bash
npm test -- tests/unit/nanocodex-agent-runtime.test.ts
npm test -- tests/unit/tool-contract-validation.test.ts
npm test -- tests/unit/discord-response-sink.test.ts
```

Then the proportionate broad checks:

| Change | Required checks |
| --- | --- |
| TypeScript behavior | focused tests, `npm run typecheck`, normally `npm run verify` |
| Prompt, tool, or model | focused agent tests, `npm run eval -- --repeat 3`, `npm run eval:replay` when replays exist |
| Eval cases or runner | `npm run eval -- --dry-run`, `tests/unit/eval-runner.test.ts` |
| Native runtime | the cargo checks and `npx vitest run tests/native` above |
| Database, queue, payment, RNG, or migration | focused tests, `npm run verify:db` |
| Console or build | focused UI and API tests, `npm run build` |
| Documentation | `npm run docs:check` |
| Any publishable change | `git diff --check`, `npm run scan:release` (also in `verify`) |

`npm run verify` runs lint, typecheck, the tests that do not need the DB gate, a critical production dependency audit, docs links, generated-config checks, and release scanning. `npm run verify:db` migrates the test database and runs the DB integration suites. Each integration-test file gets its own migrated schema through `tests/integration/testDatabase.ts`, so files run in parallel.

Architecture tests cap source files at 752 lines and test files at 3,300. When a coordinator approaches its budget, extract a cohesive mechanic with its own contract instead of raising the limit.

Do not add smoke or end-to-end coverage by reflex. Use it when the changed boundary cannot be proven below that level.

## Evals

An eval case is a prompt plus checks (`scripts/eval.ts`). Code graders run first: `expectedTools`, `forbiddenTools`, `expectedRequestedTools`, `mustContain`, `mustNotContain`, `expectedRuntimeEvents`, `forbiddenRuntimeEvents`, `maxAnswerWords`, `maxLatencyMs`, and `auditMustNotMatch`. A case may add a `rubric`, and optionally a `referenceAnswer`, for qualities code cannot check; a judge model (`scripts/evalJudge.ts`) grades it only after the code checks pass.

```bash
npm run eval -- --dry-run                 # validate every suite without provider calls
npm run eval -- --repeat 3                # run the public suite three times; report pass@1 and pass^3
npm run eval -- --repeat 3 --compare <earlier-report.json>
npm run eval:export-replays -- --days 7   # write private production replays
npm run eval:replay                       # run the private replays three times
```

- `evals/prompts/core.json` is the public suite. It must stay generic: no server member, channel, message link, or private prompt.
- pass@1 is the mean per-case pass rate; pass^k is the share of cases that passed every run. A comparison counts a case as regressed when any run fails.
- `npm run eval:export-replays` turns recent successful production turns into replay cases under `.discord-ai-agent/evals/` (owner-only permissions; the script refuses any other path). Each replays the turn's retained envelope in its original scope, read-only, and is judged against the reply that was delivered. Replays contain member content and are never committed.
- `.github/workflows/agent-evals.yml` runs the public suite three times at a PR's base and head against a seeded synthetic guild (`scripts/seedEvalGuild.ts`) when a PR touching prompts, tools, skills, or the runtime carries the `evals` label, and fails when pass@1 drops by more than 5 points. It needs the `OPENROUTER_API_KEY` repository secret.

Use a failing eval to find the owner: tool selection, schema, result quality, retrieval, prompt context, or lifecycle. Never make an eval pass with an exact-phrase branch or a prompt line that exists only for one case.

## Database changes

- Add a numbered forward migration.
- Test both a fresh install and an upgrade from prior state.
- Put lifecycle methods in the focused repository owner.
- Use database constraints and transactions for idempotency and concurrency.
- Cover privacy deletion and retention when new private or derived data is introduced.
- Never edit production state by hand as a substitute for a migration or repair path.

## Documentation changes

Docs say only what code can't: one file per topic, present tense, no history. Update the owning guide under `docs/` when a source of truth, trust boundary, lifecycle, deployment step, or operator workflow changes, and delete instructions for removed behavior. Do not add a source-folder README or an implementation plan.

Keep `README.md` focused on evaluating and starting the project, `AGENTS.md` on task routing and non-negotiable rules, and the generated `.env.example` and `docs/configuration.md` synchronized with `src/config/environment.ts` through `npm run config:check`.

## Git and PR handoff

Review the exact diff and preserve unrelated work. Before updating an existing PR, check its state; never append to a merged PR. A PR description states user impact, root cause or decision, risk and rollout considerations, and the exact verification performed.

Titles describe the change, not task IDs or the tool that produced it. Keep private Discord content out of commits and PRs. Merge and deploy only when explicitly asked.
