# Agent Domain

Owns the model loop for one user prompt.

## Responsibilities

- Build the model input from user text, per-channel memory, reply context, image context, skills, and tool schemas.
- Execute model-selected local tools and hosted OpenRouter tools.
- Record trace spans, tool audit logs, costs, and final response memory.
- Synthesize the final answer and files.
- Record durable agent-runtime prompt executions through `runtimeLedger.ts` while the sandbox-backed runtime migration proceeds.
- Persist replayable Discord turn context through `runtimeEnvelope.ts` before executing a prompt, so future sandbox executors can deserialize the same request boundary.
- Select prompt execution backends through `runtimeRunner.ts` and `runtimeExecutor.ts`; the current default calls `inProcessRuntimeExecutor.ts`, while the warm-sandbox executor spawns `sandboxPromptRunner.ts` through the serialized envelope protocol.

## Change Routing

- Tool choice problems usually start in `src/tools/registry.ts`; tool behavior problems route through `src/tools/README.md` to the focused implementation module behind the `coreTools.ts` facade.
- Prompt composition and memory/reply/image context problems start here.
- Agent session/execution state transitions start in `runtimeLedger.ts`; execution input payloads start in `runtimeEnvelope.ts`; both are called by Discord ingress/delivery or the sandbox executor caller.
- Runtime backend selection changes start in `runtimeRunner.ts`; prompt executor behavior starts in `runtimeExecutor.ts`; child-runner behavior starts in `sandboxPromptRunner.ts`; compatibility model-loop changes start at `inProcessRuntimeExecutor.ts` before touching `router.ts`.
- Discord rendering problems belong in `src/discord/responseSink.ts`, not the model loop.

## Tests

- End-to-end agent behavior: `tests/integration/agent.test.ts`.
- Tool schema/behavior: `tests/unit/tool-registry.test.ts` and `tests/unit/core-tools.test.ts`.

## Migration Direction

Keep `router.ts` as the compatibility entrypoint. New implementation should separate prompt building, model rounds, local tool execution, hosted tool handling, memory writes, and final synthesis.
