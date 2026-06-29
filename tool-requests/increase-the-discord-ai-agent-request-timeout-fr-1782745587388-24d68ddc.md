# Tool Proposal: increase-the-discord-ai-agent-request-timeout-fr

Requested by kartik (87002447687467008).

## Request

Increase the Discord AI Agent request timeout from 90 seconds (90000ms) to 5 minutes (300000ms) so that multi-tool requests like batched summarizeDiscordHistory calls don't get killed mid-execution.

## Review Notes

- This is a proposal PR only.
- Discord AI Agent must not auto-merge tool or code changes.
- A human should review the intended API, credentials, safety boundary, and tests before implementation.