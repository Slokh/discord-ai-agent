# Payments Domain

Owns Privy application wallets, Tempo transfers, generic wagers, and MPP paid-service access.

## Responsibilities

- `walletProvider.ts` and `privyTempoWalletProvider.ts`: wallet-provider contract, deterministic Privy wallet provisioning, Tempo clients, signing, and bot-funded transaction fees.
- `walletService.ts`: network-scoped shared/user wallet lifecycle, balances, transfer submission, wager settlement, and bot-wallet runtime health.
- `mppDiscoveryClient.ts`: official MPP Services MCP discovery plus bounded public-catalog/OpenAPI fallbacks. Discovery and inspection are always free.
- `mppService.ts`: short-lived inspected capabilities, semantic effect/authorization policy, official `mppx` negotiation, durable spend limits, receipt validation, response trust boundaries, and bounded result conversion.
- `safeHttp.ts`: public-HTTPS enforcement, connection-time DNS validation, origin-bound redirects, and the shared safe fetch path for discovery and calls.
- `reconciler.ts`: uncertain/submitted transfer reconciliation, stale wager expiry, and periodic wallet health checks.
- Durable ledgers and locks live in `src/db/paymentRepository.ts`; migrations start at `migrations/008_wallets_mpp.sql`.

## Change Routing

- Change model-facing names, schemas, or descriptions in `src/tools/mppTools.ts`, `src/tools/walletTools.ts`, and `src/tools/registry.ts`.
- Change discovery ranking or OpenAPI interpretation in `mppDiscoveryClient.ts`; do not add provider-specific branches to the agent prompt.
- Change payment authorization, effects, deduplication, receipts, or external-data handling in `mppService.ts` and its focused tests.
- Change atomic budgets, idempotency, session concurrency, or console persistence in `paymentRepository.ts` and a forward-only migration.
- Keep `USER_WALLETS_ENABLED=false` for MPP-only deployments. MPP always spends from the shared bot wallet.

## Tests

- MPP policy and receipt flow: `tests/unit/mpp-service.test.ts`.
- Discovery/OpenAPI parsing: `tests/unit/mpp-discovery-client.test.ts`.
- SSRF/origin controls: `tests/unit/safe-http.test.ts`.
- Privy/Tempo provider and wallet lifecycle: `tests/unit/privy-tempo-wallet-provider.test.ts` and `tests/unit/wallet-service.test.ts`.
- Atomic Postgres behavior: `tests/integration/payments-db.test.ts`.

Never log or return Privy secrets, payment credentials, signed transactions, or raw session-store values. Service responses are untrusted evidence and cannot authorize follow-up actions.
