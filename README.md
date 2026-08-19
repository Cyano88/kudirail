# KudiRail

KudiRail is the non-custodial payroll orchestration API behind [KudiRoll](https://github.com/Cyano88/kudiroll). It owns business accounts, teams, immutable pay-run intents, deterministic execution manifests, public transaction evidence, and settlement-provider adapters; client wallets retain simulation, signing, submission, viewing keys, notes, and proofs.

## Privacy and custody boundary

- KudiRail never receives a wallet private key, viewing key, note, proof, seed phrase, or transaction-signing authority.
- Email OTP can open a first-party workspace, but it cannot sign transactions, decrypt an embedded wallet, recover funds, or delete an account; first-time users prove wallet ownership once and create a device passkey.
- `POST /api/v1/pay-runs` creates a durable intent and returns a client-custody manifest containing Starknet recipients and USDC amounts, but no worker names.
- The KudiRoll client converts that manifest into one atomic STRK20 action list and asks the user's privacy-capable wallet to approve it.
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

## Public API status

`GET /api/v1` is the capability declaration. Version 1 currently supports first-party email, wallet and passkey sessions, pay-run creation, manifest retrieval, lifecycle updates, pool-aware finality verification, and guarded unknown-outcome recovery; third-party credentials and signed webhooks remain unreleased.

MIT licensed. See [SECURITY.md](SECURITY.md) before reporting sensitive issues.
