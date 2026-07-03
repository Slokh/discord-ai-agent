# Discord Domain

Owns Discord gateway behavior and user-visible Discord message lifecycle.

## Responsibilities

- Bot login, guild scoping, message/reaction/edit/delete events, and mention detection.
- Reply context, request attachments, image metadata, permissions, and channel visibility.
- Response sink for acknowledgements, lazy status messages, final replies, attachments, and cleanup.
- Queue handoff into durable agent runtime executions.
- Full-server crawl and incremental message persistence.
- Codegen task progress rendering back to Discord.

## Change Routing

- User-visible response timing/status bugs start in `responseSink.ts`, then client/task notification wiring.
- Message indexing or deletion behavior starts in `messagePersistence.ts` and `crawler.ts`, then repository storage.
- Permission bugs start in `permissions.ts`, then retrieval filtering.
- Code-update progress rendering starts in `taskNotifications.ts`.

## Tests

- Discord client behavior: `tests/unit/discord-client.test.ts`.
- Response lifecycle: `tests/unit/discord-response-sink.test.ts`.
- Task rendering: `tests/unit/task-notifications.test.ts`.
- Crawl/persistence: `tests/unit/crawler.test.ts` and `tests/unit/message-persistence.test.ts`.

## Migration Direction

Keep `client.ts` as the bot entrypoint. New implementation should separate mention parsing, event handlers, request context, agent-runtime queue handoff, response rendering, and trace recording.
