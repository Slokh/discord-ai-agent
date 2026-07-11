# Tools Domain

Owns model-facing local tool contracts and implementations.

## Responsibilities

- `registry.ts`: names, descriptions, schemas, examples, output contracts, and tool taxonomy exposed to the model.
- `agentTaskTools.ts`: model-facing code-update task creation, status, retry/cancel, deployment status, and task log snippets.
- `agentTaskFormatting.ts`: code-update task titles, task result messages, compact timing/cache lines, and shared duration formatting.
- `discordHistoryFormatting.ts`: Discord history search syntax, date coercion, no-results text, and history evidence/summary formatting.
- `discordStatsFormatting.ts`: Discord stats and channel-topic output formatting, metric parsing, and topic clustering helpers.
- `generatedFileTools.ts`: current-turn generated file/table access and CSV/table querying for artifacts produced by earlier tool calls.
- `imageTools.ts`: Discord image inspection, reference image collection, image generation, and generated-file conversion.
- `responseFormatting.ts`: shared final-response cleanup and Discord length trimming used by the agent router and Discord renderers.
- `skillTools.ts`: private skill draft/update generation, policy validation, database persistence, and skill audit logging.
- `spotifyTools.ts`: Spotify Web API client-credentials integration for public catalog search, item details, playlist/album track attachments, artist discographies, playlist stats, and playlist comparisons with current API limits and sanitized stored output.
- `spendTools.ts`: ops spend summaries from `tool_audit_logs.estimated_cost_usd`, including today/month totals and top tool/user breakdowns.
- `toolContext.ts`: shared tool-context helpers such as requester-visible indexed channels and Discord message-id parsing.
- Discord resolvers, history/retrieval, stats/topics, images/vision, skills, code-update tasks, task status, logs, deployment status, and response cleanup.
- Restricted expensive/mutating tools are gated in the router before dispatch: codegen defaults to owner-only when `BOT_OWNER_USER_ID` is set, avatar updates and per-user turn limits (`setUserTurnLimit`) use the ops allowlist, and image generation can opt into the ops allowlist.

## Change Routing

- If the model chose the wrong capability, update tool descriptions/schema/examples and add a registry or agent test.
- If the tool returned weak data, update the implementation and closest domain query.
- If the requested behavior is durable storage/indexing/retrieval, fix the owning data lifecycle first; do not rely on prompt/tool wording alone.
- If adding a new tool, add registry metadata, implementation, audit behavior, and at least one unit or integration test.

## Tests

- Tool schemas and taxonomy: `tests/unit/tool-registry.test.ts`.
- Tool behavior: `tests/unit/core-tools.test.ts`.
- End-to-end model/tool behavior: `tests/integration/agent.test.ts`.

## Structure

Implementation lives directly in focused modules by tool family: Discord resolvers/retrieval/summary/ops, agent memory, generated files, images, skills, code-update tasks, spend, Spotify, and response formatting. Add new tools to the owning family module and expose them through `registry.ts`.

## Tool Groups and Scoped Toolsets

`registry.ts` assigns each model-facing tool to a coarse `group`: `core`, `discord-retrieval`, `generated-data`, `discord-action`, `image`, `spotify`, `codegen`, `ops`, or `external`. `toolScope.ts` deterministically selects groups per turn. Ordinary chat begins with only the two core escalation/help tools plus hosted web/date tools; Discord retrieval, generated-data, and action schemas are added only when the request indicates those capabilities.

Scoping is controlled by `TOOLSET_SCOPING` (default `true`). Spotify tools are deployment-gated and only appear when `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are configured; codegen tools are similarly hidden unless a real GitHub repository is configured. The hidden `requestAdditionalTools` core tool is an escalation valve: if the model notices a missing capability, it can request specific groups (or all groups), and the next model round in the same turn is recomputed with the expanded toolset.
