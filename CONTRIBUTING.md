# Contributing

## Development Setup

```bash
npm install
docker compose up -d postgres
cp .env.example .env
npm run migrate
npm run dev
```

Use Node.js 22+. The compose Postgres listens on port 5433 for local and DB-backed test flows.

## Navigation

Start with `AGENTS.md` for mandatory workflow rules. Read `docs/product.md`, `docs/architecture.md`, and the single domain guide selected by `docs/README.md`. Source ownership and closest tests are maintained in the architecture guide rather than duplicated across source-folder READMEs.

Keep model-facing changes aligned with `docs/agent-system.md` and repository workflow aligned with `docs/development.md`.

## Validation

Run the focused test first while developing. Before opening a PR, run:

```bash
npm run verify
npm run scan:release
```

`npm run verify` runs lint, typecheck, tests, and `npm audit`. `npm run scan:release` checks for private content and secret leaks and must pass before release.

For DB-backed repository and queue tests, start the compose Postgres on port 5433 and run:

```bash
npm run verify:db
```

For eval schema checks without live model/database-backed regression runs:

```bash
npm run eval -- --dry-run
```

## Pull Requests

Keep PRs small and focused. Bug fixes should add or update a regression test alongside the fix.

Do not commit server-private content. Private prompts, evals, exports, and local agent state belong under `.discord-ai-agent/`; `npm run scan:release` enforces this boundary.

## Security Issues

Report security issues privately according to `SECURITY.md`. Do not open public issues for vulnerabilities.
