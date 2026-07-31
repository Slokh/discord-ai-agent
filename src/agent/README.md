# Agent Domain

Owns the retained NanoCodex turn for one requester-scoped Discord prompt.

## Responsibilities

- Build NanoCodex instructions and prompt input from the immutable requester, current message, permission-visible session context, reply chain, attachments, skills, and private overlays.
- Run the pinned native NanoCodex engine with one stable deployment-safe tool schema and Nano's hosted web search.
- Route every application tool call through the existing argument validation, permission, budget, money, randomness, and mutation gates.
- Store Nano session checkpoints losslessly in the canonical `agent_runtime_*` ledger and resume only within the same scoped session.
- Translate Nano's typed events into bounded run-console telemetry without exposing private reasoning.
- Enforce live-data, provable-randomness, rich-presentation, response-length, file, footer, and emoji-reaction boundaries before Discord delivery.
- Propagate hard and silence deadlines into Nano cancellation so timed-out turns cannot execute late side effects.

## Runtime Shape

`runtimeRunner.ts` and `runtimeExecutor.ts` select `NanoCodexAgentRuntimePromptExecutor`. `nanocodexAgentRuntime.ts` prepares the turn, loads the latest checkpoint, exposes the stable tool contract, dispatches requested tools, applies deterministic guards, and stores the next checkpoint. `nanocodexRuntime.ts` owns the versioned NDJSON child-process protocol; `native/nanocodex-runtime` embeds the exact pinned Rust library and native HTTPS Responses transport.

The deployed Discord agent defaults to Luna with high reasoning. This reasoning policy is fixed in `modelPolicy.ts`; owner/ops model switching remains limited to the interactive Sol/Luna catalog.

Discord transcript messages remain the inspectable product history. A Nano checkpoint is opaque execution state, not a second user-facing history. On the first Nano turn for an existing session, the bounded product transcript seeds the session; subsequent turns send only the current request and resume the checkpoint.

## Module Map

- `nanocodexAgentRuntime.ts`: retained turn orchestration, prompt preparation, stable tool exposure, tool-result collection, checkpoint lifecycle, and outcome guards.
- `nanocodexRuntime.ts`: strict protocol client, model validation, process lifecycle, cancellation, typed event forwarding, and tool-call bridge.
- `nanocodexSessionState.ts`: lossless canonical checkpoint persistence and validation.
- `runtimeTimeouts.ts`: shared hard/silence timeout and abort propagation.
- `promptBuilder.ts`: requester, skills, overlay, session, reply, attachment, date, and emoji instruction sections.
- `toolDispatcher.ts`: canonical local dispatch after contract and restricted-tool gates.
- `toolGate.ts`: requester-scoped permission and daily-budget checks.
- `runtimeLedger.ts`, `runtimeEnvelope.ts`, `runtimeTranscript.ts`: durable execution identity, replayable Discord input, events, audits, and tool transcript records.
- `randomOutcomeGuard.ts`, `freshExternalDataGuard.ts`, `richPresentationOutcomeGuard.ts`: fail-closed high-consequence output checks.
- `activeGameSession.ts`: scoped wallet-game continuation state injected into the current turn.

The complete engine/application ownership contract and parity rules are in `docs/nanocodex-foundation.md`.

## Change Routing

- Tool availability and model contracts start in `src/tools/registry.ts`; implementations route through `src/tools/README.md`.
- Tool authorization or deterministic behavior changes start in `toolDispatcher.ts`, `toolGate.ts`, or the owning money/randomness module—not in Nano prompts.
- Prompt context changes start in `promptBuilder.ts`; Nano lifecycle and event changes start in `nanocodexAgentRuntime.ts` or the native runtime protocol.
- Session/execution transitions start in `runtimeLedger.ts`; Discord rendering remains in `src/discord/responseSink.ts`.
- Code-update workspace behavior belongs to `src/execution/README.md`; it uses the same native runtime with Nano workspace tools enabled.

## Tests

- Native protocol and retained executor: `tests/unit/nanocodex-runtime.test.ts`, `tests/unit/nanocodex-agent-runtime.test.ts`, and `tests/unit/nanocodex-session-state.test.ts`.
- Prompt composition and context budgets: `tests/unit/prompt-context-cost.test.ts`.
- Tool contracts, dispatch, permissions, and high-consequence guards: focused `tests/unit/*tool*.test.ts` and `tests/unit/*guard.test.ts` suites.
- Runtime ledger/envelope/runner: `tests/unit/agent-runtime-*.test.ts`, `tests/unit/runtime-envelope-lines.test.ts`, and repository integration tests.
