# KudiRail positioning

KudiRail is the non-custodial payroll orchestration layer behind KudiRoll. It gives payroll products a durable way to prepare private Starknet payments, keep operational records, verify public transaction evidence, and connect separately gated settlement providers.

## Product relationship

- **KudiRoll** is the business-facing payroll application.
- **KudiRail** is the infrastructure that owns payroll intent, lifecycle, verification, persistence, and provider orchestration.
- **The connected wallet and STRK20 implementation** own simulation, private state, proof creation, signing, and submission.
- **Paycrest** owns supported local-fiat order execution and provider settlement.

KudiRoll proves that KudiRail can power a real product. KudiRail is not yet advertised as a general developer platform because external credentials, service accounts, SDK support, and compatibility guarantees have not been released.

## Core value

KudiRail turns a business instruction such as “pay these workers these amounts” into:

1. an immutable, idempotent payroll intent;
2. a deterministic client-signing manifest;
3. a guarded submission lifecycle;
4. a verified Mainnet result tied to the configured STRK20 pool; and
5. an auditable application record without server-side signing authority.

## Accurate claims

KudiRail may be described as private-payroll infrastructure, non-custodial payroll orchestration, or a client-custody payment rail.

Do not describe KudiRail as:

- a wallet or custodian;
- a bank, licensed money transmitter, or automatic compliance product;
- a mixer or a promise that every part of a payout is private;
- a replacement for STRK20, Ready, Starknet, or Paycrest; or
- proof that a local-fiat payout settled before the provider reaches its documented successful state.

Shielding and intentional exits are public. Privacy begins inside the STRK20 pool. Bank-recipient data and provider order state are not written into private-transfer manifests.

## Intended users

The current user is the first-party KudiRoll application. The future developer audience is payroll software, workforce platforms, fintechs, and treasury products that need client-controlled private payments with durable operational state.
