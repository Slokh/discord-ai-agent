# Control Plane Domain

Owns internal HTTP APIs, sandbox callbacks, metrics, and debugging surfaces.

## Responsibilities

- Authenticated run-console APIs under `/api/runs`.
- Sandbox task callbacks and artifact ingestion.
- Generic agent session APIs under `/api/agent/sessions` and agent-task status under `/api/tasks/status`.
- Metrics, model-call cost/latency accounting, secret-redacted prompt/response artifacts, and lightweight HTML fallback pages.
- React run console source under `console/`.

## Change Routing

- API shape changes start in the focused `internalApi*` owner: `internalApi.ts` for route dispatch, `internalApiParsers.ts` for boundary validation, `internalApiAuth.ts` for authentication, `internalApiStreams.ts` for SSE, and `internalApiServer.ts` for lifecycle. Then update console API clients and tests.
- Centaur-style runtime work should add agent-session behavior under `/api/agent/sessions`.
- Run normalization and diagnostics usually belong in `src/observability/` before React rendering.
- Console-only layout changes belong under `src/control/console/`.

## Tests

- API behavior: `tests/unit/internal-api.test.ts`.
- Run API snapshots: `tests/unit/internal-api-runs.test.ts`.
- Console derivation/render helpers: `tests/unit/run-console-timeline.test.ts`, `tests/unit/console-model-calls.test.ts`, `tests/unit/console-critical-path.test.ts`, and `tests/unit/console-run-comparison.test.ts`.

## Boundaries

Keep HTTP transport, authentication, parsing, streaming, metrics, and server lifecycle independent. `internalApi.ts` dispatches authenticated domain operations and must not become a compatibility facade.
