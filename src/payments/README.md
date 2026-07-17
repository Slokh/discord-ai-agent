# Payments Domain

Owns Privy application wallets, Tempo transfers, generic wagers, and wallet reconciliation.

## Responsibilities

- `privyTempoWalletProvider.ts`: deterministic Privy provisioning, Tempo token resolution, balances, transfers, fee sponsorship, receipt verification, and confirmed-block balance snapshots after transfers.
- `walletService.ts`: network-scoped shared/user wallet lifecycle, balances, below-target starter top-ups, managed transfers, wager settlement, reconciliation, and bot-wallet health.
- `reconciler.ts`: uncertain/submitted transfer reconciliation, stale wager expiry, and periodic wallet health checks.
- Durable wallet ledgers and locks live in `src/db/paymentRepository.ts`; use forward-only migrations for schema changes.

## Change Routing

- Change model-facing names, schemas, or descriptions in `src/tools/walletTools.ts` and `src/tools/registry.ts`.
- Change transfer authorization and Discord requester validation in `src/tools/walletTools.ts` and the wallet tool routes.
- Change atomic balances, idempotency, reconciliation, or console persistence in `walletService.ts`, `paymentRepository.ts`, and a forward-only migration.
- Keep all wallet assets on the configured six-decimal USD `USDC.e` rail.

## Tests

- Privy/Tempo provider and wallet lifecycle: `tests/unit/privy-tempo-wallet-provider.test.ts` and `tests/unit/wallet-service.test.ts`.
- Model-facing wallet behavior: `tests/unit/wallet-tools.test.ts` and `tests/unit/wallet-tool-routes.test.ts`.
- Atomic Postgres behavior: `tests/integration/payments-db.test.ts`.

Never log or return Privy secrets, signing credentials, or signed transactions.
