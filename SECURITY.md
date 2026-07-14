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

## Automated Security Gates

This project is optimized for small, private Discord deployments rather than a regulated enterprise environment. Release CI blocks on fixable **Critical** production dependency or container findings. High-severity findings remain visible in CI scan reports and the scheduled Security Report workflow, but do not stop unrelated releases.

The controls that protect real trust boundaries remain mandatory: secret hygiene, permission-aware Discord access, non-root containers, isolated code-update execution, and narrowly scoped GitHub credentials. Scanner exceptions must identify an exact advisory, package, version, and path, and must state when they can be removed. Broad severity or package exceptions are not acceptable.

The weekly and manually dispatchable Security Report workflow audits production dependencies and both container images at the High threshold. Its reports are retained as workflow artifacts for review without participating in the deployment gate.
