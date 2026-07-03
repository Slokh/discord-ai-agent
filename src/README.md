# Source Architecture Map

Use this map before broad repository exploration. Each folder README owns the detailed navigation for that domain.

## Start Here

- `discord/`: Discord gateway events, mention detection, reply context, permissions, response rendering, crawl, and live message persistence.
- `agent/`: Model loop, conversation memory assembly, tool calls, hosted tools, final answer synthesis, and trace spans for a single prompt.
- `tools/`: Model-facing local tool contracts and implementations.
- `db/`: Durable Postgres access for Discord history, embeddings, skills, tasks, run console data, traces, and workflows.
- `memory/`: Retrieval orchestration, message normalization, and embedding workers.
- `execution/`: Code-update sandbox runtime, harness prompts/config, git/cache operations, artifacts, failure diagnosis, and PR packaging.
- `control/`: Internal API, metrics, sandbox callbacks, and run console.
- `observability/`: Run normalization, codegen status, redaction, artifact retention, and terminal-first inspection helpers.

## Agent-Friendly Rules

- Prefer the closest domain README over scanning a large barrel file.
- Preserve compatibility facades, but put new implementation in the owning domain module.
- For Discord knowledge/indexing changes, start at storage/crawl/persistence/retrieval boundaries before model-facing tool text.
- For codegen latency/reliability changes, inspect execution context, prompt rendering, harness events, and run diagnostics before changing models.
- For UI observability changes, keep data derivation separate from React rendering so diagnostics can be reused by scripts and the bot.
