# Production operations

## Required production posture

1. Use PostgreSQL for both authentication and account state.
2. Apply every migration in `migrations/` with `npm run db:migrate`.
3. Configure a canonical 32-byte account encryption key.
4. Allow only the exact first-party application origin.
5. Set the exact WebAuthn origin and RP ID.
6. Use a dedicated Starknet Mainnet RPC endpoint.
7. Keep every wallet, database, email, and provider secret outside source control.

The authoritative variable names and safe placeholders are in `.env.example`.

## Release checks

Run before deployment:

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

After deployment, verify:

- `/api/health` returns HTTP 200 and reports reachable PostgreSQL;
- `/api/v1` reports `starknet-mainnet` and client custody;
- an unauthenticated `/api/account/me` returns 401;
- the configured KudiRoll origin can create and retain a credentialed session;
- a different origin cannot use credentialed API routes;
- receipt verification reaches the configured Mainnet RPC; and
- provider health exposes configuration booleans without secrets.

## Money-moving gates

- `PHASE0_LIVE_ORDER_ENABLED` defaults to false.
- `PHASE0_MAX_NGN` limits each Paycrest order even when the gate is enabled.
- A connected client wallet remains the only component able to approve STRK20 actions.
- Unknown wallet outcomes must be resolved before retrying.
- Provider order creation must be disabled if end-to-end reconciliation cannot be supported operationally.

## Incident handling

For a potentially missing transaction:

1. stop automatic retries;
2. preserve the order ID, exact amount, receive address, refund address, expiry, and transaction hash;
3. verify the chain receipt, timestamp, token, destination, and amount;
4. compare the provider's `amountPaid`, `amountReturned`, transaction hash, status, and logs;
5. use only the provider's documented reindex mechanism;
6. escalate with the sanitized evidence if indexing still reports no deposit; and
7. do not describe the order as refunded until the provider reports `refunded` and a return transaction is verifiable.

Never paste API keys, webhook secrets, wallet keys, employee data, or full bank details into incident tickets.
