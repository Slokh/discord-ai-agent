# Improvement Plan

> **Status: active strategy.** This document defines the long-term reliability loops and exit criteria. It is not a prioritized issue tracker; confirm current work in open issues/PRs and the present architecture before implementing an unchecked idea.

The original pre-release hardening checklist is complete and retained in [`pre-release-plan.md`](pre-release-plan.md) as architectural history. The completed post-hardening foundation is recorded in [`continuation-plan.md`](continuation-plan.md).

## North Star

The bot should be reliable in three loops:

1. Answer normal Discord questions with grounded server/web/image context.
2. Let the model choose the right tools without prompt-specific code branches.
3. Safely improve itself through observable code-update PRs.

## Phase 1: Quality Foundation

- Maintain `npm run eval` as the regression loop for answer quality, tool choice, latency, and grounding.
- Keep committed evals generic and safe.
- Store private server evals under `.discord-ai-agent/evals`.
- Add eval prompts before broad retrieval, prompt, tool, or codegen changes.

Exit criteria: a change can be compared against known troublesome prompts before it is merged.

## Phase 2: Tool Architecture

- Keep model-facing tool contracts explicit in `src/tools/registry.ts`.
- Classify tools by capability: resolver, retrieval, memory, stats, summary, image, generation, coding, ops, or external.
- Remove redundant tools when a clearer primitive exists.
- Optimize slow tools by changing the underlying implementation, not by adding hidden prompt branches.

Exit criteria: the model has clear primitives and evals can identify incorrect tool choice.

## Phase 3: Retrieval And Memory

- Persist enough Discord data to avoid refetching from the Discord API for normal reindexing.
- Version embedding model/config/dimensions so reindex decisions are explicit.
- Use hybrid retrieval: structured filters, keyword search, vector search, and permission filtering.
- Precompute or cache expensive summaries/topics when repeated broad queries become slow.
- Continue expanding image/attachment understanding.

Exit criteria: Discord history, image, and recap questions are grounded, permission-safe, and fast enough for normal chat.

## Phase 4: Code-Update Reliability

- Keep the execution backend swappable across harnesses.
- Improve repo context packaging, prompt structure, progress reporting, and failure classification before changing models.
- Support local end-to-end coding-agent tests that can produce diffs without Kubernetes.
- Require code-update tasks to produce a PR or a clear failure reason.

Exit criteria: a normal `@ai update yourself to ...` request usually produces a useful PR, and failures are actionable.

## Phase 5: Observability Console

- Make timelines explain the critical path without duplicate noise.
- Inline relevant artifacts where they occur.
- Show model calls, tool calls, command logs, diffs, retries, errors, and latency per step.
- Support lookup by Discord message link/id.
- Keep aggregate views for slowest runs, failing tools, long model calls, and codegen failure reasons.

Exit criteria: any Discord message or task run can be debugged from the console without manual database spelunking.

The foundation now includes typed runtime events and spans, incremental stream deltas, model/tool/cost telemetry, aggregate dashboards, side-by-side comparison, run feedback, and private-eval export. Future console work should build on those contracts instead of parsing event names or adding another snapshot projection.

## Phase 6: Production Hardening

- Keep deployment, queue, crawl, embedding, and sandbox health observable.
- Track model/tool costs by run.
- Add retention policies for large artifacts and logs.
- Keep open-source code, docs, evals, and history free of private server/member details.

Exit criteria: the bot can run unattended at hobby-project cost, with clear diagnostics when something fails.
