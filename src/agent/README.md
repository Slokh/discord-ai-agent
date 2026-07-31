# Agent Domain

Owns the model loop for one user prompt.

## Responsibilities

- Build the model input from user text, per-channel memory, reply context, image context, skills, and tool schemas.
- Inject the configured current Discord bot name separately from requester and reply-chain identities so self-name questions use the deployed display name rather than an internal service label or another participant.
- Add a compact dynamic custom-emoji culture guide containing at most four ordinary requester-visible, high-confidence profiles (or up to eight explicitly referenced reactions) and exact live mention tokens. Profiles are incrementally learned from human inline usage and reaction targets, relevance-boosted against the current prompt, and let the model choose one inline emote, one validated reaction intent for the source message, or none. Private names, IDs, examples, and reaction directives stay out of the static public prompt and visible reply.
- Execute model-selected local tools and hosted OpenRouter tools.
- Record trace spans, tool audit logs, costs, and final response memory.
- Synthesize the final answer and files.
- Record durable agent-runtime prompt executions through `runtimeLedger.ts`; Discord chat turns execute in-process, while sandboxes are reserved for code-update tasks.
- Persist replayable Discord turn context through `runtimeEnvelope.ts` before executing a prompt, so future sandbox executors can deserialize the same request boundary.
- Discord chat prompt execution runs in-process permanently through `runtimeRunner.ts`, `runtimeExecutor.ts`, and `inProcessRuntimeExecutor.ts`; sandboxes are only for code-update tasks. Runtime deadlines propagate an abort signal through model calls and check it before local tool dispatch so timed-out turns cannot resume later and create side effects.

## Module Map

- `router.ts`: thin request entrypoint; `handleAgentRequest` decorates the model-loop result with turn output and reaction intent.
- `modelLoop.ts`: model round loop, toolset scoping state, route selection, and completion routing.
- `modelLoopRequest.ts`: request preflight, including durable per-guild primary-model loading and the deterministic owner/ops switch/reset route. Compound switch-and-work requests apply or deny the mutation first, then run only the remaining work on the effective model, before final external-data, randomness, and presentation guard enforcement.
- `modelLoopLimit.ts`: observable, bounded completion behavior when the model exhausts the tool-round ceiling.
- `toolRepeatGuard.ts`: canonical tool-call/result signatures and redundant-call audit responses.
- `terminalToolCompletion.ts`: direct terminal-tool responses, including grounded terminal evidence such as image inspection or successful image generation, without a contradictory extra synthesis call.
- `compoundToolCompletion.ts`: keeps generate-and-apply requests open after image generation and forces the requested avatar or custom emoji mutation before completing the turn.
- `promptBuilder.ts`: compact stable product/safety prompt plus requester, current-message mention identities, skills, overlay, session, reply, image, and current-turn sections. All trusted initial system context is emitted before user/assistant session history so provider role ordering remains compatible. `toolGuidance.ts` adds a concise playbook only for the tool groups scoped to the turn, while tool contracts remain canonical. Harmless self-described aliases and server lore are accepted as conversational context without changing the immutable requester used for protected capabilities; a mentioned account uses its live Discord name or mention instead of an unrelated-memory nickname. Top-level mentions use a bounded four-message window containing only the current requester's turns and paired assistant replies. Explicit replies retain their reply chain and can recover only compact tool/action pointers tied to that chain from the same requester's window; unrelated channel memory and prior tool bodies remain excluded. Non-empty retained ancestors are already-available context, so follow-ups should use them instead of asking the user to repeat the chain. `replyContextEvidenceGuard.ts` retries one false draft that denies this already-visible context, while preserving narrow authority for Discord mutations and private facts.
- `toolsetPromptContext.ts`: every post-tool continuation reasserts the exact ingress request as the user message. Internal guidance must never become the apparent task or visible conversation memory; `agent.prompt.request_replaced` is a warning signal for a violated prompt-role invariant.
- `toolDispatcher.ts`: local tool dispatch and tool-argument coercion.
- `toolGate.ts`: restricted administrative-tool permission gate (owner/ops allowlists) applied before dispatch. Model-setting calls additionally require explicit switch/reset intent in the immutable current message; reply or session context cannot supply mutation authority. Code-update starts and retries use the same admission flow for every member.
- `finalSynthesis.ts`: forced final synthesis, empty-response recovery, model-call-ceiling fallback, tool-evidence fallback rendering.
- `modelRecovery.ts`: leaked hosted-tool markup detection, stripping, recovery calls, and malformed-output artifacts.
- `invalidToolCallRecovery.ts`: one-shot full-context recovery when a model emits malformed or unavailable function names.
- `modelToolset.ts`: starts normal turns with a compact capability index, expands only the model-selected tool group in the same turn, and uses attachment presence as the only initial capability fact. Tool definitions, not keyword routing, guide normal tool choice.
- `toolArguments.ts`: conservative JSON parsing plus schema-directed recovery for provider-double-encoded top-level object and array fields; normalized routes remain subject to canonical tool validation.
- `randomOutcomeGuard.ts`: detects fresh chance outcomes that lack a successful `drawRandom` result, treats a rejected/invalid draw attempt as incomplete even when the draft avoids stating an outcome, drives one in-turn retry, and provides the fail-closed response used by the model loop. It consumes typed RNG and wager outcomes from tool handlers rather than parsing human-facing result strings; reply context can identify a continuation but cannot authorize randomness by itself.
- The model requests the `discord-action` capability before using `drawRandom`; the RNG tool still checks immutable current-turn authorization before consuming entropy. This keeps non-game follow-ups from consuming RNG while preserving `again`-style continuations of an earlier verified draw.
- Deferred wagers whose result depends on another member or a future external event stay conversational and never force an immediate empty `drawRandom` call.
- `modelTimeoutFallback.ts`: trims oldest conversational history for one configured chat-fallback retry. The retry keeps the current scoped tools available even after earlier tools gathered evidence, so it can finish an unresolved artifact or action instead of collapsing the turn to a text-only answer; the normal repeat guards and per-turn model-call ceiling keep that recovery bounded.
- `providerRejectionFallback.ts`: retries one primary provider-specific 400/422 request rejection with the configured recovery model, records the reason, and keeps the remainder of that turn on recovery.
- `modelPolicy.ts`: applies the durable per-guild primary-model override when present, otherwise the configured primary conversational model, reasoning effort, and completion budget. The model loop selects the independently configured recovery model for malformed/empty output, repeated-tool termination, or one bounded retry after a provider-specific 400/422 request rejection; once a provider rejects the primary request, the remainder of that turn stays on recovery.
- `parallelToolExecution.ts`: checks whether one model round's read-only tool calls are independent and executes the eligible batch concurrently with normal tool telemetry.
- `freshExternalDataGuard.ts`: detects time-sensitive price, fare, schedule, launch/playability, availability, current sports-roster/transaction, and similar answers that lack fresh web evidence. It rejects contradictory relative/explicit dates and current-catalog nonexistence claims when citations do not cover the exact denied item, drives one web-search-only retrieval retry, and fails closed instead of publishing invented live data.
- `memberAvailabilityGuard.ts`: rejects precise current/future online, free-time, or playing predictions inferred from a Discord mention or request timestamp, retries once for a concise coordination answer, and then fails closed without inventing another member's schedule.
- `publicUrlEvidenceGuard.ts`: requires hosted fetch/search evidence when a user asks to inspect a public URL in the immutable current message or direct human-authored reply parent, including after a model timeout fallback, and fails closed instead of publishing an unsupported access disclaimer. Bot-authored trace links and older reply ancestors do not become the subject of unrelated transformations; configured run-console links remain first-party runtime references routed to permission-filtered local inspection instead of public web retrieval.
- Failed local inspection attempts do not satisfy public-URL evidence. In particular, an HTML page misrouted to image inspection returns a typed tool error so the model can pivot to the verified hosted-search recovery instead of failing the turn.
- `imageEvidenceGuard.ts`: forces `inspectDiscordImages` for causal visual follow-ups to a directly replied image and retries one false model-authored image-access refusal when a permission-visible current or reply-chain image is already available.
- `imageGenerationGuard.ts`: retries one explicit, unfulfilled image create/edit request by adding the image tool group and forcing `generateImage`; terse follow-ups and visual correction feedback are accepted only when current, reply-chain, or recent channel context establishes an image-generation thread.
- Reply-chain URLs require current-turn language that actually targets the link (for example, “summarize this link” or “what is this?”). An unrelated question does not inherit URL-inspection intent merely because an ancestor contains a public URL.
- `hostedCitationLinkGuard.ts`: preserves one safe provider citation when hosted web evidence produced a final answer that explicitly promises a link or source but omitted every usable URL. Existing links and ordinary grounded answers are left unchanged.
- `richPresentationOutcomeGuard.ts`: fails closed when rich presentation composition was attempted but no validated presentation reached the turn-output collector, preventing text from claiming missing controls.
- `capabilityClaimGuard.ts`: corrects narrow model-authored contradictions of deterministic deployed facts. It turns false media-transcription refusals with no attached input into an accurate attachment/reply request, answers explicit runtime-model identity questions from the model identifier returned by the active call, and rejects or canonicalizes model-switch completion claims against turn-scoped mutation evidence.
- `walletStatusGuard.ts` and `walletActionGuard.ts`: retain execution-time scope and authorization validation for managed-wallet operations; normal-language requests reach them through model-selected tools rather than forced model-loop routes.
- `routerShared.ts`: `AgentToolRoute`/`ModelCallBudget` types, round/call ceilings, `reserveModelCall`, and defense-in-depth cleanup for obsolete internal history labels.
- `runtimeTranscript.ts`: single event-recording helper for trace events, spans, audits, and runtime transcript appends.

## Change Routing

- Tool choice problems usually start in `src/tools/registry.ts`; tool behavior problems route through `src/tools/README.md` to the focused implementation module that owns the selected tool family.
- Prompt composition and memory/reply/image context problems start here.
- Agent session/execution state transitions start in `runtimeLedger.ts`; execution input payloads start in `runtimeEnvelope.ts`; both are called by Discord ingress/delivery or the sandbox executor caller.
- Agent session execution queue handoffs start in `runtimeControlPlane.ts`; Discord ingress and `/api/agent/sessions/:threadKey/execute` should share this path so durable execution metadata and events stay consistent.
- Worker prompt concurrency is configurable, but `KeyedSerialQueue` preserves strict ordering within each Discord thread key.
- Prompt executor behavior starts in `runtimeExecutor.ts` and `inProcessRuntimeExecutor.ts` before touching `router.ts`; do not add chat prompt sandbox transports.
- Discord rendering problems belong in `src/discord/responseSink.ts`, not the model loop.
- Discord formatting knowledge belongs in prompt guidance, not response-specific branches. Teach the model what Discord markdown supports, then let it choose formatting when it improves chat clarity. The renderer owns automatic trace footers.

## Tests

- End-to-end agent behavior: `tests/integration/agent.test.ts`.
- Prompt composition and context budgets: `tests/unit/prompt-context-cost.test.ts`.
- Toolset/route behavior: `tests/unit/model-toolset.test.ts` and `tests/unit/model-tool-routes.test.ts`.
- Runtime ledger, envelope, runner, and executor: `tests/unit/agent-runtime-*.test.ts`, `tests/unit/runtime-envelope-lines.test.ts`, and `tests/unit/in-process-runtime-executor.test.ts`.
- High-consequence guards: focused `tests/unit/*-guard.test.ts` files plus `tests/unit/random-tools.test.ts`.
- Post-deploy prompt debugging: [`../../docs/deployment-debugging.md`](../../docs/deployment-debugging.md) documents the script-first audit and exact reply-chain workflow.
- Tool schema/behavior: `tests/unit/tool-registry.test.ts` and the focused tool-family tests listed in `src/tools/README.md`.

## Discord chat runtime ledger

Discord chat prompt executions are canonical agent-runtime sessions/executions. Ingress must have an `AgentRuntimeRepository`, appends the user transcript message, stores turn-envelope/input-lines artifacts, and enqueues via `enqueueAgentRuntimeSessionExecution`. Process runs are not a chat-turn fallback.
