# Discord AI Agent Local Acceptance Checklist

Use this after `.env` contains the real Discord, OpenRouter, and GitHub secrets.

## Preflight

```bash
npm run preflight
```

Expected:

- `preflight` stops at the first failed check and prints the step name.
- `doctor` reports all checks as `ok`.
- `smoke:discord` logs in and finds the configured guild.
- `smoke:discord` reports `bot administrator permission: no`.
- `smoke:discord` fails if the bot currently has Administrator, because this milestone validates member-level access.
- `smoke:discord` reports crawl/send/thread/attach permission counts for bot-visible channels and fails if none are usable for a required capability.
- `smoke:openrouter` verifies chat and embeddings.
- `smoke:github` verifies the configured repo/base branch.
- `clear-commands` removes any stale `/ai` guild commands from Discord.

## Live Discord Checks

Start the bot:

```bash
npm run dev
```

Optionally start or refresh history indexing from another terminal:

```bash
npm run crawl
# or reset cursors and crawl again
npm run reindex
# enqueue missing/stale embeddings for background processing
npm run embeddings:backfill
```

`npm run crawl` stores messages and enqueues embeddings instead of waiting for OpenRouter per message. During a large import, `@ai status` should show crawl progress and an embedding backlog that drains while `npm run worker` or `DISCORD_AI_AGENT_PROCESS_ROLE=all npm run dev` is running. Self-update PR work is started by the worker as a Kubernetes sandbox task, while the bot keeps the Discord reply open and edits it with phase progress plus the final PR link or failure/no-change result.

Then verify in Discord:

```text
@ai hello
@ai what can you do
@ai tools
@ai status
@ai undo
@ai undo 3
@ai what is a haiku?
@ai what did we say about pizza?
@ai what did we say in #general about pizza?
@ai what did @someone say about pizza since 2024-01-01?
@ai what did we say about definitely-not-a-real-topic-12345?
@ai next world cup match?
@ai summarize this thread
@ai make an image of a wizard eating nachos
@ai what image did we generate earlier?
@ai read the attached JSON file and summarize it
@ai what does this file contain? (as a reply to a message with one attachment)
@ai inspect setup.sto and explain the embedded setup notes
@ai compare all of these iRacing setup files
@ai decode the exact values in this iRacing Garage HTML setup export
@ai analyze the exact loaded setup in this iRacing .ibt telemetry file
@ai learn this for next time: movie night votes are decided by the poll
@ai update skill movie night: ties are settled by whoever hosted last
@ai add a tool to check the Minecraft server status
```

Expected:

- Mentions get natural-language replies.
- Ordinary questions can get normal chat replies without forcing a history search.
- Current external questions can use OpenRouter-hosted web/time tools without custom command syntax.
- `@ai what can you do` and `@ai tools` list available tools without requiring command knowledge.
- `@ai status` reports database, crawl, embedding backlog, tool, and cost status.
- `@ai undo` removes Discord AI Agent's last channel reply from persistent memory and attempts to delete the bot reply; `@ai undo 3` removes the last three turns, capped at 10.
- `npm run blocked-users -- block <user-id>` prevents that user from triggering Discord AI Agent replies.
- Discord AI Agent has no Discord slash commands in this milestone.
- Terminal crawls report progress through `@ai status` as indexed data grows.
- History answers are conversational by default and only show compact sources when explicitly requested.
- History questions with no matching indexed evidence say so clearly and do not invent an answer.
- Mentioned-channel history questions only search that channel and visible public threads under it.
- Mentioned-user history questions filter to that author.
- Date-filtered history questions use the absolute date filters.
- Thread summaries respect current channel visibility and deleted content.
- Image requests return an image or image URL.
- Same-channel follow-ups can use Discord AI Agent's previous replies and tool results without forcing a history search.
- Current-message and replied-to files are selected without requiring a message link; explicit historical links remain permission-filtered.
- Text, JSON, Office Open XML, ZIP, and supported binary formats return bounded extracted evidence and an honest parser limitation. `.sto` files expose embedded setup notes without inventing opaque garage values.
- Safely bounded multi-file replies are inspected in one tool call, with identical notes/content and common metadata emitted once.
- iRacing Garage HTML exports and SDK `.ibt` files containing `CarSetup` expose exact simulator-reported values; `.sto` files direct users to HTML, `.ibt`, or Garage screenshots when exact pressures, cambers, springs, damping, aero, or other garage values are required.
- File fetch and parser activity appears in the run trace as `discord.file.*` events, without raw attachment contents in audit summaries.
- Skill requests create or update a private database skill after policy validation.
- Tool requests run through a sandbox task and finish with a human-review PR link, or a clear no-change/failure response.

## Permission Checks

```text
@ai what did we say in #some-channel about pizza?
```

Expected:

- Users cannot retrieve messages from channels they cannot currently view.

## Docker App Check

With `.env` present:

```bash
docker compose up --build app
```

Expected:

- The app container runs migrations, starts the queue, logs into Discord, and responds to `@ai`.
- Run `docker compose run --rm app node dist/scripts/crawl.js` to crawl from Docker; keep a worker process running to process queued embeddings.

For the separate bot/worker topology:

```bash
docker compose up --build bot worker
```

Expected:

- The bot process logs into Discord and responds to `@ai`.
- The worker process starts the pg-boss worker for future background jobs.
