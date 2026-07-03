# Control Plane Domain

Owns internal HTTP APIs, sandbox callbacks, metrics, and debugging surfaces.

## Responsibilities

- Authenticated run-console APIs under `/api/runs`.
- Sandbox task callbacks and artifact ingestion.
- Codegen session APIs.
- Metrics and lightweight HTML fallback pages.
- React run console source under `console/`.

## Change Routing

- API shape changes start in `internalApi.ts`, then update console API clients and tests.
- Run normalization and diagnostics usually belong in `src/observability/` before React rendering.
- Console-only layout changes belong under `src/control/console/`.

## Tests

- API behavior: `tests/unit/internal-api.test.ts`.
- Run API snapshots: `tests/unit/internal-api-runs.test.ts`.
- Console derivation/render helpers: `tests/unit/run-console-timeline.test.ts`.

## Migration Direction

Keep large API/console entrypoints as facades. New implementation should separate route handlers, auth helpers, run APIs, callback APIs, and React view modules.
