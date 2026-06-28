# Security Policy

## Reporting Vulnerabilities

Please report vulnerabilities privately to the repository owner before public disclosure. Include:

- A short description of the issue.
- Impacted versions or commits.
- Reproduction steps, logs, or proof of concept.
- Whether any Discord data, model provider tokens, GitHub tokens, Railway tokens, or database credentials may be exposed.

## Secret Rotation

If a token, database URL, or private export is accidentally committed or posted publicly:

1. Revoke or rotate the secret at the provider.
2. Remove the public artifact.
3. Audit Railway, GitHub, OpenRouter, Discord, and database logs for suspicious access.
4. Treat Discord message dumps, embeddings, trace logs, and private skill exports as sensitive even when no API token is present.

## Data Handling

Discord AI Agent stores indexed message content, metadata, embeddings, traces, tool audit logs, conversation memory, aliases, blocked users, and private database skills. Do not publish production databases, dumps, logs, `.discord-ai-agent/`, or skill exports.

The bot should run with least-privilege Discord permissions and should not be granted Administrator.

