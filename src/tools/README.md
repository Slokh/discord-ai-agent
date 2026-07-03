# Tools Domain

Owns model-facing local tool contracts and implementations.

## Responsibilities

- `registry.ts`: names, descriptions, schemas, examples, output contracts, and tool taxonomy exposed to the model.
- `coreTools.ts`: current compatibility facade for local tool implementations.
- `agentTaskTools.ts`: model-facing code-update task creation, status, retry/cancel, deployment status, and task log snippets.
- `agentTaskFormatting.ts`: code-update task titles, task result messages, compact timing/cache lines, and shared duration formatting.
- `discordHistoryFormatting.ts`: Discord history search syntax, date coercion, no-results text, and history evidence/summary formatting.
- `discordStatsFormatting.ts`: Discord stats and channel-topic output formatting, metric parsing, and topic clustering helpers.
- `imageTools.ts`: Discord image inspection, reference image collection, image generation, and generated-file conversion.
- `responseFormatting.ts`: shared final-response cleanup and Discord length trimming used by the agent router and Discord renderers.
- `skillTools.ts`: private skill draft/update generation, policy validation, database persistence, and skill audit logging.
- `toolContext.ts`: shared tool-context helpers such as requester-visible indexed channels and Discord message-id parsing.
- Discord resolvers, history/retrieval, stats/topics, images/vision, skills, code-update tasks, task status, logs, deployment status, and response cleanup.

## Change Routing

- If the model chose the wrong capability, update tool descriptions/schema/examples and add a registry or agent test.
- If the tool returned weak data, update the implementation and closest domain query.
- If the requested behavior is durable storage/indexing/retrieval, fix the owning data lifecycle first; do not rely on prompt/tool wording alone.
- If adding a new tool, add registry metadata, implementation, audit behavior, and at least one unit or integration test.

## Tests

- Tool schemas and taxonomy: `tests/unit/tool-registry.test.ts`.
- Tool behavior: `tests/unit/core-tools.test.ts`.
- End-to-end model/tool behavior: `tests/integration/agent.test.ts`.

## Migration Direction

Keep `src/tools/coreTools.ts` as a compatibility facade. New implementation should move into focused modules by tool family: resolvers, retrieval, stats, image, skills, coding, and ops.
