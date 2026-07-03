# Evaluation Harness

Use evals to keep Discord AI Agent improvements evidence-driven. The harness runs real prompts through the existing `npm run prompt` path, records the answer, pulls trace/tool evidence when a trace id is available, and writes a timestamped report.

## Run Evals

```bash
npm run eval
npm run eval -- --dry-run
npm run eval -- --list
npm run eval -- --category history
npm run eval -- --filter job
```

Reports are written to `.eval-runs/<timestamp>/`, which is gitignored.

The default suite is intentionally safe for committed source. Costly or mutating cases, such as image generation and codegen PR creation, are documented but skipped.

## Private Server Evals

Put server-specific prompts in `.discord-ai-agent/evals/*.json` and run:

```bash
npm run eval -- --include-private
```

`.discord-ai-agent/` is gitignored. Use it for prompts containing private usernames, channels, Discord links, or server-specific facts.

## Suite Format

```json
{
  "version": 1,
  "name": "private-regressions",
  "prompts": [
    {
      "id": "history-job-hunting",
      "category": "history",
      "prompt": "what have people said about job hunting or interviewing?",
      "expectedTools": ["searchDiscordHistory"],
      "expectedRequestedTools": [],
      "mustContain": ["interview"],
      "mustNotContain": ["Sources:"],
      "notes": "Should answer conversationally without dumping citation blocks."
    }
  ]
}
```

Supported prompt fields:

- `id`: stable unique id.
- `category`: grouping, such as `history`, `stats`, `web`, `image`, `codegen`, or `ops`.
- `prompt`: text passed to `npm run prompt`.
- `expectedTools`: local tools that must be observed in trace/tool audit evidence.
- `expectedRequestedTools`: local or hosted tools that must be observed in model-requested tool calls, such as `openrouter:web_search`.
- `mustContain`: case-insensitive answer substrings.
- `mustNotContain`: case-insensitive forbidden answer substrings.
- `maxLatencyMs`: optional latency ceiling for the prompt.
- `promptArgs`: extra `scripts/prompt.ts` arguments, such as `--channel=general`.
- `noMemory`: defaults to `true`.
- `useDiscordMemory`: defaults to `false`.
- `timeoutMs`: per-prompt timeout override.
- `skip` and `skipReason`: document prompts that should not run by default.

## Interpreting Results

Each result includes:

- final answer
- run id / trace id
- observed requested tools
- observed selected local tools
- audited tool calls
- deterministic assertion failures
- latency

The Markdown summary includes requested, selected local, and audited tool evidence inline for each prompt. Failed/error cases also include a short answer or error preview so tool-choice failures are visible without opening `results.json` first.

Use failed evals to decide whether the next change should target tool descriptions, tool output shape, retrieval ranking, prompt context, codegen context packaging, or observability. See `docs/tool-design.md` for the tool contract rules that should guide those changes.
