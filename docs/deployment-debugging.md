# Deployment Debugging

Use the canonical agent-runtime ledger and Discord API paths to investigate post-deploy behavior. Do not use browser automation when a Discord link, run trace, or archive query can answer the question.

These commands target production by default through the configured control-plane URL or the active local Kubernetes context. They fail if production cannot be resolved rather than silently falling back to localhost or a local database. Use direct DB/local modes only for intentional isolated development.

## Audit a channel since deployment

```bash
npm run discord:audit -- --channel <channel-id> --since-deploy --include-reply-chains
```

The audit resolves the live bot rollout timestamp, lists every message since then, identifies bot requests and replies, follows retained reply chains, correlates runs, and clusters warnings. Pass `--since <ISO timestamp>` when investigating a historical rollout.

## Debug one Discord prompt

```bash
npm run discord:debug -- <discord-message-link>
```

This prints the ingress request, reply ancestry, run revision, final reply, warnings, operative user message, prompt-role tail, and selected tools. Use it before source reading or proposing a model/provider explanation.

For broad ledger queries, use the existing inspector:

```bash
npm run runs:inspect -- --list --channel <channel-id> --since <ISO timestamp>
npm run runs:inspect -- --list --revision <git-sha> --warnings-only
```

## Investigation order

1. Resolve the deployed revision and timestamp.
2. Audit all messages and reply chains in the affected channel since that point.
3. Identify missing replies and cluster repeated warning/tool patterns.
4. Inspect one representative trace for each cluster.
5. Compare ingress request, reply context, session memory, operative user message, tool results/typed outcome, and delivery.
6. Assign the failure to prompt assembly, tool contract, guard/state transition, model output, or delivery only after those artifacts agree.
7. Fix the smallest owning layer and add focused contract coverage.

The console and scripts expose observed model I/O and state transitions, never private chain-of-thought.
