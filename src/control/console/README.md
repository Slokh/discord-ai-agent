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
- `runDashboard.tsx`, `runComparison.tsx`, and `runFeedback.tsx`: aggregate debugging, regression comparison, and private eval capture.
- OpenCode transcript formatting currently uses `src/observability/openCodeTranscript.ts`.
- Terminal and artifact viewers.
- A Models view for each observed provider call: purpose, revision, token/cache use, estimated cost, prompt/schema size, offered/requested tools, latency, and outcome.
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
- Model-call projection: `tests/unit/console-model-calls.test.ts`.

## Migration Direction

Keep `App.tsx` as the app shell. New implementation should move into focused components/hooks/utilities for list, overview, timeline, terminal, artifacts, jump search, and formatting.
