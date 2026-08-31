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
  "signing": {
    "authority": "client",
    "requiresUserApproval": true,
    "serverCanSubmit": false
  }
}
```

The full manifest includes ordered actions, the total, identifiers, and a snapshot hash. `public-wallet` uses STRK20 withdrawals so recipients need no setup, but recipient addresses and amounts are public; `private` uses private transfers and requires registered recipients. The manifest is an application intent—not a signature, proof, wallet authorization, or promise of settlement.

### `PATCH /api/v1/pay-runs/:payRunId`

Records guarded lifecycle transitions and public transaction evidence. Invalid state jumps and reused transaction hashes are rejected.

### `POST /api/v1/pay-runs/:payRunId/verify`

Reads the Starknet receipt and finalizes only when the transaction succeeded and the configured STRK20 pool emitted an event.

### `POST /api/v1/pay-runs/:payRunId/resolve-unknown`

Requires a recent passkey session and explicit recovery confirmation. This endpoint exists for a wallet operation that may have submitted without returning a reliable result.

## Workspace resources

The authenticated `/api/account` surface manages the business profile, teams, workers, payroll-funding shield records, pay-run history, passkeys, and optional encrypted wallet-backup ciphertext. These routes remain first-party and can change before the external developer release.

### `PUT /api/account/payroll-policy`

Persists the organization payroll controls: `reserveUsdc`, `maxPayRunUsdc`, and `payoutsPaused`. KudiRail rejects new or newly prepared pay runs while payouts are paused and rejects totals above a non-zero maximum. The protected reserve is enforced by the first-party KudiRoll client against the shielded balance the user deliberately exposes through Ready; KudiRail cannot independently read that private balance and does not pretend otherwise.

## Local settlement

The `/api/phase0/paycrest` routes expose public provider health plus authenticated institution, recipient verification, order creation, and order history. Live order creation remains protected by server credentials, a deployment gate, and an NGN amount cap.

Paycrest status is provider evidence. `initiated` or `expired` does not prove a refund, and KudiRail must not present fiat delivery before Paycrest reaches a documented successful state.
