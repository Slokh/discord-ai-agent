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
- Codegen task progress rendering back to Discord.

## Change Routing

- User-visible response timing/status bugs start in `responseSink.ts`, then client/task notification wiring.
- Message indexing or deletion behavior starts in `messagePersistence.ts` and `crawler.ts`, then repository storage.
- Permission bugs start in `permissions.ts`, then retrieval filtering.
- Code-update progress rendering starts in `taskNotifications.ts`.

## Tests

- Discord client behavior: `tests/unit/discord-client.test.ts`.
- Response lifecycle: `tests/unit/discord-response-sink.test.ts`.
- Delivery write/sweep helpers: `tests/unit/discord-api.test.ts` and `tests/unit/discord-delivery-sweep.test.ts`.
- Task rendering: `tests/unit/task-notifications.test.ts`.
- Crawl/persistence: `tests/unit/crawler.test.ts` and `tests/unit/message-persistence.test.ts`.

## Structure

`client.ts` is the thin bot entrypoint. Mention parsing, message ingress/persistence, request context, agent-runtime queue handoff, response rendering, and delivery sweeps live in focused sibling modules; add new behavior to the owning module, not `client.ts`.

### Runtime-ledger chat turns

Discord mention handling writes chat-turn execution state to the agent-runtime session ledger only: user transcript message, execution row, runtime events, and replay artifacts. It does not create `process_runs` rows or process-run artifacts for chat turns; the run console reads chat views through the runtime adapter in `src/observability/runs.ts`.
