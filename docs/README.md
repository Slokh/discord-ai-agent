# Documentation

These guides describe the current system. They are organized by durable concepts, not by the repository's history or by individual source folders.

## Reading paths

For a first contribution, read:

1. [Product](product.md) for the user experience and model/code boundary.
2. [Architecture](architecture.md) for processes, data flow, sources of truth, and code ownership.
3. [Development](development.md) for investigation, implementation, testing, and PR workflow.

Then open only the guide that owns the change:

| Change | Guide |
| --- | --- |
| Prompts, model behavior, tools, images, Discord presentation | [Agent system](agent-system.md) |
| Discord history, retrieval, memory, database, privacy, retention | [Data](data.md) |
| Wallets, transfers, wagers, games, randomness | [Payments and games](payments.md) |
| Code-update tasks, sandboxes, GitHub publication | [Code updates](code-updates.md) |
| Bugs, friction, reports, evidence, acceptance contracts | [Improvement cases](improvements.md) |
| Local setup, deployment, sandbox callbacks, production debugging | [Operations](operations.md) |
| Accepted environment variables and their ownership | [Configuration](configuration.md) |

## Guide contracts

- [Product](product.md) explains what the system should do and which boundaries must hold.
- [Architecture](architecture.md) explains what runs, how a request moves, where state lives, and which modules own it.
- [Agent system](agent-system.md) explains NanoCodex, prompt assembly, tools, typed outcomes, rich responses, and delivery recovery.
- [Data](data.md) explains Discord indexing, permission-filtered retrieval, conversation memory, the runtime ledger, privacy, migrations, and retention.
- [Payments and games](payments.md) explains managed wallets, transfer authority, receipt verification, wager state, settlement, and provable RNG.
- [Code updates](code-updates.md) explains how a conversational request becomes a sandboxed, verified pull request.
- [Improvement cases](improvements.md) explains unified intake, coalescing, evidence, contracts, work linkage, verification, and resolution.
- [Operations](operations.md) explains configuration, process roles, local and Kubernetes operation, observability, and incident investigation.
- [Single-node K3s production](architecture/single-node-k3s.md) records the production infrastructure decision, security boundary, recovery path, alternatives, and kill criteria.
- [Configuration](configuration.md) is generated from the runtime manifest and lists every accepted deployment variable.
- [Development](development.md) explains how agents should navigate, change, test, evaluate, and document the repository.

## Documentation rules

Documentation is part of the implementation contract:

- Describe current behavior in present tense. Git history and closed PRs preserve migration history.
- Prefer one complete conceptual guide over a README in every source directory.
- Name the canonical data owner and the main source entry points, but do not inventory every file.
- Put credentials and deployment inputs in `.env.example`; put stable product and architecture settings in `src/config/env.ts`.
- Put server-specific prompts, examples, Discord content, and evals in `.discord-ai-agent/` or Postgres, never in tracked docs.
- Update the owning guide when a source of truth, trust boundary, lifecycle, or operator workflow changes.
- Keep links relative and run `npm run docs:check` before publication.

The root `README.md` is the installation-oriented project overview. `AGENTS.md` is the mandatory task router. `CONTRIBUTING.md` and `SECURITY.md` contain contribution and vulnerability-reporting policy. Everything else belongs in this folder unless it is inseparable from an infrastructure module.
