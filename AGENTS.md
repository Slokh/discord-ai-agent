# Discord AI Agent Coding Guide

This repo is a TypeScript Discord AI agent with durable code-update tasks. Keep changes small, tested, and aligned with the existing model-led tool architecture.

## Workflow

- Use `rg` first, then read the smallest set of files needed to make the next concrete edit.
- For bug fixes, add or update a focused regression test before or alongside the fix.
- Do not spend the whole run inspecting. Once the relevant flow is clear, make the smallest useful test or implementation edit.
- Run the most relevant test first. Use `npm run typecheck` or `npm run verify` when the change is broad enough.
- Do not commit, push, open PRs, or mutate GitHub state from inside a code-update task; the sandbox runner handles that.

## Core Flows

- Discord mentions enter through `src/discord/client.ts`, then route through `src/agent/router.ts`.
- Model-selected tools live in `src/tools/registry.ts` and `src/tools/coreTools.ts`.
- Durable code-update tasks are enqueued from `src/tools/coreTools.ts`, processed in `src/jobs/queue.ts`, launched by `src/execution/backend.ts`, executed by `src/execution/sandboxRunner.ts`, and rendered back to Discord by `src/discord/taskNotifications.ts`.
- Agent task state, trace events, command events, artifacts, and run-console data are persisted in `src/db/repositories.ts`.
- The run console API is in `src/control/internalApi.ts`; the React console lives under `src/control/console/`.

## Design Preferences

- Prefer improving tool schemas/results/prompts over hidden message-specific branching.
- Preserve permission filtering for Discord history.
- Keep private server assumptions out of generic open-source behavior.
- Make observability explicit: important latency, retries, failures, and external calls should become spans, events, command logs, or artifacts.
