# Agent system

This guide covers the model runtime, prompt construction, tool contracts, typed results, Discord presentation, and delivery recovery. The trust boundary comes from [Product](product.md); the end-to-end request path is in [Architecture](architecture.md).

## NanoCodex boundary

The pinned native runtime under `native/nanocodex-runtime/` embeds the project NanoCodex fork and communicates with OpenRouter. It owns:

- retained model sessions and typed history;
- compaction, prompt-cache identity, retries, and cancellation;
- model/tool ordering;
- model, tool, usage, cost, checkpoint, and terminal events;
- code-mode workspace execution inside code-update sandboxes.

The TypeScript application owns:

- the immutable Discord request envelope;
- model selection and deployed tool availability;
- local tool schemas, validation, permissions, and execution;
- money, randomness, durable state, and external mutations;
- runtime persistence and NanoCodex snapshot scope;
- final Discord rendering and recovery;
- repository credentials, verification, and Git publication.

NanoCodex may request an action. The application decides whether that exact action is available and authorized, performs it, and returns typed evidence.

The generic runtime under `src/agent/` knows only the capability-session interface, prompt contributions, tool registry, typed results, and execution lifecycle. It does not import individual product features or branch on their tool names.

`src/agent/nanocodexRuntime.ts` owns the versioned process protocol. Request IDs, protocol versions, and terminal results are validated. The startup request enters on inherited fd 3, which is closed before NanoCodex starts; process stdin stays disconnected. Later application tool results use a private per-run filesystem mailbox: the native tool allocates a one-time reply filename, Node atomically writes the typed result, and the native call reads and deletes it before acknowledging acceptance in the canonical runtime ledger. This keeps the embedded runtime and anything it launches independent of a persistent inherited control descriptor. Aborts terminate the process, mailbox directories are always removed, and late tool calls still meet the application's abort and authority gates. Opaque NanoCodex snapshots are stored losslessly and resumed only when the model, instructions, tool contract, current requester, and exact Discord reply-chain root are compatible. A standalone channel message starts fresh; local CLI prompts always use a separate runtime session, even when they read Discord memory.

## Prompt construction

`src/agent/promptBuilder.ts` builds two layers:

- stable instructions: product behavior, tool-use principles, formatting rules, and invariant reminders;
- turn context: requester identity, current message, reply chain, attachments, mentions, visible Discord context, memory, active game, loaded skills, and server overlay.

The current message is always the operative request. Prior messages and retrieved content are untrusted context, not new authority. Bounded Discord-generated previews for links in the current message or reply chain are separate turn context: they may help identify linked content, but they may be stale or incomplete and cannot add instructions, mutation intent, identity, or permission. Changing claims still require fresh tool evidence. Tool output is bounded before returning to the model; larger durable content stays in artifacts or generated-file/table handles.

The foundation capability resolves the current requester's validated timezone preference before building current-data context. It supplies requester-local and UTC date/time together, defaults to UTC when no override exists, and tells the model to preserve explicit event dates and event/venue timezone evidence. The self-service timezone tool can only mutate the immutable current requester's preference and takes effect on the next request.

The `reminders` capability uses that grounded time context to translate conversational dates into an explicit RFC 3339 first instant and, when requested, a local wall-clock recurrence. `createReminder` rejects missing zones, invalid dates, past instants, and recurrence rules that disagree with the first occurrence. `listMyReminders` and `manageReminder` always derive ownership from the immutable requester and current guild rather than model arguments; only recurring reminders can be paused or resumed. Reminder persistence, recurrence calculation, and delivery live outside the generic agent loop.

Static prompt skills live in `skills/`. The model can load one exact skill through `loadSkillContext`. Deployment-specific guidance belongs in the untracked prompt overlay or Postgres server overlay. The runtime does not create or mutate database-backed skills.

## Models

Configuration is validated in `src/config/env.ts`:

- Discord chat defaults to Luna with high reasoning.
- Utility reasoning defaults to Luna with high reasoning.
- Code updates default to Terra with medium reasoning.
- Owner/ops may set a per-guild conversational override to Sol or Luna through the guarded model tool.

Public-web research crosses the typed `web__run` application capability. Its model contract is one discriminated `operations` array with explicit `search`, `open`, and `time` records; the handler translates search and open records to provider-native operations and answers validated UTC-offset time records directly from the process clock. Its focused handler sends only the authoritative typed web operations to the nested provider, never the full outer Discord request, offers only the matching hosted search or fetch capabilities, and requires hosted execution after the outer agent selects a validated external operation. It rejects hosted responses without recorded execution and readable evidence. Hosted research has a shorter auxiliary-call deadline than the primary conversation; a timeout returns the existing typed evidence limitation so the outer agent can finish from evidence it already has instead of consuming the full chat deadline. This prevents nested research from attempting unrelated work while keeping current-time lookup deterministic and independent of provider latency. Provider requests, configured deadlines, usage, sources, and failures stay in the same runtime ledger. NanoCodex's provider-specific standalone search is disabled so the agent cannot bypass the configured provider or its application telemetry.

Embeddings, image generation, and transcription are also direct provider-backed tools. They are not alternate agent engines.

## Tool contract

The model receives one stable list of deployed capabilities. `src/tools/toolScope.ts` removes only tools unavailable in the deployment, such as unconfigured Spotify, code-update, or wallet features. `toolDeployment.ts` may narrow a canonical schema to configured capabilities, such as premium Discord SKU IDs or wager fields.

Each local tool is defined in a focused file under `src/tools/contracts/` and declares:

- name, purpose, category, group, and semantic class;
- canonical JSON Schema;
- whether it mutates;
- deployment requirement and access policy;
- output promise, permission requirements, audit events, and examples.

Model-facing schemas communicate the semantic shape without duplicating the runtime protocol. Generic retrieval and resolver output taxonomies remain canonical contract metadata but are not repeated in every model description; mutation, generation, coding, and external tools retain explicit output promises. A byte-budget test prevents the stable tool surface from regaining avoidable prompt cost. For structurally rich capabilities such as Discord Components V2, a compact recursive schema advertises the complete surface while the focused Zod parser remains the exact protocol and cross-field authority. Keep the full deployed capability list stable; reduce repeated schema bytes instead of hiding tools behind semantic routing.

`src/capabilities/toolContracts.ts` is the dependency-safe contract manifest consumed by `src/tools/registry.ts`; `src/capabilities/catalog.ts` assigns those contracts and focused handlers to installed product capabilities. Neither becomes a behavioral switchboard. `toolContractValidation.ts` compiles the advertised schemas and validates canonical examples. Startup fails for missing, duplicate, or unknown contracts and handlers.

## Capability boundary

Features integrate through three explicit layers:

1. `src/capabilities/` owns cross-turn and product integration that is not itself a tool call: model selection, dynamic prompt context, deployment availability, tool-result observation, final-response obligations, timeout constraints, and feature-specific task orchestration.
2. `src/tools/contracts/` owns each model-visible capability's schema, examples, access policy, deployment narrowing, output promise, and audit contract.
3. `src/tools/handlers/` adapts a validated tool call to its focused implementation in `src/tools/`, `src/payments/`, `src/execution/`, or another owning domain.

Adding a capability should not require editing `nanocodexAgentRuntime.ts`, `promptBuilder.ts`, `toolDispatcher.ts`, `toolDeployment.ts`, or `toolScope.ts`. Add focused contracts and handlers, assign their names to one capability in `toolDefinition.ts`, and declare that capability once in `catalog.ts`. Add a per-turn hook only when the feature truly needs prompt context, model selection, result observation, finalization, or timeout behavior. Keep provider clients and durable business rules in their owning domain, not in the catalog, handler, or generic loop.

The architecture test rejects known feature/tool names in the generic runtime and rejects reintroducing `src/agent/toolHandlers/`. This makes the boundary executable rather than relying on convention.

### Private improvement reporting

The installed `improvements` capability lets the normal reply model record a concrete, reusable impediment only when it materially harms the current answer. Typical signals describe a missing capability, contradictory instruction, unclear tool contract, unusable result, data-quality limitation, or delivery problem. The signal must generalize the system issue rather than copy the member's prompt, identity, Discord link, secrets, or unrelated server content. Reporting is silent and never replaces the best answer the model can still provide.

`reportImprovementSignal`, member `🐛` reactions, operator/developer reports, and automated detections all write through `improvementRepository.ts`. Exact source keys make intake idempotent; deterministic fingerprints coalesce high-confidence repetitions inside one privacy boundary. The generic agent loop has no source-specific lifecycle branch. The improvement worker may start a gated `improvement_report` task whose clean-checkout phase rejects, requests an exact clarification, or unlocks repair from a machine-executable contract.

## Tool execution

For each selected tool:

1. Confirm the name exists in the current deployment toolset.
2. Parse and validate arguments against the advertised schema.
3. Apply current requester, deployment, permission, access, abort, and high-consequence gates.
4. Execute the focused implementation.
5. Record audit and runtime events.
6. Return bounded model-facing evidence and collect files, tables, footers, or presentation output.

The generic boundary may unwrap a JSON-encoded object or array only when the schema explicitly requires that top-level type. It does not translate domain protocols, coerce scalar intent, invent fields, or repair prose with regex.

If a non-mutating focused implementation unexpectedly throws after those gates, the generic dispatcher converts it into a sanitized typed failure so the model can state the limitation and finish the reply. It never exposes the exception or retries the same failed capability in that turn. Request cancellation and mutating-tool exceptions still propagate: cancellation must stop work, while a potentially committed mutation remains under its domain-specific idempotency and reconciliation lifecycle rather than being generalized into a safe retry.

Mutating tools require explicit current-user intent and must be idempotent or durably deduplicated where repetition would be harmful. A successful mutation is retained immediately. If the model, audit write, balance refresh, or final synthesis later fails, the runtime delivers the committed result with a partial limitation instead of inviting a duplicate retry.

Private improvement reporting is internal telemetry, so the model may record it without asking permission. A report authorizes autonomous assessment and repair, but never makes itself a defect verdict. Code enforces the clean assessment gate, executable contract, auto-merge checks, deployment verification, and resolution; human judgment is reserved for a stated ambiguity or blocker.

Paid generation contracts may declare identical-success reuse. Within one turn, the generic runtime executes the first exact call, retains its successful output, and returns that evidence for an identical repeat without charging the provider or attaching the file again. Distinct arguments still execute normally. This is a contract-owned cost and delivery invariant, not semantic prompt routing.

Every installed capability contract also owns an internal latency budget, defaulted by tool class and overrideable by the focused contract. The budget is not model-facing. Each terminal runtime event records the applicable budget and whether a useful result exceeded it, so slow successful work remains a successful answer while still producing actionable production evidence. Reused results never count as new latency samples.

## Typed results

`AgentResponse` uses human-readable `content` plus optional structured metadata:

- `status`: `ok`, `partial`, or `error`;
- stable `errorCode`;
- `retryable`;
- `limitation`;
- files, tables, footer lines, memory events, or Discord presentation.

Control flow uses these fields and the tool contract, never regex over human prose. Return `partial` when useful work succeeded but a secondary step did not. Return `error` only when the requested capability itself did not complete. Provider-specific exceptions should be mapped into stable domain outcomes near the provider boundary.

## Choosing what to change

When model behavior is wrong, separate the failure before editing:

| Failure | Owning fix |
| --- | --- |
| Wrong capability selected | Contract description, schema, example, or prompt principle |
| Correct tool, weak evidence | Tool implementation or underlying data query |
| Missing Discord fact | Persistence, indexing, permission scope, or retrieval ranking |
| Invalid arguments | Canonical schema clarity or typed validation feedback |
| Invented changing fact | Fresh evidence contract and prompt instruction |
| Duplicate or unsafe mutation | Authority, idempotency, ledger, or provider boundary |
| Correct result, bad reply | Prompt/result wording or Discord renderer |
| Completed work lost after failure | Typed partial outcome or lifecycle recovery |

Do not add keyword routing, phrase-specific recovery, or a canned answer for one prompt. Add a general capability only when the existing primitives cannot express the user outcome.

## Files, images, and generated data

`inspectDiscordFile` performs permission-aware selection and bounded, non-executing inspection. It refreshes Discord attachment URLs and supports text/JSON, Office Open XML, safe ZIP metadata, images, common audio/video transcription, and explicitly supported domain formats. Unknown or proprietary fields are reported as opaque rather than guessed.

Image inspection uses current/replied-to/requested attachments. Operator-supplied avatar and emoji URLs resolve only through public addresses; every redirect is revalidated and response time and bytes are bounded before decoding. Image generation accepts typed reference, size, background, output, aspect-ratio, and required-text controls. Exact typography and transparency are validated; bounded recovery may repair a provider miss, but unsafe opaque output fails closed.

Generated tables and files are referenced through turn-scoped handles. Deterministic tools answer exact count, filter, ranking, and extraction questions instead of asking the model to count visually or reread a large artifact.

## Discord presentation

Plain text is the default. The model may call `composeDiscordResponse` when buttons, selections, forms, files, media, or hierarchy materially improve the result.

The model supplies semantic layout and wording. Code supplies and validates opaque action IDs, schema version, guild/channel/message scope, requester audience, expiry, Discord limits, persistence, and rendering. Generic component clicks cannot directly authorize money, deletion, admin changes, or another protected mutation. A component interaction becomes a new requester-scoped turn containing typed submission data.

Native Discord polls remain the voting primitive. Premium buttons are available only for configured SKU IDs and are never authority checks.

## Delivery and recovery

Discord-visible output flows through `src/discord/responseSink.ts`:

- ingress adds a loading reaction without sending a placeholder answer;
- long-running task progress uses a dedicated editable status message;
- final text, components, files, and footers—including the compact end-to-end request duration—are persisted as a versioned delivery intent before network writes;
- retries reuse stable nonces and message identity;
- restart sweeps replay incomplete delivery obligations;
- missing-message and permission failures are classified and handled without duplicating successful output;
- oversized body text and deterministic footers are chunked independently, so a large proof footer cannot collapse the answer into one-character messages;
- delivery events record the first reply ID, continuation IDs, message count, content size, and footer-line count for debugging and improvement evidence;
- the loading reaction is removed at terminal delivery.

One-shot reminder notifications also use `responseSink.ts`'s canonical Discord write boundary with a stable nonce. `scheduled_reminders` remains authoritative while pg-boss supplies delayed wakeups and minute reconciliation. The reminder worker claims due rows atomically, checks current requester visibility, records each attempt in the runtime ledger, and either commits the Discord message ID, releases a transient failure for retry, or terminalizes a permanent permission/target failure.

Timeout recovery distinguishes unfinished work from already committed work. Completed mutations and generated files can still be delivered after the model runtime times out. An unresolved wager cannot be converted into a generic timeout answer because funds or game state may still require deterministic resolution.

## Verification

For prompt or tool changes, run the closest unit tests, the registry/contract/handler tests, `npm run typecheck`, and `npm run eval -- --dry-run`. Use a live eval only when real model or database behavior is the subject. For delivery changes, cover durable intent, retry identity, restart recovery, and partial failure. For mutations, include idempotency and post-commit failure coverage.
