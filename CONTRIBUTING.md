# Contributing

## Development Setup

```bash
npm install
cargo install --locked --path native/nanocodex-runtime
docker compose up -d postgres
cp .env.example .env
npm run migrate
npm run dev
```

Use Node.js 22.19+ and Rust 1.97 (`rust-toolchain.toml`). The worker (`npm run worker`) starts the nanocode host from `PATH`. The compose Postgres listens on port 5433 for local and DB-backed test flows.

## Navigation

Start with `AGENTS.md` for mandatory workflow rules. Read `docs/product.md`, `docs/architecture.md`, and the single domain guide selected by `docs/README.md`. Source ownership and closest tests are maintained in the architecture guide rather than duplicated across source-folder READMEs.

Keep model-facing changes aligned with `docs/agent-system.md` and repository workflow aligned with `docs/development.md`.

## Validation

Run the focused test first while developing. Before opening a PR, run:

```bash
npm run verify
npm run scan:release
```

`npm run verify` runs lint, typecheck, tests, `npm audit`, docs and generated-config checks, and the release scan. `npm run scan:release` checks for private content and secret leaks and must pass before release.

For DB-backed repository and queue tests, start the compose Postgres on port 5433 and run:

```bash
npm run verify:db
```

For eval schema checks without model calls:

```bash
npm run eval -- --dry-run
```

For prompt, tool, or model changes, run the public suite three times and compare with the base revision (see `docs/development.md`):

```bash
npm run eval -- --repeat 3
```

For changes under `native/nanocodex-runtime/`, run the cargo checks and `npx vitest run tests/native` listed in `docs/development.md`.

## Pull Requests

Keep PRs small and focused. Bug fixes should add or update a regression test alongside the fix.

Do not commit server-private content. Private prompts, evals, exports, and local agent state belong under `.discord-ai-agent/`; `npm run scan:release` enforces this boundary.

## Security Issues

Report security issues privately according to `SECURITY.md`. Do not open public issues for vulnerabilities.
