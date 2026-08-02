# Agent system

This guide covers the model runtime, prompt construction, tool contracts, typed results, Discord presentation, and delivery recovery. The trust boundary comes from [Product](product.md); the end-to-end request path is in [Architecture](architecture.md).

## NanoCodex boundary

The pinned native runtime under `native/nanocodex-runtime/` embeds the project NanoCodex fork and communicates with OpenRouter. It owns:

- retained model sessions and typed history;
- compaction, prompt-cache identity, retries, and cancellation;
- model/tool ordering and hosted web search;
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

`src/agent/nanocodexRuntime.ts` owns the versioned process protocol. Request IDs, protocol versions, and terminal results are validated. Aborts terminate the process, and late tool calls still meet the application's abort and authority gates. Opaque NanoCodex snapshots are stored losslessly and resumed only when the session, model, instructions, and tool contract are compatible.

## Prompt construction

`src/agent/promptBuilder.ts` builds two layers:

- stable instructions: product behavior, tool-use principles, formatting rules, and invariant reminders;
- turn context: requester identity, current message, reply chain, attachments, mentions, visible Discord context, memory, active game, loaded skills, and server overlay.

The current message is always the operative request. Prior messages and retrieved content are untrusted context, not new authority. Tool output is bounded before returning to the model; larger durable content stays in artifacts or generated-file/table handles.

Static prompt skills live in `skills/`. The model can load one exact skill through `loadSkillContext`. Deployment-specific guidance belongs in the untracked prompt overlay or Postgres server overlay. The runtime does not create or mutate database-backed skills.

## Models

Configuration is validated in `src/config/env.ts`:

- Discord chat defaults to Luna with high reasoning.
- Utility reasoning defaults to Luna with high reasoning.
- Code updates default to Terra with medium reasoning.
- Owner/ops may set a per-guild conversational override to Sol or Luna through the guarded model tool.

Embeddings, image generation, and transcription are direct provider-backed tools. They are not alternate agent engines.

## Tool contract

The model receives one stable list of deployed capabilities. `src/tools/toolScope.ts` removes only tools unavailable in the deployment, such as unconfigured Spotify, code-update, or wallet features. `toolDeployment.ts` may narrow a canonical schema to configured capabilities, such as premium Discord SKU IDs or wager fields.

Each local tool is defined in a focused file under `src/tools/contracts/` and declares:

- name, purpose, category, group, and semantic class;
- canonical JSON Schema;
- whether it mutates;
- deployment requirement and access policy;
- output promise, permission requirements, audit events, and examples.

`src/tools/registry.ts` aggregates contracts. It must not become a switchboard for behavior. `toolContractValidation.ts` compiles the advertised schemas and validates canonical examples. `src/agent/toolHandlers/` binds every registered tool to exactly one focused adapter; startup fails for missing, duplicate, or unknown handlers.

## Tool execution

For each selected tool:

1. Confirm the name exists in the current deployment toolset.
2. Parse and validate arguments against the advertised schema.
3. Apply current requester, deployment, permission, access, abort, and high-consequence gates.
4. Execute the focused implementation.
5. Record audit and runtime events.
6. Return bounded model-facing evidence and collect files, tables, footers, or presentation output.

The generic boundary may unwrap a JSON-encoded object or array only when the schema explicitly requires that top-level type. It does not translate domain protocols, coerce scalar intent, invent fields, or repair prose with regex.

Mutating tools require explicit current-user intent and must be idempotent or durably deduplicated where repetition would be harmful. A successful mutation is retained immediately. If the model, audit write, balance refresh, or final synthesis later fails, the runtime delivers the committed result with a partial limitation instead of inviting a duplicate retry.

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

Image inspection uses current/replied-to/requested attachments. Image generation accepts typed reference, size, background, output, aspect-ratio, and required-text controls. Exact typography and transparency are validated; bounded recovery may repair a provider miss, but unsafe opaque output fails closed.

Generated tables and files are referenced through turn-scoped handles. Deterministic tools answer exact count, filter, ranking, and extraction questions instead of asking the model to count visually or reread a large artifact.

## Discord presentation

Plain text is the default. The model may call `composeDiscordResponse` when buttons, selections, forms, files, media, or hierarchy materially improve the result.

The model supplies semantic layout and wording. Code supplies and validates opaque action IDs, schema version, guild/channel/message scope, requester audience, expiry, Discord limits, persistence, and rendering. Generic component clicks cannot directly authorize money, deletion, admin changes, or another protected mutation. A component interaction becomes a new requester-scoped turn containing typed submission data.

Native Discord polls remain the voting primitive. Premium buttons are available only for configured SKU IDs and are never authority checks.

## Delivery and recovery

Discord-visible output flows through `src/discord/responseSink.ts`:

- ingress adds a loading reaction without sending a placeholder answer;
- long-running task progress uses a dedicated editable status message;
- final text, components, files, and footers are persisted as a versioned delivery intent before network writes;
- retries reuse stable nonces and message identity;
- restart sweeps replay incomplete delivery obligations;
- missing-message and permission failures are classified and handled without duplicating successful output;
- the loading reaction is removed at terminal delivery.

Timeout recovery distinguishes unfinished work from already committed work. Completed mutations and generated files can still be delivered after the model runtime times out. An unresolved wager cannot be converted into a generic timeout answer because funds or game state may still require deterministic resolution.

## Verification

For prompt or tool changes, run the closest unit tests, the registry/contract/handler tests, `npm run typecheck`, and `npm run eval -- --dry-run`. Use a live eval only when real model or database behavior is the subject. For delivery changes, cover durable intent, retry identity, restart recovery, and partial failure. For mutations, include idempotency and post-commit failure coverage.
