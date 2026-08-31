# KudiRail

KudiRail is non-custodial payroll infrastructure for Starknet. It turns business payment instructions into durable payroll intents, client-signable STRK20 manifests, verified transaction records, and guarded local-payout workflows without receiving wallet keys or private payment material.

[KudiRoll](https://github.com/Cyano88/kudiroll) is the first production application powered by KudiRail. KudiRail is the orchestration layer, not a wallet, bank, custodian, privacy pool, or replacement for a settlement provider.

## Documentation

- [Live documentation](https://kudirail-production.up.railway.app) is served at `/` and `/docs`.
- [Product position](docs/POSITIONING.md)
- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [API reference](docs/API.md)
- [Production operations](docs/OPERATIONS.md)
- [Paycrest lifecycle and reconciliation](docs/PAYCREST.md)

## Privacy and custody boundary

- KudiRail never receives a wallet private key, viewing key, note, proof, seed phrase, or transaction-signing authority.
- Email OTP can open a first-party workspace, but it cannot sign transactions, decrypt an embedded wallet, recover funds, or delete an account; first-time users prove wallet ownership once and create a device passkey.
- `POST /api/v1/pay-runs` creates a durable intent and returns a client-custody manifest containing Starknet recipients and USDC amounts, but no worker names.
- A pay run chooses either `public-wallet` withdrawals for recipients who need no setup, or `private` transfers between registered STRK20 recipients. KudiRoll converts either mode into one atomic action list and asks the user's privacy-capable wallet to approve it.
- Shield and intentional settlement exits remain public onchain; private transfers conceal sender, recipient, token, amount, and spent-note links inside the pool.
- Paycrest support remains a gated NGN pilot, not automatic compliance or proof that a particular private note funded an exit.

## Development

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

The local file backend is the safe default. Production requires PostgreSQL schema migration 002, explicit `KUDIROLL_ACCOUNT_BACKEND=postgres` and `KUDIROLL_AUTH_BACKEND=postgres`, a canonical 32-byte `KUDIROLL_DATA_ENCRYPTION_KEY`, exact `KUDIRAIL_ALLOWED_ORIGINS`, the KudiRoll WebAuthn origin/RP ID, a Starknet Mainnet RPC URL, and dedicated `RESEND_API_KEY`, `KUDIROLL_EMAIL_FROM` and `KUDIROLL_EMAIL_CODE_SECRET` values for email access. Never commit those values.

## API status

`GET /api/v1` is the capability declaration. Version 1 currently supports first-party email, wallet and passkey sessions, pay-run creation, manifest retrieval, lifecycle updates, pool-aware finality verification, and guarded unknown-outcome recovery. Third-party credentials, service accounts, SDK stability guarantees, and outbound signed webhooks remain unreleased.

MIT licensed. See [SECURITY.md](SECURITY.md) before reporting sensitive issues.
