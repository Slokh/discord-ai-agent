# Documentation Guide

This directory is the durable map for operators, contributors, and coding agents. Start with the smallest path that matches the task; do not read every document before making a focused change.

## New Agent Reading Path

Read these in order before owning a complex feature:

1. [`product-principles.md`](product-principles.md) — who the product is for, the intended experience, and how to make tradeoffs.
2. [`architecture.md`](architecture.md) — production roles, sources of truth, and end-to-end runtime flows.
3. [`../src/README.md`](../src/README.md) — source ownership; continue into the nearest folder README.
4. [`engineering-guide.md`](engineering-guide.md) — feature workflow, testing matrix, debugging, and handoff expectations.
5. [`tool-design.md`](tool-design.md) — required reading when adding or changing model-facing tools.

The root [`AGENTS.md`](../AGENTS.md) contains the concise rules automatically supplied to coding agents. Keep it short enough to remain useful and put deeper explanations here.

## Current Reference

| Document | Use it for |
| --- | --- |
| [`agent-runtime.md`](agent-runtime.md) | Canonical agent sessions, executions, events, artifacts, and code-update task leases. |
| [`evals.md`](evals.md) | Prompt regression suites, private evals, assertions, and comparisons. |
| [`wallets.md`](wallets.md) | Managed-wallet ownership, live balances, transfers, starter funding, wagers, and reconciliation. |
| [`provable-rng.md`](provable-rng.md) | Commit-reveal randomness, reply-chain sessions, verification, and known limitations. |
| [`local-acceptance.md`](local-acceptance.md) | Manual local acceptance checks across Discord and Docker. |
| [`local-kubernetes.md`](local-kubernetes.md) | Optional local Kubernetes full-loop setup. |
| [`eks-deploy.md`](eks-deploy.md) | Production EKS deployment and operational debugging. |

## Direction And History

These documents have different lifecycles. Their status banner is authoritative.

| Document | Status | Purpose |
| --- | --- | --- |
| [`improvement-plan.md`](improvement-plan.md) | Active strategy | Long-term reliability loops and exit criteria; not a prioritized issue tracker. |
| [`continuation-plan.md`](continuation-plan.md) | Completed foundation snapshot | Records the post-hardening observability, latency, retrieval, and quality work that established the current baseline. |
| [`pre-release-plan.md`](pre-release-plan.md) | Completed historical plan | Records the large 2026-07 cleanup and its architectural decisions. Do not treat checked items as current work. |

New prioritized work should live in issues or an explicitly active plan, not by reopening historical checklists without reviewing current architecture.

## Source-Level Maps

Folder READMEs are ownership contracts, not exhaustive API references:

- [`../src/agent/README.md`](../src/agent/README.md) — prompt/model loop and runtime execution.
- [`../src/discord/README.md`](../src/discord/README.md) — Discord ingress, persistence, permissions, and delivery.
- [`../src/tools/README.md`](../src/tools/README.md) — tool families, scoping, file inspection, and self-debugging.
- [`../src/db/README.md`](../src/db/README.md) — durable repositories and query ownership.
- [`../src/execution/README.md`](../src/execution/README.md) — sandboxed code-update execution.
- [`../src/jobs/README.md`](../src/jobs/README.md) — pg-boss jobs and queue handoffs.
- [`../src/payments/README.md`](../src/payments/README.md) — wallet provider, service, and reconciliation.
- [`../src/control/README.md`](../src/control/README.md) and [`../src/control/console/README.md`](../src/control/console/README.md) — internal APIs and run console.

## Documentation Rules

- Document decisions and invariants, not code that is already obvious from a function body.
- Put product-wide behavior in `product-principles.md`, cross-domain runtime flow in `architecture.md`, and implementation ownership in the nearest folder README.
- Update docs in the same PR when a source of truth, permission boundary, feature lifecycle, operator command, or ownership boundary changes.
- Label plans as active, completed, or historical. A checklist with every item checked is not an active roadmap.
- Keep examples generic. Private member names, channels, message links, server facts, and eval prompts belong under `.discord-ai-agent/` or in Postgres.
- Use relative links for repository files and run `npm run docs:check` before publishing documentation changes.
