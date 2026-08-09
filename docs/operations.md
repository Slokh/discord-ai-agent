# Operations

This guide covers installation, configuration, process roles, indexing, observability, production debugging, deployment, and recovery.

## Requirements

- Node.js 22+
- Postgres with pgvector
- Discord application and bot token
- OpenRouter API key

GitHub credentials and a task-signing secret are optional unless code-update PRs are enabled. Privy credentials are optional unless wallets are enabled. Spotify credentials are optional and only expose Spotify tools when complete.

## Local setup

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run migrate
npm run preflight
```

Set at least `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `OPENROUTER_API_KEY`, and `DATABASE_URL`. The example database URL uses the Compose Postgres on local port 5433.

Generate the least-privilege Discord invite:

```bash
npm run invite-url
```

The generated role includes Create Public Threads and Send Messages in Threads so `🐛` reports can keep their visible follow-up beside the reported message. Existing installations may need to re-authorize the generated invite or grant those permissions to the bot role; delivery falls back to DM when either permission is unavailable.

For a minimal split runtime, start the bot and chat worker in separate terminals:

```bash
npm run dev
```

```bash
npm run worker
```

The bot handles gateway ingress and delivery. The worker executes queued chat requests. Start `npm run api` only to receive signed callbacks from isolated code-update sandboxes. `npm run start:all` is intended only for a fully configured built environment.

Start the read-only operator dashboard against local data only when intentionally working on its data projection or fixtures:

```bash
npm run console:local
```

It listens on port 8081 and needs only the database. Its overview includes bounded private prompt previews, so treat it as an operator surface rather than a public application endpoint.

## Configuration ownership

`.env.example` and [Configuration](configuration.md) are generated from the accepted manifest in `src/config/environment.ts`. `src/config/env.ts` separates those deployment inputs from versioned `productConfig`. Environment variables are reserved for credentials, private Discord identity/policy, release metadata, Kubernetes namespace, and the immutable sandbox image. Model choices, limits, repository target, queue topology, callback URL, and payment rail change through reviewed source. Production startup rejects retired variables; run `npm run config:check` whenever the manifest changes.

Important feature gates:

| Capability | Required configuration |
| --- | --- |
| Chat | Discord token/client/guild, OpenRouter key, database |
| Code updates | GitHub PAT or App credentials, task-signing secret, worker, and internal callback receiver |
| Spotify | Client ID and client secret |
| Wallets, transfers, and wagers | Both Privy credentials |

Administrative mutations use `BOT_OWNER_USER_ID` and `OPS_ALLOWLIST_USER_IDS`. Code-update requests remain available to members when the feature is deployed.

## Indexing and memory

The gateway stores live message changes. Run an initial or repair crawl for historical coverage:

```bash
npm run crawl
npm run embeddings:backfill
```

The worker drains embedding jobs. Use `npm run reindex` only when cursors must be reset and the guild intentionally recrawled. Lexical search is available before embeddings complete.

Useful maintenance scripts include `aliases`, `blocked-users`, `embeddings:reprioritize`, and the retention/reconciliation work built into the worker. Run scripts against production only through their explicit production-aware path; do not point local experiments at the production database accidentally.

## Production-first inspection

The runtime ledger is canonical Postgres data, not an HTTP operator API. Investigate it only from a trusted, configured application pod or an explicitly selected production database; never fall back to a local default while diagnosing production behavior.

`release:status` remains the deployment-health command:

```bash
npm run release:status -- --pr <number>
```

Improvement cases are the single operator stream for member reports, model-detected impediments, developer friction, and automated runtime/deployment/CI/eval detections:

```bash
npm run improve -- --target local inbox
npm run improve -- --target local health --hours 720
npm run improve -- --target local show <case-id>
npm run improve -- --target local triage <case-id>
npm run improve -- --target local verify <case-id> --revision <sha>
npm run improve -- --target local verify <case-id> --revision <sha> --apply
npm run improve -- --target local reconcile
npm run improve:watchdog
npm run improve -- --target local suggest <case-id>
npm run improve -- --target local evidence <case-id> --kind runtime_trace --disposition supports --summary "..."
npm run improve -- --target local contract <case-id> --expected "..." --check '{"kind":"test","reference":"release-verify"}'
```

Production access is explicit and requires confirmation. The production image omits npm, so use the compiled CLI in a configured pod:

```bash
kubectl -n discord-ai-agent exec deploy/discord-ai-agent-worker -- node dist/scripts/improve.js --target production --confirm-production inbox
kubectl -n discord-ai-agent exec deploy/discord-ai-agent-worker -- node dist/scripts/improve.js --target production --confirm-production health --hours 720
kubectl -n discord-ai-agent exec deploy/discord-ai-agent-worker -- node dist/scripts/improve.js --target production --confirm-production show <case-id>
kubectl -n discord-ai-agent exec deploy/discord-ai-agent-worker -- node dist/scripts/improve.js --target production --confirm-production triage <case-id>
kubectl -n discord-ai-agent exec deploy/discord-ai-agent-worker -- node dist/scripts/improve.js --target production --confirm-production reconcile
kubectl -n discord-ai-agent exec deploy/discord-ai-agent-worker -- node dist/scripts/improvementWatchdog.js --revision <sha> --record-detection --enforce
kubectl -n discord-ai-agent exec deploy/discord-ai-agent-worker -- node dist/scripts/improve.js --target production --confirm-production verify <case-id> --revision <sha> --apply
```

The API role is an internal-only signed callback receiver. It exposes only `/healthz` and task-scoped callback writes from isolated code-update sandboxes; it has no operator reads, metrics, browser UI, public service, or password configuration.

The Console deployment has a two-minute Kubernetes startup-probe budget before liveness enforcement begins, so normal cold projection initialization does not create a restart loop. Message activity uses durable Discord delivery obligations and recent non-background, non-synthetic member execution traces to identify agent interactions—direct mentions, role mentions, and replies—without depending on local bot configuration. An agent source message belongs only to its Prompt or Reply story, whose overview title uses the retained raw Discord content with known mention labels resolved. Background embedding sessions may share a message trace ID but never take Activity ownership; those messages remain standalone Message stories.

Activity type filtering is an accessible multi-select. The default relevant set includes prompts and replies, improvements, and code changes; messages, releases, and system activity are opt-in. Custom non-empty selections persist through the `types` query parameter and apply to status counts and keyboard traversal as one view.

`npm run console:health -- --revision <sha> --internal-url <url>` is the reusable content-free health contract. From the Console pod it checks only the loopback overview and activity resources, requires production schema markers, the exact deployed revision, a projection timestamp no older than two minutes, and a sampled lazy detail when activity exists. When the public AWS service is enabled, the deployment runner separately requires a healthy public probe, a page redirect into Discord login, and an unauthenticated API rejection; the external check must not hairpin through the NLB from a target pod. The runner retries the bounded public checks long enough for recursive DNS to converge after an initial load-balancer replacement. Normal checks use an eight-second timeout and a four-second latency budget. Release verification retries both boundaries as one `console_health` stage before promotion; repeated failure rolls back and creates the normal post-deploy detection.

The fifteen-minute production-observation job runs the same check and records a `console_health` proof-producer receipt through the worker's write-capable database identity. The Console pod performs only reads. Two consecutive failures, a stuck run, or a missed hourly freshness budget creates one content-free improvement case through reconciliation; a later successful receipt proves recovery. The top-bar producer summary therefore distinguishes Console route/projection health from pod heartbeats without adding a parallel status store.

Console issue identity is derived only from durable links. Improvement cases sharing a source execution are projected as one issue; linked failed executions and repository tasks are folded into its evidence, and lazy detail reads the timelines for every case in that group. Repository tasks form logical stories rather than one row per attempt: case-linked work groups by exact case ID and direct retries group by their durable retry root. Unlinked failures remain separate, so the projection never guesses from titles or semantic similarity. Terminal tasks older than the unified improvement migration and lacking a case link are retained as historical ledger evidence but omitted from Console Activity; standalone repository work created after that cutover remains visible.

The separate Console role leaves only `/healthz` unauthenticated for Kubernetes and load-balancer probes. Production pages, same-origin assets, `/api/overview`, cursor-paginated `/api/activity`, and lazy `/api/activity/<kind>/<story-id>` details require a signed Console session; `/auth/login` and `/auth/callback` establish that session only after Discord OAuth confirms membership in the configured guild. The read surface remains GET-only, has no mutation endpoint, and ships a restrictive content-security policy. A dedicated AWS load balancer terminates TLS and forwards only to the Console service; it does not expose the callback API or any other application role.

Every application component writes a 15-second Postgres heartbeat, and the Console derives its views from the canonical runtime, task, improvement, proof-producer, deployment, message, and embedding tables. One compact top bar summarizes identity, health, proof producers, and release detail. The master-detail workspace keeps an independently scrollable Activity sidebar visible while the selected story loads in place. All, Running, Waiting, Issues, and Done describe lifecycle; an independent type selector narrows prompts and replies, messages, improvements, code changes, releases, or system activity. Command-K or Control-K performs server-backed search over the eligible three-day window, while arrows or J/K traverse visible stories. Current work stays pinned, open improvements remain regardless of age, linked repair work folds into its issue, successful background runs collapse only after complete projection, and synthetic canaries and CLI prompts stay out of member Activity without leaving the canonical ledger.

The current Console contract replaces `/api/snapshot` with schema-versioned `/api/overview` and `/api/activity` resources. Overview skips terminal activity, message, and detail queries. Activity requests select only the requested story families before semantic folding, so the default view does not scan messages, releases, or system jobs; the browser receives one bounded complete index for the selected types across the uniform three-day window. Lifecycle tabs and counts are local and instant, while type changes and Command-K remain server-backed. The browser coalesces an identical scheduled refresh with the user request, ignores superseded results, retains cursoring only as a safety boundary above 2,000 summaries, and moves an excluded detail selection to the first matching story. Lazy detail queries only the selected story family and never rebuilds the complete projection. JSON responses use Brotli or gzip when accepted, and content-free completion logs record endpoint, status, duration, and serialized response bytes. The client bounds reads to eight seconds and marks an already rendered view stale while retrying rather than silently presenting old data.

```bash
npm run console
```

Then visit `http://127.0.0.1:8081`. The launcher verifies that the production service exists, establishes a loopback-only Kubernetes tunnel, and rejects snapshots that are not explicitly marked production with the supported schema version. Do not expose the ClusterIP through a public load balancer: active request previews are intentionally private operator data. Full transcripts and artifacts remain available only through the existing authorized production-debug workflow.

Every detail type contributes its explanatory records to one chronological Trace instead of adding a type-specific history panel. Member-report titles are projected only in the private Console from the retained source message as a cleaned, 140-character `Reported prompt`, `Reported reply`, or `Reported message` preview; the durable case title and fingerprint remain unchanged. Message overview and detail resolve Discord user mentions through archived guild display names, so the sidebar and Trace render the same `@name` without rewriting canonical content. Message content precedes its embedding outcome; releases combine the prior baseline, proof-producer checks, announcement delivery, improvement receipts, and final verification; code changes combine aggregate attempt/runtime facts with bounded runtime events across every task in the logical story plus typed pull-request and deployment transitions timestamped at the verified release rather than later reconciliation; one-off system executions load their bounded event history; and system rollups retain their constituent runs. The projection continues to expose only allowlisted metadata, including retry attempt and content-free revision identity, and never raw prompts, tool arguments, artifacts, or model reasoning.

`npm run console:dev` instead runs the checked-out Console UI and projection repository locally against production through an ephemeral loopback database relay. It requires the separately provisioned `CONSOLE_DATABASE_URL`, verifies the database session is read-only before serving, and never starts migrations, heartbeat writes, jobs, or Discord clients. Use `npm run console:provision` only from a trusted production-confirmed workstation to create or rotate that least-privilege credential. The deployed Console keeps its ordinary application connection solely because it owns the durable Console heartbeat; the development process never receives that write-capable URL.

`release:status` is the single safe release view. It combines an explicitly requested PR (or the current non-main branch), Helm release state, role images/readiness/revisions, current-pod restart counts, the matching deployment workflow, and the deployed revision-quality assessment. Running it from `main` intentionally omits PR evidence without producing a warning. It uses the same typed deployment-health evaluator as CI and exits nonzero for failed checks, deployment failure, role drift, incomplete rollout, restarted current pods, stale active execution/task work, or a failed quality gate; unavailable evidence is reported explicitly rather than guessed.

The worker reconciles stale non-task executions into an explicit failed terminal result so crashed probes or lost queue workers cannot remain running forever.

## Debug a Discord result

For a Discord link or suspected rollout regression, start from the retained production ledger and correlate ingress, reply-chain, model, tool, and delivery events. Warning signals include both warning- and error-level runtime events; a top-level successful prompt can therefore still be triaged when a tool or delivery sub-operation degraded.

Investigation order:

1. Resolve the deployed revision and rollout time.
2. Confirm ingress captured the intended current message and reply chain.
3. Inspect the persisted turn envelope and memory scope.
4. Inspect selected tools, canonical arguments, typed results, and rejected gates.
5. Separate model completion from delivery intent and Discord network writes.
6. Cluster repeated failures by revision before changing code.
7. Fix the smallest canonical owner and add focused regression coverage.

Do not begin with browser scraping, provider blame, or source speculation when the runtime ledger can show what happened. Runtime diagnostics are retained for trusted operator workflows; they are not a model-facing Discord capability. Private chain of thought is not available or required.

## Improvement inbox

The Unicode `🐛` reaction creates a private `member_report` signal for the current requester. `listMyImprovementSignals` returns only their active signals in channels they may currently see. Removing the reaction withdraws that signal; if it was the last signal on an untriaged case, the case is dismissed.

Every source feeds the same case stream. Source keys provide exact idempotency; deterministic fingerprints coalesce only high-confidence matches; uncertain semantic matches require the explicit `merge` command. A report authorizes an isolated assessment and confirmed repair, but never replays the reported Discord request or grants the sandbox production access.

Trusted runtime, deployment, CI, and eval observers use the same private intake contract. They provide a stable observation ID for exact idempotency and a separate stable failure code for cross-run coalescing. The intake accepts only bounded identifiers and content-minimized summaries; it never accepts prompt, reply, member, or private-eval payloads. Terminal failures create signals, while passing, awaiting-traffic, and insufficient-data observations do not. PR jobs remain isolated from production credentials; `ci_detection` is available only to a trusted configured caller and does not synchronize cases to GitHub.

The production observation also projects schedule run outcomes and current reminder state into that stream. Schedule failure codes contain only the failure kind and an opaque schedule digest, so separate schedules do not block one another. Their proof producer requires evidence from that exact schedule: idle or missing schedules remain inconclusive, and an auto-paused schedule stays unhealthy until it is resumed and completes successfully.

`triage <case-id>` is read-only by default and reconstructs a redacted dossier from active signals plus content-free runtime and delivery aggregates. `triage <case-id> --apply` records the reviewed conclusion, evidence, contract, ownership fields, and lifecycle transition atomically and idempotently; an explicit verdict override requires an operator evidence summary. Manual triage never starts work. Moving a case to `actionable` requires supporting evidence and an accepted contract whose every check resolves to a registered proof adapter with its inputs available. `suggest` returns same-boundary title candidates but never merges them. Report-authorized assessment may link its own confirmed repair; other coding work remains explicitly linked through `runCodingAgent` or `link-task`. Success moves the case to `verifying`, while failure returns it to `actionable`. `verify <case-id> --revision <sha>` is read-only by default and derives typed check results from retained source-owned proof; `--apply` writes the immutable receipt and lifecycle transition. Free-form success summaries and operator-selected executions cannot resolve a case. Never copy private source evidence into a public issue, PR metadata, or tracked fixtures.

Improvement detail projects safe signal provenance, evidence summaries, the active contract, linked repository work, and the immutable verification receipt into the same chronological Trace as assessment and repair events. Reporter identity, raw signal details, prompts, artifacts, task output, and private model reasoning remain excluded.

The worker-owned `improvement.reconcile` job runs at startup, immediately after member report changes or clarification replies, and every five minutes. Every queue attempt records a durable started and terminal receipt. It applies known source-owned detector triage and queues a deterministic autonomous assessment for report-backed cases. A pending clarification suppresses duplicate assessment; transient assessment and report-authorized repair failures retry with at most three deterministic task identities. Assessment keeps the checkout clean until it rejects the report or establishes an executable contract; a confirmed repair opens an auto-merge PR. Publishing that PR does not advance the case to verification: reconciliation compares its exact stored head with GitHub, observes aggregate checks and review state, retires terminal check failures before retrying repair, and advances only after an actual merge. Changed heads, drafts, conflicts, requested changes, and unresolved review requirements are operator blockers. Reporter conversations stay silent unless an exact clarification is outstanding or the case is resolved by deployed verification. Each visible turn mentions the reporter in an explicit reply to the original source message; `in_progress` and `verifying` produce no Discord status update. The reporter's explicit reply to the clarification message becomes same-case evidence and wakes a fresh assessment. Missing source-channel access, a deleted source message, or exhausted delivery retries blocks for operator recovery; reporter conversations never create threads or DMs. `DISCORD_BOT_CHANNEL_ID` remains only the destination for deployment announcements. Automation incidents remain in the private case stream and Console. `reconciliation.awaiting_operator` is reserved for exhausted retries, a concrete automation blocker, failed original-channel delivery, or ambiguity members cannot resolve. The worker also refreshes active PR work, retries verification against the newest durable promotion, evaluates every producer assigned to reconciliation, and refreshes a durable case health projection. The Helm-managed watchdog CronJob runs `improve:watchdog` every fifteen minutes with a five-minute run deadline and evaluates only reconciliation health, so a stopped worker cannot classify itself as healthy. GitHub production observation may independently invoke the same command, but does not provide its liveness schedule. The watchdog records its own receipts, and reconciliation observes those receipts in return. `inbox` and `show` expose case state, blocker, next action, retry trigger, and last material progress. A producer that exceeds its scheduled freshness budget, remains started past its run budget, or crosses its consecutive-failure threshold records a coalesced automated improvement signal. Dependent cases wait on that recovery case; they do not masquerade as ordinary traffic waits or become duplicate human-review items. `blocked` remains the operator queue. Stalled edges use the health progress clock rather than the case's general update time. Repeated passes are no-ops at every boundary.

`improve health` derives a content-free effectiveness report directly from cases, signals, events, work attempts, tasks, runtime cost events, verification outcomes, and producer receipts. The 30-day default window can be changed with bounded `--hours`; current blocker, stalled, and unhealthy-producer counts always cover the complete active stream. The scheduled production-observation artifact includes this report next to revision quality. GitHub receives only aggregate counts, latency/cost distributions, exact machine blocker codes, producer state/reason, and opaque recurrence keys—never case text or Discord/runtime content. Detection ownership is declared in the producer registry: reconciliation observes the release, replay, observation, and watchdog producers, while the independently scheduled watchdog observes reconciliation.

Active contracts that the prompt evaluator can represent are exported into the private regression suite:

```bash
npm run eval:regressions
```

The export stays under `.discord-ai-agent/evals/` with owner-only file permissions. Replays are read-only: mutating tools are removed from the model contract and current-turn mutation authority is false. Contracts without a safe observable replay assertion stay with their registered owning producer rather than becoming an eval note.

Private regression cases carry their source application revision and failure category. The deployment workflow runs them after the capability canary, and a separate scheduled/manual workflow checks the deployed revision daily. Both record content-free per-check results and the automatically resolved canonical replay execution before invoking case verification. Harness errors remain inconclusive; they do not masquerade as product failures. If retained private context cannot faithfully reproduce a contract, the proof records a content-free terminal reason and reconciliation blocks the case for contract revision instead of scheduling the same impossible replay forever. A terminal workflow failure records an idempotent private `eval_detection` signal before the workflow fails. CI logs receive only aggregate counts by source revision and category; prompts, answers, run IDs, notes, and full reports stay inside the production worker.

## Production triage

Group canonical runtime-ledger failures by deployed revision, warning/error event name, failed or empty tool result, and latency. Use retained artifacts only after authorization and redaction; do not export private prompt, reply, or member data.

Deleted reply parents are informational `discord.reply_context.unavailable` events. Unexpected fetch failures remain warnings, so warning-only triage is not polluted by normal Discord deletion.

Prompt and reply Console details default to semantic phases derived from the canonical ledger. Use the phase summary first to isolate intake, agent, or delivery latency; expand the parent context only when the operative request depends on it. Tool outcomes and exceptions stay in their owning Agent phase. Each tool can expand its bounded, formatted arguments; credential-shaped fields and signed URL parameters remain redacted. Tool totals count actual executions; an identical-success reuse is labeled separately and is not rendered as a second tool execution. Legacy executions without terminal counters derive their total from projected terminal tool events rather than nested provider metadata. Use **Raw events** when phase evidence is insufficient, and correlate its typed event codes and retained source-event provenance before opening private artifacts. Header, feed, and trace duration all begin at the retained Discord prompt when available and end at the terminal execution or delivered reply; a disagreement is a projection defect, not an alternate latency definition.

For repository sandbox failures, inspect the terminal task event's `failureCode`, `failureDiagnosis.diagnosticsStatus`, and `observed.metadata` before opening its retained `kubernetes_pod_log` artifact. `sandbox_oom`, `sandbox_evicted`, `sandbox_deadline`, `sandbox_start_failed`, `sandbox_runner_crash`, and `sandbox_disappeared` are distinct causes. `sandbox_unknown` with `read_failed`, `pod_missing`, or `api_unavailable` means the cause was not retained and must not be guessed from the last successful command. A running observation with `retrying: true` is the single automatic infrastructure retry, not another logical code-change task.

## Build and release verification

Before deployment:

```bash
npm run preflight:deploy
npm run verify
npm run verify:db
npm run eval -- --dry-run
```

CI classifies the changed paths and starts lint, tests, production build, repository-policy checks, and relevant DB or infrastructure verification in parallel. Documentation-only and callback-receiver-only changes do not start the DB service; application and high-consequence lifecycle changes still do. The production build performs the TypeScript compilation, so CI does not repeat a separate no-emit compilation. CodeQL remains an independent PR and scheduled analysis. On a deployable `main` push, the same CI run publishes images and invokes the reusable EKS deployment workflow after `verify` succeeds. This keeps rollout and post-deploy verification on the source commit's check graph, so a failed canary or rollback is visible as a failed main-commit check instead of a detached workflow result. Pull requests skip the deployment job. Active main runs are not cancelled by newer pushes, and the production deployment workflow remains serialized under its own non-cancelling concurrency group.

For same-repository PRs, the optional candidate-image path waits for the cheaper verification jobs to pass, then publishes runtime and codegen images to separate ECR repositories under the checked-out Git tree hash. Its OIDC role has no production-repository or Kubernetes access. Dependency, Docker, or native-manifest changes scan those exact remote images on one shared runner. After merge, CI calculates the merged tree hash, promotes only the matching candidates to commit-tagged production references, and deletes the temporary tags; a one-day lifecycle is the cleanup fallback. Candidate repositories disable redundant ECR scanning because CI scans affected candidates and the production repositories scan the promoted release. Exact-tree promotion lets main omit repeated tests and rebuilding. Once candidate publication is enabled, a missing candidate fails closed rather than rebuilding an unverified release. Before enablement, main retains the existing full verification and builds and pushes both images through one Docker Bake graph. PR builds restore trusted default-branch BuildKit caches but do not fill one-use PR cache scopes. Nested Rust targets, Terraform providers, coverage, and other local build state are excluded from the Docker context.

After Helm completes, deployment verifies each role's image and `APP_REVISION`, confirms the worker may create sandbox Jobs, and runs private canaries through the compiled prompt path. Independent GitHub, sandbox-callback, stats, bounded-randomness, and hosted-web probes run concurrently in isolated identities; exact two-turn conversation continuity remains sequential by design. The web canary supplies its typed operation as an object, matching the application-tool boundary rather than asking the model to reinterpret serialized JSON. The canary also performs non-mutating Discord bot-identity and channel-access probes. It never posts a canary message, because deleting one still leaves member clients with stale unread-channel markers. The callback canary never clones, edits, pushes, or opens a PR.

Each post-deploy stage—immediate health, capability canary, Console health, private regressions, the 30-second stability window, and durable promotion—gets one bounded retry with a short delay. The workflow records typed stage/attempt outcomes; a failed private-regression command also retains its aggregate-only safe summary, never prompt or reply content. A terminal stage failure best-effort records a private `deployment_detection`, or an `eval_detection` for private regressions, before rollback. If intake is unavailable, it retries once after rollback without changing the release outcome. The workflow rolls back to the exact Helm revision captured before the upgrade and verifies that prior revision with the same restart-free health gate. A failed rollback remains a distinct terminal outcome and never hides the original failed stage. First-time installs have no rollback target and fail explicitly. Migrations remain forward-only and must preserve the preceding application revision long enough for this recovery path.

The bot does not resolve improvement cases or publish a deployment announcement merely because a new pod became ready. Release pods wait for the workflow to write the verified revision and unique rollout ID to Postgres after every gate passes. The private eval runner retains aggregate-only per-contract outcomes, promotion applies complete receipts, and production observation later supplies traffic-sampled quality proof. Runtime/delivery contracts remain `verifying` until a revision-matched terminal execution is supplied. The system never replays a member's old request as authority. Local, non-SHA revisions bypass this production-only promotion gate.

Each capability attempt uses a fresh session, and one isolated retry absorbs ordinary model-call variance without retrying a tool inside an attempt. Retrieval passes only with exactly one successful stats result; randomness passes only with exactly one successful `drawRandom` completion and no runtime error event; web passes only with exactly one successful non-empty result plus provider-recorded hosted execution. Completion markers alone are insufficient evidence. A persistently failed boundary fails the rollout instead of treating configured tool metadata as readiness. After all capability, Console, and private-regression checks, the typed deployment-health gate requires API, bot, worker, and Console to remain aligned, fully ready, generation-current, and restart-free for 30 seconds. Build, migration, rollout, readiness, capability verification, Console verification, and Discord delivery remain distinct stages. Durable delivery behavior is exercised by the reliability and database suites, while production observation reports failures and pending delivery obligations from real traffic without generating synthetic member-visible messages.

The production-observation workflow samples the deployed revision every six hours and retains a 48-hour aggregate containing answer status/latency by model, terminal per-run capability outcomes, raw tool attempts, recovered validation retries, per-capability p50/p95/max latency, latency budgets and slow-success counts, warning/error counts, and delivery states. Statistical answer, tool, report-rate, and latency evidence is grouped by a content-addressed behavior cohort: prompt version, tool-contract version, model/runtime configuration version, and an explicit quality-runtime version. Compatible code-only revisions therefore contribute to one useful sample instead of restarting observation. Changes to execution or delivery semantics that alter quality comparability must bump `QUALITY_RUNTIME_VERSION`; prompt, tool, and relevant configuration changes split cohorts automatically. Only explicitly member-originated Discord executions enter this quality cohort; scheduled read-only occurrences use their own `scheduled` identity, while CLI prompts, evals, and deployment canaries remain `synthetic`. Scheduled health is reported alongside member quality without entering its gate: exact-revision counts cover succeeded, partial, and failed runs, while overdue rows, expired delivery leases, repeated partial outcomes, and recent automatic pauses create content-free improvement detections. A failure already represented by an automatic pause is not duplicated as a separate run incident. Pending member delivery obligations become incidents after five minutes, avoiding false alerts for replies actively being delivered, while abandoned obligations fail immediately. The workflow reads the canonical runtime ledger and schedule control projection inside the cluster and publishes only safe counts—never prompts, replies, schedule IDs, member identities, or private Discord content. Output includes the cohort fingerprint and contributing exact revisions. Use `npm run quality:revision -- --revision <sha> --hours 48` for the same safe operator view inside a configured runtime.

Repeated attempts of the same capability in one execution count once toward terminal capability health, using the final result; attempts and recovered schema retries remain separate efficiency signals. This prevents a recovered malformed call from masquerading as several independent member-facing failures without hiding its latency and cost. Error observation follows the same rule: a specific typed failure is the root occurrence, while `agent.nanocodex.runtime_failed`, `agent.execution.failed`, and `agent.span` are fallback roots only when the execution has no more-specific error. Terminal tool outcomes, overdue or abandoned delivery, and otherwise-unexplained failed answers form separate root clusters. Safe error kind, code, and status dimensions distinguish clusters without exposing error prose, prompts, replies, or execution IDs in the scheduled output.

The embedding worker scans a bounded newest-first backlog shortly after startup and every five minutes. It re-enqueues eligible stored messages whose realtime enqueue was missed during a rollout or transient queue failure; the existing singleton key keeps recovery idempotent.

The observation compares the deployed behavior cohort with the most recently active prior cohort. Hard delivery, failed-answer root occurrences, warning/error, and root-cluster evidence remains scoped to the exact deployed revision and fails immediately; aggregate failure rates and answer-latency thresholds use the compatible cohort and enforce only after a useful sample. A failed assessment records one private `runtime_detection` for each exact execution and root cluster. A successful capability that exceeds its contract-owned latency budget independently records a medium-severity `tool_latency` detection without failing or rolling back an otherwise healthy release. Its stable cluster reference is revision-independent, so the same capability breach across revisions coalesces while unrelated failures remain separate cases; the private signal retains the canonical execution reference. Aggregate policy failures such as answer latency use their own metric cluster. A latency-cluster contract passes only after three real successful calls to that same capability occur without recurrence; reused calls and unrelated tool traffic do not count. Production quality counts only human/report signal sources in its report-rate metric, so its own automated detections cannot create a feedback loop. `rollback_candidate` means the current cohort failed while its sufficiently sampled baseline cohort passed; it is evidence to inspect and roll back, not permission for an unrelated mutation. A cohort with no member answers reports `awaiting_traffic`. After traffic begins but before ten member answers it reports `insufficient_data`; the assessment includes remaining answer and tool-call sample counts. Both remain observable without generating a false incident or improvement signal, except that directly observed slow-success calls still enter the unified improvement stream.

Run the deterministic failure suite with `npm run test:reliability`. It covers same-thread serialization, cross-thread concurrency, Discord rate limits and idempotent final delivery, model timeouts/retries, durable queue handoff, signed sandbox callbacks, and lost-sandbox reconciliation. `npm run verify:db` additionally proves concurrent ledger writes and queued work surviving a producer/worker restart.

## Kubernetes production

The reference deployment is the Helm chart in `deploy/helm/discord-ai-agent/`; `deploy/terraform/aws/` provides an AWS baseline for VPC, EKS, ECR, RDS, and GitHub OIDC.

### Hosted Console

The production Console is published at `https://console.mindcool.dev` through a dedicated internet-facing AWS Network Load Balancer. TLS terminates with an ACM certificate and the backend forwards plain HTTP only inside the cluster to the Console service. Route 53 owns the hostname. The callback API and other application roles remain internal-only.

Provisioning has three explicit prerequisites before setting the GitHub Actions variables `CONSOLE_TLS_CERTIFICATE_ARN` and `CONSOLE_ROUTE53_HOSTED_ZONE_ID`:

1. Add the Discord OAuth redirect `https://console.mindcool.dev/auth/callback` to the configured Discord application.
2. Add `DISCORD_CLIENT_SECRET` and a randomly generated `CONSOLE_SESSION_SECRET` to the existing `discord-ai-agent-env` Kubernetes Secret.
3. Issue or select an ACM certificate covering the Console hostname, store its ARN as `CONSOLE_TLS_CERTIFICATE_ARN`, and store the public domain's hosted-zone ID as `CONSOLE_ROUTE53_HOSTED_ZONE_ID`.

The deployment workflow enables the public service only when `CONSOLE_TLS_CERTIFICATE_ARN` is non-empty. It waits for the load balancer and at least one healthy target, resolves its canonical zone, and atomically upserts the `console.mindcool.dev` Route 53 alias before running external route and authentication-boundary checks. Scheduled Console health observation uses the same public-TLS condition. Removing the certificate variable removes the Helm-managed public service on the next deployment without changing the internal Console endpoint; remove the DNS alias separately when intentionally decommissioning the hostname.

Production Console startup fails closed when its Discord client ID, client secret, guild ID, or session secret is missing. Discord OAuth requests only `identify guilds`, checks the exact configured guild, discards the access token after the callback, and issues a signed 12-hour `Secure`, `HttpOnly`, `SameSite=Lax` session cookie. `/healthz` stays public for cluster probes; all non-loopback Console pages, assets, and APIs require the session. The socket-level loopback exception preserves `npm run console`, `npm run console:dev`, and the existing read-only Kubernetes port-forward workflow without creating a header-based bypass.

Create one namespace-scoped application Secret through your secret manager with the required app variables. Prefer GitHub App credentials in production. Add Privy credentials only when payments are enabled. Pods read secret values at startup, so restart deployments after secret changes.

Install or upgrade:

```bash
helm upgrade --install discord-ai-agent deploy/helm/discord-ai-agent \
  --namespace discord-ai-agent \
  --create-namespace \
  --set image.repository="$REGISTRY/discord-ai-agent" \
  --set image.tag="$GIT_SHA" \
  --set sandbox.image="$REGISTRY/discord-ai-agent-sandbox:$GIT_SHA"
```

Inspect rollout by role:

```bash
kubectl -n discord-ai-agent get pods
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-api
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-bot
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-worker
kubectl -n discord-ai-agent logs deploy/discord-ai-agent-console
```

The chart runs migrations as a hook; production application pods never run migrations on startup. Commit-tagged application and sandbox images are built once and promoted; the deployment workflow must not rebuild a different artifact.

Use Helm—not `kubectl rollout undo`—for production recovery so one field manager continues to own application revisions. Inspect `helm history`, choose the known-good Helm revision, and run:

```bash
npm run release:rollback -- --to <helm-revision>
```

The recovery command reads the target revision's immutable application SHA, performs a waiting Helm rollback with job cleanup and conflict reclamation, then applies the same 30-second restart-free deployment-health gate used by CI. It requires an explicitly selected Helm revision and never guesses a rollback target.

## Sandbox and network posture

The worker service account may create per-task Jobs, Secrets, and ConfigMaps. The sandbox service account has no Kubernetes API access. Sandbox secrets omit Discord and database credentials. Network policy should permit the internal callback API, DNS, and required HTTPS destinations only.

The app and sandbox service accounts disable automatic Kubernetes token mounts; only the trusted worker receives the launcher identity. Sandbox callback bearer tokens are scoped to the task and sandbox-run IDs and expire after two hours. Each task receives a separately derived callback-signing key rather than the deployment master secret; each exact body also carries a two-minute timestamped HMAC, limiting cross-task forgery and replay while allowing normal clock skew. Terminal callbacks remain idempotent. Generic HTTPS egress excludes loopback, link-local/cloud-metadata, carrier-grade NAT, and RFC1918 ranges; the internal API is allowed separately by pod identity. On Cilium clusters, enable the FQDN policy to narrow public HTTPS to the reviewed host list.

Every code-update task runs in a separate Kubernetes Job. The regular worker owns queue handoff and reconciliation; no dedicated warm worker, persistent cache, or alternate execution backend exists.

## Local Kubernetes validation

Use kind or another local cluster when the Kubernetes sandbox path itself is under test:

```bash
kind create cluster --name discord-ai-agent
docker build -t discord-ai-agent:local .
kind load docker-image discord-ai-agent:local --name discord-ai-agent
helm upgrade --install discord-ai-agent deploy/helm/discord-ai-agent \
  --namespace discord-ai-agent --create-namespace \
  --set image.repository=discord-ai-agent \
  --set image.tag=local \
  --set image.pullPolicy=IfNotPresent \
  --set sandbox.image=discord-ai-agent:local \
  --set sandbox.imagePullPolicy=IfNotPresent
```

Create the application Secret first and point `DATABASE_URL` at a Postgres instance reachable from the cluster. Validate chat delivery and one harmless code-update request, then inspect the Job, callback events, PR, and cleanup. This is an advanced integration path, not the default contributor loop.

## Recovery checks

When production is unhealthy, inspect these independently:

- database connectivity and migration completion;
- bot gateway readiness and Discord permissions;
- worker queue registration and backlog age;
- agent-runtime silence/hard timeouts;
- API authentication and callback reachability;
- Kubernetes Job state;
- delivery obligations awaiting replay;
- payment or transfer reconciliation when enabled;
- deployed revision versus the revision that produced a run.

Use provider or Kubernetes logs after the canonical ledger identifies the failing boundary. A successful model result with a pending delivery obligation is a delivery incident; a missing execution after persisted ingress is a queue incident; a submitted transfer without a terminal receipt is a reconciliation incident.
