# Discord Domain

Owns Discord gateway behavior and user-visible Discord message lifecycle.

## Responsibilities

- Bot login, guild scoping, message/reaction/edit/delete events, and mention detection.
- Reply context, request attachments, image metadata, permissions, and channel visibility.
- Response sink for acknowledgements, lazy status messages, final replies, attachments, and cleanup.
- `api.ts` wraps Discord writes (reply/edit/send/react/delete) with shared retry/error classification; user-visible rendering should route through it rather than calling message methods directly.
- Delivery obligations are persisted for in-flight agent-runtime turns and swept on bot startup to complete terminal replies or post a conservative restart notice.
- Queue handoff into durable agent runtime executions.
- Full-server crawl and incremental message persistence.
- Code-update task progress rendering back to Discord.
- Guild emoji uploads use the Discord client callback in `api.ts`, require the guild-level Create Expressions permission, and remain ops-gated at model-tool dispatch.
- The live available guild emoji cache is mapped to exact static/animated mention tokens in `api.ts`. Message/reaction persistence incrementally updates per-channel emoji culture profiles, and the prompt layer loads at most eight high-confidence profiles visible to the requester so replies can use server-local emotes with the server's meaning and tone without raw-history scans or hardcoded names/IDs.
- Unicode `🐛` reaction add/remove events persist a requester-owned bug marker through `bugMarkerReaction.ts`; removing the reaction, emoji, or message clears the marker.
- `deploymentAnnouncements.ts` compares the previous and current deployed revisions, produces casual patch notes from bounded GitHub diff evidence, and posts a prominent Markdown heading with a compact linked version footer once to the configured release-notes channel when the bot becomes ready.

## Change Routing

- User-visible response timing/status bugs start in `responseSink.ts`, then client/task notification wiring.
- Message indexing or deletion behavior starts in `messagePersistence.ts` and `crawler.ts`, then repository storage.
- Permission bugs start in `permissions.ts`, then retrieval filtering.
- Code-update progress rendering starts in `taskNotifications.ts`.
- Bug-marker reaction lifecycle changes start in `bugMarkerReaction.ts`, then the archive/retrieval repositories and `listDiscordBugMarkers` tool.

## Tests

- Discord client behavior: `tests/unit/discord-client.test.ts`.
- Response lifecycle: `tests/unit/discord-response-sink.test.ts`.
- Delivery write/sweep helpers: `tests/unit/discord-api.test.ts` and `tests/unit/discord-delivery-sweep.test.ts`.
- Task rendering: `tests/unit/task-notifications.test.ts`.
- Crawl/persistence: `tests/unit/crawler.test.ts` and `tests/unit/message-persistence.test.ts`.
- Bug-marker reactions: `tests/unit/bug-marker-reaction.test.ts`.
- Deployment notes: `tests/unit/deployment-announcements.test.ts`.

## Structure

`client.ts` is the thin bot entrypoint. Mention parsing, message ingress/persistence, request context, agent-runtime queue handoff, response rendering, and delivery sweeps live in focused sibling modules; add new behavior to the owning module, not `client.ts`.

### Runtime-ledger chat turns

Discord mention handling writes chat-turn execution state to the agent-runtime session ledger only: user transcript message, execution row, runtime events, and replay artifacts. It does not create `process_runs` rows or process-run artifacts for chat turns; the run console reads chat views through the runtime adapter in `src/observability/runs.ts`.
