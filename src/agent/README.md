# Agent Domain

Owns the model loop for one user prompt.

## Responsibilities

- Build the model input from user text, per-channel memory, reply context, image context, skills, and tool schemas.
- Execute model-selected local tools and hosted OpenRouter tools.
- Record trace spans, tool audit logs, costs, and final response memory.
- Synthesize the final answer and files.
- Record durable agent-runtime prompt executions through `runtimeLedger.ts`; Discord chat turns execute in-process, while sandboxes are reserved for code-update tasks.
- Persist replayable Discord turn context through `runtimeEnvelope.ts` before executing a prompt, so future sandbox executors can deserialize the same request boundary.
- Discord chat prompt execution runs in-process permanently through `runtimeRunner.ts`, `runtimeExecutor.ts`, and `inProcessRuntimeExecutor.ts`; sandboxes are only for code-update tasks.

## Module Map

- `router.ts`: thin compatibility entrypoint; `handleAgentRequest` plus re-exports of `chatMessages`/`toolResultContentForPrompt`.
- `modelLoop.ts`: model round loop, toolset scoping state, route selection, redundant-call guard, direct tool completion.
- `promptBuilder.ts`: system prompt, requester/skills/overlay/session/reply/image prompt sections, tool-result prompt truncation.
- `toolDispatcher.ts`: local tool dispatch and tool-argument coercion.
- `toolGate.ts`: restricted-tool permission gate (owner/ops/codegen allowlists) and per-day budget checks applied before dispatch.
- `finalSynthesis.ts`: forced final synthesis, empty-response recovery, model-call-ceiling fallback, tool-evidence fallback rendering.
- `modelRecovery.ts`: leaked hosted-tool markup detection, stripping, recovery calls, and malformed-output artifacts.
- `invalidToolCallRecovery.ts`: one-shot full-context recovery when a model emits malformed or unavailable function names.
- `modelToolset.ts`: initial scoped tool selection, same-turn tool-group expansion, and image-context checks used by the model loop.
- `randomOutcomeGuard.ts`: detects fresh chance outcomes that lack a successful `drawRandom` result, drives one in-turn retry, and provides the fail-closed response used by the model loop.
- `freshExternalDataGuard.ts`: detects time-sensitive price, fare, schedule, availability, and similar answers that lack fresh web evidence, drives one retrieval retry, and fails closed instead of publishing invented live data.
- `walletStatusGuard.ts`: forces wallet balance prompts through the managed wallet balance tool without capturing bank, game, or unrelated balance requests.
- `walletActionGuard.ts`: forces explicit USD transfer and zero-balance restart prompts through their guarded wallet tools without capturing wagers.
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
