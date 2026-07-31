# NanoCodex Foundation

Status: active architecture. Discord chat, local prompt/evals, and sandboxed code updates use the same embedded native runtime.

The Discord agent is built around the pinned [`Slokh/nanocodex`](https://github.com/Slokh/nanocodex) fork. The release has one agent engine: NanoCodex. This is a replacement, not a compatibility layer; the custom OpenRouter chat loop and one-shot coding CLI harness have been removed.

## Ownership boundary

NanoCodex owns:

- retained model sessions, typed history, compaction, cache identity, retries, and cancellation;
- the model/tool loop, tool-call ordering, steering, forks, and child-agent lifecycle;
- typed model, reasoning, tool, usage, cost, and terminal events;
- code-mode and workspace execution for code-update tasks.

The application owns:

- immutable Discord requester identity, reply-chain scope, and current channel visibility;
- tool availability, argument validation, permission gates, and audit records;
- wallet authority, receipt verification, fee sponsorship, wagers, and provable randomness;
- durable `agent_runtime_*` sessions, executions, messages, events, Nano snapshots, and delivery obligations;
- Discord acknowledgements, progress, final replies, files, components, and cleanup;
- repository credentials, verification policy, release scanning, and Git publication.

The boundary is deliberately asymmetric: NanoCodex may decide to call a tool, but only the application can authorize and perform a Discord, money, randomness, administrative, or publication action.

## Runtime shape

`native/nanocodex-runtime` embeds the exact pinned NanoCodex Rust library and uses its native HTTPS Responses transport with OpenRouter. `src/agent/nanocodexRuntime.ts` owns the process lifetime and the versioned application protocol. Tool calls cross that private boundary and enter the existing deterministic dispatcher; raw credentials never enter the model-visible shell environment.

Each accepted prompt has exactly one terminal protocol result. Protocol versions and request IDs are validated before any result is accepted. An abort terminates the native runtime, and late tool calls still encounter the application's abort and authorization gates.

Nano snapshots are opaque authoritative checkpoints. They must be stored losslessly in the canonical runtime ledger and resumed only for the same scoped agent session. Application conversation messages remain the durable, inspectable product transcript; a Nano snapshot is execution state, not a second user-history product.

## No legacy release state

The architecture is kept clean by enforcing all of the following:

- Discord chat and local prompt/eval runs invoke NanoCodex directly; the custom `modelLoop` no longer exists.
- Code-update work uses the same native Nano runtime; the image does not install or invoke a separate Nano CLI.
- Agent execution does not use `OpenRouterClient.chat`, hosted-tool markup recovery, manual model-round retry logic, or harness-selection abstractions. Direct provider calls remain only behind deterministic tool APIs pending their own Nano-native utility conversion.
- Discord chat defaults to Luna with high reasoning, code updates default to Terra with medium reasoning, and utility reasoning uses Luna with high reasoning. The owned NanoCodex fork supports Sol, Terra, and Luna; requester-visible server overrides remain limited to Sol and Luna. Separate deterministic APIs such as embeddings, transcription, and image generation remain direct provider clients because they are tools, not alternate agent engines.
- The container contains the application Nano runtime and no Codex, OpenCode, or generic agent-harness binaries.
- Documentation and tests describe only the Nano architecture; there are no fallback flags or dual-runtime rollout modes.

## Feature-parity invariants

The retained feature set is protected by these invariants:

1. Discord conversation context, replies, mentions, attachments, skills, overlays, and concise response delivery.
2. A stable deployment-safe tool schema for cache reuse, with every call revalidated against current requester scope and deployment availability.
3. Permission-filtered retrieval, live-data enforcement, and cited external lookup.
4. Wallet reads and mutations, starter grants, admin authority, receipt verification, wagering, and provable randomness.
5. Discord mutations, rich components, generated files, image work, Spotify, operations, memory, and task control.
6. Durable execution events, exact terminal state, token/cache/cost accounting, replayable snapshots, cancellation, and run-console visibility.
7. Sandboxed code updates, progress, safe credentials, verification, release scan, diff validation, and publication handoff.
8. Unit, integration, database, eval dry-run, production build, and container verification.

No invariant is satisfied by adding an alternate runtime fallback. Missing behavior is implemented at the Nano/application ownership boundary.
