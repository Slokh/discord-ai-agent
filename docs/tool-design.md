# Tool Design

The bot should stay model-led: users write normal `@ai ...` prompts, the model chooses tools, and the codebase improves tool descriptions, schemas, outputs, and evals instead of adding prompt-specific branching.

## Tool Taxonomy

Every model-facing tool has a class in `src/tools/registry.ts`. The class and output contract are injected into the function description sent to the model.

| Class | Purpose |
| --- | --- |
| `resolver` | Resolve names, channels, mentions, or IDs before another tool uses structured filters. |
| `retrieval` | Return permission-filtered evidence from Discord history, context, or attachments. |
| `memory` | Read or mutate agent conversation memory and durable learned facts. |
| `stats` | Return aggregates, rankings, counts, rates, and grouped metrics. |
| `summary` | Synthesize grounded Discord history over a bounded sample/window. |
| `image` | Inspect, search, or understand existing Discord images/attachments. |
| `generation` | Create new model-generated artifacts such as images. |
| `coding` | Start, inspect, retry, or cancel durable code-update tasks. |
| `ops` | Diagnose bot/runtime/deployment status. |
| `external` | Use hosted OpenRouter tools for web, URL fetch, or current datetime data. |

Use classes to audit whether a new user problem is missing a real primitive or whether an existing tool contract is unclear.

## Output Contracts

Each local tool contract includes an `outputContract`. This is the model-facing promise for the shape of useful output. Tool implementations should keep outputs compact but include the fields needed for the model to answer directly:

- Retrieval tools should include applied filters, ranked evidence snippets, message links when available, and result counts.
- Stats tools should include metric, grouping, filters, ranked rows, and result counts.
- Summary tools should include focus/question, sample window, grounded summary, and coverage limits.
- Coding tools should include task status, run-console link when available, progress summary, and PR link or failure reason.
- Ops/debug tools should include requested diagnostic, current status, recent failures, and a next action when one is clear.

If a tool cannot satisfy its output contract, return an explicit limitation instead of forcing the model to infer missing context.

## Change Workflow

Before changing prompts or tool behavior:

1. Add or update an eval prompt that represents the failure mode.
2. Decide whether the failure is tool choice, tool schema, tool output shape, retrieval ranking, prompt context, or missing data.
3. Prefer improving the tool contract or result shape before adding a new tool.
4. Avoid hidden special cases for exact message text. If a branch is needed, it should generalize to a stable tool capability.
5. Run `npm run eval -- --dry-run` for schema checks and `npm run eval` when live DB/OpenRouter-backed validation is intended.

Private server prompts, names, channels, or message links belong in `.discord-ai-agent/evals`, not committed fixtures.
