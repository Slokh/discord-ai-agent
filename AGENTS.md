# Discord AI Agent Coding Guide

This repo is a TypeScript Discord AI agent with durable code-update tasks. Keep changes small, tested, and aligned with the existing model-led tool architecture.

## Workflow

- Use `rg` first, then read the smallest set of files needed to make the next concrete edit.
- For bug fixes, add or update a focused regression test before or alongside the fix.
- Do not spend the whole run inspecting. Once the relevant flow is clear, make the smallest useful test or implementation edit.
- Use the folder README files as navigation. They define ownership boundaries and closest tests; do not compensate for unclear ownership by scanning giant files.
- Run the most relevant test first. Use `npm run typecheck` or `npm run verify` when the change is broad enough.
- Do not commit, push, open PRs, or mutate GitHub state from inside a code-update task; the sandbox runner handles that.

## Core Flows

- Discord mentions enter through `src/discord/client.ts`, then route through `src/agent/router.ts`.
- Discord-visible acknowledgements, lazy status replies, final replies, files, and loading-reaction cleanup should go through `src/discord/responseSink.ts`.
- Replayable Discord turn payloads for durable/sandbox execution are built in `src/agent/runtimeEnvelope.ts`.
- Agent-runtime backend selection and prompt executor behavior live in `src/agent/runtimeRunner.ts` and `src/agent/runtimeExecutor.ts`.
- Model-selected tool contracts live in `src/tools/registry.ts`; `src/tools/coreTools.ts` is the compatibility facade for focused tool-family modules.
- Durable agent sessions are exposed through `src/db/agentRuntimeRepository.ts` and `/api/agent/sessions/:threadKey`; code-update tasks are currently a compatibility path through `src/tools/agentTaskTools.ts`, `src/jobs/queue.ts`, `src/execution/backend.ts`, and `src/execution/sandboxRunner.ts`.
- Agent runtime sessions, task state, trace events, command events, artifacts, and run-console data are persisted through `src/db/agentRuntimeRepository.ts` and `src/db/repositories.ts`.
- The run console API is in `src/control/internalApi.ts`; the React console lives under `src/control/console/`.
- Read `docs/architecture.md`, `docs/improvement-plan.md`, `docs/tool-design.md`, and the closest `src/**/README.md` before broad codegen, retrieval, observability, or Discord-flow changes.
- Use `npm run eval -- --dry-run` for eval schema checks, and `npm run eval` when live OpenRouter/DB-backed regression runs are intended.
- For Centaur-style runtime work, prefer generic agent-session changes over new codegen-only paths.

## Ownership Map

- Discord ingress and message lifecycle: `src/discord/README.md`.
- Model loop and conversation assembly: `src/agent/README.md`.
- Model-facing tool contracts and implementations: `src/tools/README.md`.
- Durable data, retrieval, tasks, runs, traces, and skills: `src/db/README.md`.
- Code-update sandbox and harness runtime: `src/execution/README.md`.
- Run console API and React debugging UI: `src/control/README.md` and `src/control/console/README.md`.

If a request changes Discord knowledge, indexing, embeddings, retrieval, stats, summaries, or attachment search, start from the durable data/indexing owners before changing tool descriptions.

## Design Preferences

- Prefer improving tool schemas/results/prompts over hidden message-specific branching.
- Keep every model-facing tool aligned with the taxonomy and output contracts in `docs/tool-design.md`.
- Preserve permission filtering for Discord history.
- Keep private server assumptions out of generic open-source behavior.
- Put private eval prompts under `.discord-ai-agent/evals`, not committed `evals/prompts`.
- Make observability explicit: important latency, retries, failures, and external calls should become spans, events, command logs, or artifacts.
- Keep new source files focused. If a file starts accumulating multiple domains, split it before adding another feature.
