# Tools Domain

Owns model-facing local tool contracts and implementations.

## Responsibilities

- `registry.ts`: names, descriptions, schemas, examples, output contracts, and tool taxonomy exposed to the model.
- `agentTaskTools.ts`: model-facing code-update task creation, status, retry/cancel, deployment status, and task log snippets.
- `agentTaskFormatting.ts`: code-update task titles, task result messages, compact timing/cache lines, and shared duration formatting.
- `discordHistoryFormatting.ts`: Discord history search syntax, date coercion, no-results text, and history evidence/summary formatting.
- `discordFileTools.ts`: permission-aware Discord attachment selection, fresh CDN URL resolution, bounded downloads, inspection events, and audit logging.
- `fileInspection.ts`: bounded in-memory file detection and parsing for text, JSON, Office Open XML, ZIP, images, PDFs, unknown binaries, and iRacing `.sto` setup notes.
- `discordStatsFormatting.ts`: Discord stats and channel-topic output formatting, metric parsing, and topic clustering helpers.
- `generatedFileTools.ts`: current-turn generated file/table access and CSV/table querying for artifacts produced by earlier tool calls.
- `imageTools.ts`: Discord image inspection, reference image collection, image generation, and generated-file conversion.
- `responseFormatting.ts`: shared final-response cleanup, Markdown-table normalization, and Discord length trimming used by the agent router and Discord renderers.
- `skillTools.ts`: private skill draft/update generation, policy validation, database persistence, and skill audit logging.
- `spotifyTools.ts`: Spotify Web API client-credentials integration for public catalog search, item details, playlist/album track attachments, artist discographies, playlist stats, and playlist comparisons with current API limits and sanitized stored output.
- `spendTools.ts`: ops spend summaries from `tool_audit_logs.estimated_cost_usd`, including today/month totals and top tool/user breakdowns.
- `walletTools.ts`: conversational shared-wallet lifecycle status and authorized reconciliation, plus optional per-user game-wallet balance when enabled.
- `discordOpsTools.ts`: reply-aware, permission-filtered self-debugging through `inspectAgentLogs`, including normalized run evidence and optional bounded redacted model I/O.
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

`registry.ts` assigns each model-facing tool to a coarse `group`: `core`, `discord-retrieval`, `generated-data`, `discord-action`, `image`, `spotify`, `codegen`, `ops`, or `external`. `toolScope.ts` deterministically selects groups per turn. Ordinary chat begins with the two core escalation/help tools, `drawRandom`, and hosted web/date tools. `drawRandom` is the one action tool offered on every turn because vague replies and prompt overlays can require verifiable chance without repeating a randomness keyword. When `USER_WALLETS_ENABLED=false`, deployment scoping removes user-wallet actions and the optional wager field from `drawRandom`; bot balance reads remain available when the shared wallet is enabled. Other Discord action schemas, retrieval, and generated-data tools are added only when the request indicates those capabilities.

Scoping is controlled by `TOOLSET_SCOPING` (default `true`). When wallet-backed wagers are enabled, `settleRandomWager` is always paired with `drawRandom` so a reserved wager cannot become impossible to settle in the same turn. Spotify tools are deployment-gated and only appear when `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are configured; codegen tools are similarly hidden unless a real GitHub repository is configured. The hidden `requestAdditionalTools` core tool is an escalation valve: if the model notices a missing capability, it can request specific groups (or all groups), and the next model round in the same turn is recomputed with the expanded toolset. Its schema enumerates the valid group names. An invalid group request expands all deployment-available groups and reports the invalid names instead of silently leaving the model without the capability it needs.

## Discord File Inspection

`inspectDiscordFile` accepts a Discord message link/ID or uses attachments from the current request and reply chain. Explicit historical messages are resolved through permission-filtered indexed attachment metadata, then refreshed through the Discord API before download so expired CDN URLs do not become permanent failures. Up to eight matches totaling 20 MiB are inspected in one bounded batch by default. Identical extracted content and common metadata are emitted once so related setup/document collections do not multiply prompt tokens.

Inspection is bounded and non-executing: downloads are limited to 20 MiB, archive entry names and expansion sizes are validated, extracted text is capped, and file content is marked as untrusted model evidence. The parser registry currently provides:

- UTF-8/UTF-16 text and normalized JSON, including common source/config/data extensions.
- DOCX, PPTX, and XLSX text extraction plus safe generic ZIP listings.
- Image detection that directs visual questions to `inspectDiscordImages`.
- PDF container metadata and explicit notice that semantic PDF text extraction is not yet available.
- Bounded printable-string fallback for unknown binary formats.
- iRacing `.sto` opaque-container metadata, high-entropy payload identity, filename-derived qualifying/race/wet hints, and structured embedded UTF-16 setup notes. Garage values remain opaque and must never be inferred from the notes or characterized as compressed, encoded, or encrypted without verified evidence.
- iRacing Garage HTML exports, including exact simulator-decoded setup sections and values such as pressures, temperatures, ride heights, springs, damping, camber, toe, brake bias, fuel, aero, differential, and in-car controls when present for that car.
- iRacing SDK `.ibt` telemetry session data, including exact loaded `CarSetup` values and bounded track, weather, and setup context when `irsdkLogSetup=1` recorded the setup.

For exact iRacing values, load the `.sto` in the simulator and attach either a Garage HTML export, an `.ibt` telemetry recording containing SDK `CarSetup` data, or clear Garage screenshots. HTML is the smallest deterministic interchange format; `.ibt` adds session context; screenshots use the existing image-inspection path. The offline `.sto` parser remains useful for file identity, purpose/weather filename hints, opaque-payload comparison, and embedded notes, but it is not presented as setup analysis.

Successful fetches and inspections record `discord.file.fetched` and `discord.file.inspected` runtime events with byte count, parser, type, latency, and extracted-character count. Failures record `discord.file.fetch_failed`. Raw extracted content is not written to audit summaries or event metadata.

## Discord Self-Debugging

Authorized operators can reply to a request or bot response with prompts such as `debug this` or `why did you do that?`. The ops toolset is enabled for terse debugging replies, and `inspectAgentLogs` resolves the reply root/direct parent to a requester-visible run when no explicit identifier is supplied. Its summary prioritizes model rounds, prompt-section weight, token/cache use, requested tools, and critical-path gaps before normalized trace/task/command evidence. `detail=model_io` is reserved for explicit prompt/input/output inspection and loads only artifacts belonging to the already-authorized run; contents are redacted again and truncated before entering the model context.
