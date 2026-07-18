# Agent Domain

Owns the model loop for one user prompt.

## Responsibilities

- Build the model input from user text, per-channel memory, reply context, image context, skills, and tool schemas.
- Add a compact dynamic custom-emoji culture guide containing at most eight requester-visible, high-confidence profiles and exact live mention tokens. Profiles are incrementally learned from human inline usage and reaction targets, relevance-boosted against the current prompt, and let the model choose one inline emote, one validated reaction intent for the source message, or none. Private names, IDs, examples, and reaction directives stay out of the static public prompt and visible reply.
- Execute model-selected local tools and hosted OpenRouter tools.
- Record trace spans, tool audit logs, costs, and final response memory.
- Synthesize the final answer and files.
- Record durable agent-runtime prompt executions through `runtimeLedger.ts`; Discord chat turns execute in-process, while sandboxes are reserved for code-update tasks.
- Persist replayable Discord turn context through `runtimeEnvelope.ts` before executing a prompt, so future sandbox executors can deserialize the same request boundary.
- Discord chat prompt execution runs in-process permanently through `runtimeRunner.ts`, `runtimeExecutor.ts`, and `inProcessRuntimeExecutor.ts`; sandboxes are only for code-update tasks. Runtime deadlines propagate an abort signal through model calls and check it before local tool dispatch so timed-out turns cannot resume later and create side effects.

## Module Map

- `router.ts`: thin compatibility entrypoint; `handleAgentRequest` plus re-exports of `chatMessages`/`toolResultContentForPrompt`.
- `modelLoop.ts`: model round loop, toolset scoping state, route selection, and direct tool completion.
- `toolRepeatGuard.ts`: canonical tool-call/result signatures and redundant-call audit responses.
- `promptBuilder.ts`: system prompt, requester/skills/overlay/session/reply/image prompt sections, tool-result prompt truncation.
- `toolDispatcher.ts`: local tool dispatch and tool-argument coercion.
- `toolGate.ts`: restricted-tool permission gate (owner/ops/codegen allowlists) and per-day budget checks applied before dispatch.
- `finalSynthesis.ts`: forced final synthesis, empty-response recovery, model-call-ceiling fallback, tool-evidence fallback rendering.
- `modelRecovery.ts`: leaked hosted-tool markup detection, stripping, recovery calls, and malformed-output artifacts.
- `invalidToolCallRecovery.ts`: one-shot full-context recovery when a model emits malformed or unavailable function names.
- `modelToolset.ts`: initial scoped tool selection, same-turn tool-group expansion, and image-context checks used by the model loop.
- `randomOutcomeGuard.ts`: detects fresh chance outcomes that lack a successful `drawRandom` result, drives one in-turn retry, and provides the fail-closed response used by the model loop.
- `modelTimeoutFallback.ts`: trims oldest conversational history for the one safe utility-model retry allowed before tools execute, and performs tool-free utility-model synthesis when the primary model times out after tools have already gathered evidence.
- `freshExternalDataGuard.ts`: detects time-sensitive price, fare, schedule, availability, and similar answers that lack fresh web evidence, drives one retrieval retry, and fails closed instead of publishing invented live data.
- `walletStatusGuard.ts`: forces wallet balance prompts through the managed wallet balance tool without capturing bank, game, or unrelated balance requests.
- `modelLoop.ts` runs requester-scoped automatic starter funding before model/tool selection; `walletActionGuard.ts` still forces explicit USD transfers and fallback restart prompts through guarded wallet tools without capturing wagers.
- `deterministicWalletRoute.ts`: executes balance-guard routes directly against managed wallet tools without a model-selection hop, then gives the verified evidence to normal conversational synthesis while preserving tool transcripts and telemetry.
- `routerShared.ts`: `AgentToolRoute`/`ModelCallBudget` types, round/call ceilings, `reserveModelCall`.
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
- Tool schema/behavior: `tests/unit/tool-registry.test.ts` and `tests/unit/core-tools.test.ts`.

## Discord chat runtime ledger

Discord chat prompt executions are canonical agent-runtime sessions/executions. Ingress must have an `AgentRuntimeRepository`, appends the user transcript message, stores turn-envelope/input-lines artifacts, and enqueues via `enqueueAgentRuntimeSessionExecution`. Process runs are not a chat-turn fallback.
