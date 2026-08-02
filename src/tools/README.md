# Tools Domain

Owns model-facing local tool contracts and implementations.

## Responsibilities

- `contracts/`: focused, compile-time checked contract families containing names, descriptions, schemas, output contracts, taxonomy, implementation bindings, and canonical examples used by validation and documentation.
- `toolDefinition.ts`: canonical tool names/types plus `defineTool`, generic class/policy defaults, and fail-fast contract-to-handler binding.
- `registry.ts`: small aggregation/index/cache layer for contract families and hosted tools; model definitions are cached by contract identity. Model-visible definitions keep the description, input schema, and output interface concise without repeating contract examples or internal tool classes.
- `../agent/toolHandlers/`: focused execution adapters by the same coarse families; `toolDispatcher.ts` is only the validation/gating/delegation boundary and an O(1) handler lookup.
- `toolContractValidation.ts`: compiles every local tool's advertised JSON Schema, validates contract-owned canonical argument examples, and validates normalized model arguments against that same contract before permissions, budgets, or implementations run.
- `toolDeployment.ts`: applies and caches deployment capability narrowing once for both the model-visible schema and runtime validator (currently wallet-backed wager fields and configured premium Discord SKUs).
- `agentTaskTools.ts`: model-facing code-update task creation, status, retry/cancel, deployment status, and task log snippets.
- `agentTaskFormatting.ts`: code-update task titles, task result messages, compact timing/cache lines, and shared duration formatting.
- `toolScope.ts`: applies deployment-aware availability filtering. NanoCodex receives the stable full deployed schema rather than a natural-language capability router.
- `../skills/loader.ts`: lists repository skills as a compact inventory and loads one exact named skill through `loadSkillContext` only when its procedure is relevant. Database-backed skill management is intentionally absent.
- `discordHistoryFormatting.ts`: Discord history search syntax, date coercion, no-results text, and history evidence/summary formatting.
- `discordFileTools.ts`: permission-aware Discord attachment selection, fresh CDN URL resolution, bounded downloads, inspection events, and audit logging.
- `fileInspection.ts`: bounded in-memory file detection and parsing for text, JSON, Office Open XML, ZIP, images, PDFs, unknown binaries, and iRacing `.sto` setup notes.
- `discordStatsFormatting.ts`: Discord stats and channel-topic output formatting, metric parsing, and topic clustering helpers.
- `generatedFileTools.ts`: current-turn generated file/table access and CSV/table querying for artifacts produced by earlier tool calls.
- `imageTools.ts`: Discord image inspection, scoped reference image collection, image generation, and generated-file conversion. Context references are included by default; the typed `useContextImages=false` choice excludes them when the model determines the current request asks for a fresh composition. Provider failures are returned as typed errors rather than hidden semantic retries.
- `imageAspectRatio.ts`: supported typed generation aspect ratios.
- `imageOutputInspection.ts`: decoded generated-image dimensions, media types, and real alpha inspection.
- `responseFormatting.ts`: shared final-response cleanup, Markdown-table normalization, and Discord length trimming used by the agent router and Discord renderers.
- `discordPresentationTools.ts`: validates the model-selected semantic Components V2 presentation against the same canonical Zod schema used to generate the model tool contract; Discord IDs, authorization, persistence, compilation, and delivery remain owned by Discord/database code.
- `spotifyTools.ts`: Spotify Web API client-credentials integration for public catalog search, item details, playlist/album track attachments, artist discographies, playlist stats, and playlist comparisons with current API limits and sanitized stored output.
- `spendTools.ts`: ops spend summaries from `tool_audit_logs.estimated_cost_usd`, including today/month totals and top tool/user breakdowns.
- `walletTools.ts`: conversational shared-wallet lifecycle status, roster-independent funded-wallet directories backed by existing wallet accounts, requester-scoped canonical wager history, safe Discord-name resolution with one live roster fetch per turn and a permission-filtered indexed fallback, below-target starter top-ups, requester transfers including explicit whole-balance sends, confirmed follow-up admin corrections, durable starter-target resets, receipt-backed fee summaries, and authorized reconciliation.
- `standardWagerSettlement.ts`: recomputes standard coin-flip and hit/stand blackjack outcomes and payouts from the scoped wager plus persisted verified draws, replacing inconsistent model settlement proposals before any transfer.
- `standardWagerRuntime.ts`: applies verified deterministic settlement results at the money-moving tool boundary.
- `paymentToolContext.ts`: shared payment event recording and network-aware Tempo transaction explorer footers.
- `discordOpsTools.ts`: reply-aware, permission-filtered self-debugging through `inspectAgentLogs`, including normalized run evidence and optional bounded redacted model I/O.
- `agentModelCatalog.ts` and `agentModelTools.ts`: owner/ops-only durable per-server NanoCodex switching and reset. The model supplies a typed set/reset action and catalog target; code enforces the allowlist and durable setting boundary.
- `discordBugTools.ts`: requester-scoped, permission-filtered retrieval of messages marked with the Unicode `🐛` reaction, including replied-to prompt context for later code-update tasks.
- `guildEmojiTools.ts`: ops-gated custom server emoji creation from generated, attached, replied-to, or URL images, including bounded 128×128 WebP normalization and upload auditing.
- `toolContext.ts`: shared tool-context helpers such as requester-visible indexed channels and Discord message-id parsing.
- Discord resolvers, history/retrieval, stats/topics, images/vision, code-update tasks, task status, logs, deployment status, and response cleanup.
- Restricted expensive/mutating tools are gated in the router before dispatch: avatar updates use the ops allowlist, primary-model changes (`setAgentModel`) fail closed to the configured owner/ops allowlist, and image generation can opt into the ops allowlist. Code-update starts and retries are available to every member.

## Change Routing

- If the model chose the wrong capability, update tool descriptions/schema/examples and add a registry or agent test.
- If the tool returned weak data, update the implementation and closest domain query.
- If the requested behavior is durable storage/indexing/retrieval, fix the owning data lifecycle first; do not rely on prompt/tool wording alone.
- Exact-message follow-ups to `getDiscordStats groupBy=hourOfDay` use `searchDiscordHistory` with the same requester-visible author/channel/date filters, `query=""`, and `hourOfDayUtc` (0-23). The repository applies that UTC bucket before returning message evidence; aggregate rows are never treated as the underlying messages.
- Image edits inline bounded, permission-scoped Discord CDN references before calling the generation provider so private or signed attachment URLs do not depend on provider-side downloads. The model supplies explicit background, output-format, and aspect-ratio controls; provider rejections remain visible and retryable instead of being reinterpreted by application code.
- Transparent image edits validate real alpha before delivery. If the provider returns an opaque image whose background cannot be isolated safely, the tool makes one bounded recovery generation with the same references and a cutout-friendly flat background, runs local background removal again, and still fails closed rather than attaching opaque output when recovery is unsafe.
- Image requests with exact visible typography pass every verbatim string through `generateImage.requiredText`; the tool performs a vision validation and retries once with a correction prompt. If ordinary opaque image generation still misspells the text, it makes one bounded text-free base attempt and renders the exact strings in a deterministic caption panel. Transparent assets continue to fail closed rather than adding an opaque panel.
- Discord history search runs lexical and semantic retrieval in parallel. A failed interactive embedding is not repeated; if exact keywords also find nothing, the tool returns bounded recent candidates from the same permission, channel, author, and date scope with an explicit degraded-evidence warning for model-side relevance checking.
- If adding a new tool, define it in the owning `contracts/` family, bind its implementation through the typed handler registry (or an explicit delegated high-risk router), add audit behavior, and add at least one unit or integration test. Startup fails on missing or unknown handlers.
- Once an external or durable mutation succeeds, later audit, cleanup, or balance-refresh failures must not turn it into a retryable failure. Return the committed result, expose any useful partial limitation, and record best-effort diagnostics.

## Tests

- Tool schemas, runtime validation, and taxonomy: `tests/unit/tool-registry.test.ts` and `tests/unit/tool-contract-validation.test.ts`.
- Per-family handler ownership, complete routing, and fail-fast drift checks: `tests/unit/tool-handler-conformance.test.ts`.
- Tool scoping and argument coercion: `tests/unit/tool-scope.test.ts` and `tests/unit/tool-arguments.test.ts`.
- Tool behavior: focused `tests/unit/*-tools.test.ts` files; `tests/unit/core-tools.test.ts` covers shared cross-tool behavior.
- End-to-end model/tool behavior: `tests/integration/agent.test.ts`.

## Structure

Implementation lives directly in focused modules by tool family: Discord resolvers/retrieval/summary/ops, agent memory, generated files, images, code-update tasks, spend, Spotify, and response formatting. Add contracts to the matching `contracts/` family; `registry.ts` aggregates them without owning individual schemas.

## Tool Ownership and Deployment

`registry.ts` assigns each model-facing tool to a coarse ownership `group`: `core`, `discord-retrieval`, `generated-data`, `presentation`, `discord-action`, `image`, `spotify`, `codegen`, `ops`, or `external`. NanoCodex receives one stable, complete tool contract narrowed only by actual deployment availability. There is no natural-language router or mid-turn tool-expansion protocol. Canonical schemas retain their nested structure, enums, required fields, and references so model-visible arguments match runtime validation exactly.

Deployment requirements and access policies live on each tool contract. The deployment toolset and permission gate consume that metadata instead of reconstructing policy from tool-name lists. Handler families bind every registered tool directly and startup fails on a missing or duplicate adapter.

Tool results return typed status, error, retry, limitation, and lifecycle metadata at their source. Human-readable content is evidence for the model, not a control protocol for code to parse. Discord-specific Markdown conversion and final reply truncation happen at the delivery boundary; tool-loop evidence keeps its original wording within the separate prompt-result bound.

New chance requests are model-led through the always-visible deployed `drawRandom` contract. A wallet wager additionally declares the immutable requester, stake, exposure, interaction mode, and structured rule (`coin_side`, `sum`, `any_match`, or `all_distinct`). Fairness and payout limits are calculated directly from that rule in code. Continuation tools resolve the canonical wager from requester and Discord game-session scope rather than trusting model-copied ids. Blackjack continuations require a typed `hit` or `stand` that is present in durable `allowedActions`, and reject invalid shapes before consuming entropy. Settlement remains ledger-validated, and standard coin-flip/blackjack results are recomputed from persisted verified draws before money moves. The payment ledger permits one reservation per request and one active game per player/reply chain. Deployment gates still hide Spotify/codegen and wallet features when not configured.

Because RNG proof footers publish every draw immediately, an opening blackjack draw is exactly three public cards: two player cards and the dealer upcard. The dealer hole and later dealer cards are drawn only after a later player action makes them public.

## Discord File Inspection

`inspectDiscordFile` accepts a Discord message link/ID or uses attachments from the current request and reply chain. Explicit historical messages are resolved through permission-filtered indexed attachment metadata, then refreshed through the Discord API before download so expired CDN URLs do not become permanent failures. Up to eight matches totaling 20 MiB are inspected in one bounded batch by default. Identical extracted content and common metadata are emitted once so related setup/document collections do not multiply prompt tokens. Common audio and video files, including QuickTime MOV containers, are transcribed through the configured OpenRouter transcription model.

The same tool can transcribe a public X/Twitter status video when its URL appears in the immutable current request or Discord reply chain. It resolves bounded public metadata through X's syndication endpoint, accepts MP4 bytes only from `video.twimg.com`, and rejects redirects, unapproved hosts, oversized responses, or tool-supplied URLs outside current requester scope. An explicit transcription request with scoped media forces the inspection tool on the first model round; when there is exactly one scoped X video, the tool can recover that URL from the reply chain even if the model omits the optional argument. Transcript text stays in the untrusted tool result while events and audits contain only safe metadata.

Inspection is bounded and non-executing: downloads are limited to 20 MiB, archive entry names and expansion sizes are validated, extracted text is capped, and file content is marked as untrusted model evidence. The parser registry currently provides:

- UTF-8/UTF-16 text and normalized JSON, including common source/config/data extensions.
- DOCX, PPTX, and XLSX text extraction plus safe generic ZIP listings.
- Image detection that directs visual questions to `inspectDiscordImages`.
- Bounded audio/video transcription for common Discord media formats, QuickTime MOV, and scoped public X/Twitter status videos.
- PDF container metadata and explicit notice that semantic PDF text extraction is not yet available.
- Bounded printable-string fallback for unknown binary formats.
- iRacing `.sto` opaque-container metadata, high-entropy payload identity, filename-derived qualifying/race/wet hints, and structured embedded UTF-16 setup notes. Garage values remain opaque and must never be inferred from the notes or characterized as compressed, encoded, or encrypted without verified evidence.
- iRacing Garage HTML exports, including exact simulator-decoded setup sections and values such as pressures, temperatures, ride heights, springs, damping, camber, toe, brake bias, fuel, aero, differential, and in-car controls when present for that car.
- iRacing SDK `.ibt` telemetry session data, including exact loaded `CarSetup` values and bounded track, weather, and setup context when `irsdkLogSetup=1` recorded the setup.

For exact iRacing values, load the `.sto` in the simulator and attach either a Garage HTML export, an `.ibt` telemetry recording containing SDK `CarSetup` data, or clear Garage screenshots. HTML is the smallest deterministic interchange format; `.ibt` adds session context; screenshots use the existing image-inspection path. The offline `.sto` parser remains useful for file identity, purpose/weather filename hints, opaque-payload comparison, and embedded notes, but it is not presented as setup analysis.

Successful fetches, inspections, and transcriptions record `discord.file.fetched`, `discord.file.inspected`, and `discord.file.transcribed` runtime events with byte count, parser/model, type/format, latency, and extracted-character count. Failures record `discord.file.fetch_failed` or `discord.file.transcription_failed`. Raw extracted content and transcripts are not written to audit summaries or event metadata.

## Discord Self-Debugging

Authorized operators can reply to a request or bot response with prompts such as `debug this`, `why did you do that?`, or a why-not question about a tool choice. The ops toolset is enabled for these terse debugging replies, and `inspectAgentLogs` resolves the reply root/direct parent to a requester-visible run when no explicit identifier is supplied. Diagnostic questions remain read-only and do not authorize the omitted action. Its summary prioritizes model rounds, prompt-section weight, token/cache use, requested tools, and critical-path gaps before normalized trace/task/command evidence. `detail=model_io` is reserved for explicit prompt/input/output inspection and loads only artifacts belonging to the already-authorized run; contents are redacted again and truncated before entering the model context.
