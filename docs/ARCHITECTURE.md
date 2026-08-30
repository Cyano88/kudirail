# Architecture and trust boundaries

## Request path

```text
Business user
  -> KudiRoll application
  -> KudiRail authenticated API
  -> durable payroll intent and execution manifest
  -> client wallet STRK20 preview and approval
  -> Starknet Mainnet
  -> KudiRail receipt and pool-event verification
```

Local settlement is a separate branch:

```text
Verified bank recipient
  -> KudiRail creates a gated Paycrest order
  -> wallet approves an exact STRK20 withdrawal
  -> Paycrest detects the public settlement deposit
  -> Paycrest delivers NGN or returns funds
```

The Paycrest branch is not part of an atomic multi-worker private payroll manifest.

## Data ownership

KudiRail stores business profiles, teams, workers, immutable pay-run snapshots, public transaction hashes, finality evidence, passkey public credentials, hashed sessions and challenges, and optional encrypted wallet-backup ciphertext.

KudiRail must never receive or store wallet private keys, seed phrases, plaintext viewing keys, STRK20 notes, proofs, passkey secrets, email OTP plaintext, or transaction-signing authority.

Worker names are application records. Execution manifests omit worker names and contain only stable worker identifiers, Starknet recipients, and amounts required for the requested payment.

## Authentication

- Wallet sign-in uses a short-lived, single-use Starknet typed-data challenge.
- Successful authentication creates a 12-hour HTTP-only session.
- Passkeys can reopen an existing workspace and authorize guarded recovery operations.
- Email OTP locates a verified first-party workspace but cannot sign transactions or decrypt private wallet state.
- First-time email users must prove Starknet account ownership before the email is linked.

## Payroll state machine

The server records `draft`, `prepared`, `submitting`, `submitted`, `finalized`, `reverted`, `unknown`, and failure states. A pay run cannot skip preparation. An unresolved submission blocks another payroll so a wallet timeout cannot produce a blind duplicate.

Finalization requires a successful Starknet receipt containing an event from the configured STRK20 pool. A successful transaction without that evidence remains unknown rather than being presented as private payroll.

## Persistence

Local development defaults to file persistence. Production uses PostgreSQL for both account and authentication state. Account records are encrypted with AES-256-GCM and bound to the normalized Starknet wallet address as authenticated data.

Database encryption protects stored application records. It does not make the server a wallet and does not change the public/private boundary of onchain actions.
