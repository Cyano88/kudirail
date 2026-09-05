# API reference

KudiRail version 1 is currently a first-party, cookie-authenticated API. It is not a public API-key product yet.

## Capability and health

### `GET /`

Serves the public KudiRail documentation webpage. Machine-readable service capability is available from `GET /api/v1`.

### `GET /api/health`

Reports release, persistence, database readiness, and configured integration health without returning credentials.

### `GET /api/v1`

Declares the active network, custody model, authentication modes, version, and gated local-settlement availability.

## Authentication

Wallet, passkey, and email endpoints live under `/api/account`. Session cookies are HTTP-only, `SameSite=Strict`, and secure in production.

Important entry points:

- `POST /api/account/challenge`
- `POST /api/account/session`
- `DELETE /api/account/session`
- `GET /api/account/me`
- `POST /api/account/passkeys/authentication/options`
- `POST /api/account/passkeys/authentication/verify`
- `POST /api/account/email/authentication/request`
- `POST /api/account/email/authentication/verify`

Authentication endpoints are rate limited. Email and passkey authentication do not grant server-side transaction authority.

## Pay-run intents

### `POST /api/v1/pay-runs`

Requires a first-party session and an `Idempotency-Key` containing 16 to 128 safe characters.

The response contains a public pay-run record and a deterministic `executionManifest`. Repeating the same key and payload returns the same intent; reusing the key with different content is rejected.

### `GET /api/v1/pay-runs/:payRunId/execution-manifest`

Returns the saved client-signing manifest for the authenticated wallet tenant.

The manifest states:

```json
{
  "version": "2",
  "kind": "strk20.payroll-intent",
  "network": "starknet-mainnet",
  "settlementMode": "public-wallet",
  "asset": { "symbol": "USDC", "decimals": 6 },
  "policy": {
    "version": 3,
    "reserveUsdc": "0.1",
    "maxPayRunUsdc": "5",
    "payoutsPaused": false
  },
  "signing": {
    "authority": "client",
    "requiresUserApproval": true,
    "serverCanSubmit": false
  }
}
```

The full manifest includes ordered actions, the total, identifiers, and a snapshot hash. `public-wallet` uses STRK20 withdrawals so recipients need no setup, but recipient addresses and amounts are public; `private` uses private transfers and requires registered recipients. The manifest is an application intent—not a signature, proof, wallet authorization, or promise of settlement.

### `GET /api/v1/pay-runs/:payRunId/evidence`

Downloads a sanitized, shareable evidence bundle. It includes the committed intent hashes, client-signing boundary, saved transaction and finality evidence, and the relevant tamper-evident audit records. It excludes team names, worker names, recipient addresses, individual amounts, and the pay-run total.

For a private route, the bundle distinguishes two facts: KudiRail recorded an intent for STRK20 private transfers, and Starknet can verify finality plus interaction with the configured pool. A public receipt intentionally cannot reveal or independently prove private recipients, amounts, or note delivery; recipient-wallet confirmation is required for end-to-end delivery evidence. The bundle checksum detects file changes but is not a signature or onchain attestation.

### `PATCH /api/v1/pay-runs/:payRunId`

Records guarded lifecycle transitions and public transaction evidence. Moving to `submitting` requires the policy version reviewed by the client; KudiRail rejects the transition if controls changed and returns a freshly authorized manifest after every accepted update. Invalid state jumps and reused transaction hashes are rejected.

### `POST /api/v1/pay-runs/:payRunId/verify`

Reads the Starknet receipt and finalizes only when the transaction succeeded and the configured STRK20 pool emitted an event.

### `POST /api/v1/pay-runs/:payRunId/resolve-unknown`

Requires a recent passkey session and explicit recovery confirmation. This endpoint exists for a wallet operation that may have submitted without returning a reliable result.

## Workspace resources

The authenticated `/api/account` surface manages the business profile, teams, workers, payroll-funding shield records, pay-run history, passkeys, and optional encrypted wallet-backup ciphertext. These routes remain first-party and can change before the external developer release.

### `PUT /api/account/payroll-policy`

Persists a monotonically versioned organization policy containing `reserveUsdc`, `maxPayRunUsdc`, and `payoutsPaused`. KudiRail rejects new or newly prepared pay runs while payouts are paused, rejects totals above a non-zero maximum, and rejects wallet submission when the reviewed policy version is stale. The protected reserve is enforced by KudiRoll after a fresh wallet-mediated balance read immediately before submission; KudiRail cannot independently read that private balance and does not pretend otherwise.

Policy changes, payroll lifecycle transitions, transaction-hash capture, finality results, and recorded shields are appended to an encrypted per-account hash chain. `GET /api/account/me` returns the latest 100 audit events plus `treasuryAuditVerified`; mutations fail closed if the stored chain no longer verifies.

## Local settlement

The `/api/phase0/paycrest` routes expose public provider health plus authenticated institution, recipient verification, order creation, and order history. Live order creation remains protected by server credentials, a deployment gate, and an NGN amount cap.

Paycrest status is provider evidence. `initiated` or `expired` does not prove a refund, and KudiRail must not present fiat delivery before Paycrest reaches a documented successful state.


Payroll evidence records `verifiedPoolAddress` from the successful accepted receipt check separately from the current configured pool. Historical finalized records without this field require another Verify onchain check; descriptive text alone cannot establish pool verification. Pre-confirmed receipts do not finalize a pay run. The export is available through the KudiRoll proxy with its attachment header intact.
