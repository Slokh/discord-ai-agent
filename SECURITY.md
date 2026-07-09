# Security Policy

## Reporting Vulnerabilities

Please use GitHub's private vulnerability reporting: **Report a vulnerability** under the repository Security tab, at https://github.com/Slokh/discord-ai-agent/security/advisories/new. If that is unavailable, contact the repository owner (@Slokh) directly. Do not open a public issue for security reports. Include:

- A short description of the issue.
- Impacted versions or commits.
- Reproduction steps, logs, or proof of concept.
- Whether any Discord data, model provider tokens, GitHub tokens, Kubernetes secrets, or database credentials may be exposed.

## Secret Rotation

If a token, database URL, or private export is accidentally committed or posted publicly:

1. Revoke or rotate the secret at the provider.
2. Remove the public artifact.
3. Audit Kubernetes/EKS, GitHub, OpenRouter, Discord, and database logs for suspicious access.
4. Treat Discord message dumps, embeddings, trace logs, and private skill exports as sensitive even when no API token is present.

## Data Handling

Discord AI Agent stores indexed message content, metadata, embeddings, traces, tool audit logs, conversation memory, aliases, blocked users, and private database skills. Do not publish production databases, dumps, logs, `.discord-ai-agent/`, or skill exports.

The bot should run with least-privilege Discord permissions and should not be granted Administrator.
