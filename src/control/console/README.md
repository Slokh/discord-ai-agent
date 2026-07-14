# Run Console Domain

Owns the React debugging UI for runs, traces, artifacts, terminal output, and codegen timelines.

## Responsibilities

- Run list filters, search, and jump-to-run.
- Run overview diagnostics and bottleneck summaries.
- Timeline building, grouping, and rendering.
- `codexTranscript.ts`: Codex app-server transcript parsing for timeline and artifact rendering.
- `timelineText.ts`: pure timeline display names, summary suppression, and requested-tool argument formatting.
- `timelineModel.ts`: pure timeline normalization, de-duplication, timing, and parent/child grouping.
- `runInbox.tsx`, `overviewView.tsx`, and `detailViews.tsx`: focused list and detail surfaces.
- `runDashboard.tsx`, `runComparison.tsx`, and `runFeedback.tsx`: aggregate debugging, purpose-level regression comparison, and private eval capture.
- `promptDebugger.tsx`, `criticalPath.ts`, and `modelCalls.tsx`: exact observed model inputs/outputs, prompt composition, tool rounds, token/cache/cost accounting, and bottleneck recommendations.
- `consoleRouting.ts`: URL state and compatibility redirects for run detail tabs.
- OpenCode transcript formatting currently uses `src/observability/openCodeTranscript.ts`.
- Terminal and artifact viewers.
- A Prompt Debugger for each observed provider call: purpose, revision, token/cache use, estimated cost, prompt/schema composition, offered/requested tools, exact secret-redacted request/response captures, latency, and outcome.
- Prompt captures show observed provider messages and tool schemas. They never claim to expose private chain-of-thought, and older runs without captures remain readable through aggregate telemetry.
- Fixture and live-proxy local development, with Playwright regression coverage in `tests/e2e/console.spec.ts`.

## Change Routing

- Put reusable data derivation in pure helpers so scripts and tests can inspect the same facts.
- Keep transcript parsing in `src/observability/` when it is useful outside the browser.
- Prefer one obvious timeline item per meaningful action; suppress lifecycle noise that repeats the same state.

## Tests

- Timeline and transcript helpers: `tests/unit/run-console-timeline.test.ts`.
- Incremental stream merging: `tests/unit/console-stream-delta.test.ts`.
- Browser workflows: `tests/e2e/console.spec.ts`.
- API data contracts: `tests/unit/internal-api-runs.test.ts`.
- Model-call projection, critical-path analysis, comparison, and routing: `tests/unit/console-model-calls.test.ts`, `tests/unit/console-critical-path.test.ts`, `tests/unit/console-run-comparison.test.ts`, and `tests/unit/console-routing.test.ts`.

## Migration Direction

Keep `App.tsx` as the app shell. New implementation should move into focused components/hooks/utilities for list, overview, timeline, terminal, artifacts, jump search, and formatting.
