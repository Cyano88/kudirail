# Paycrest lifecycle and reconciliation

Paycrest is an optional local-settlement adapter. It is not part of the private payroll batch and does not extend STRK20 privacy into the recipient's bank or provider systems.

## Order flow

1. KudiRail verifies the Nigerian institution and account name.
2. KudiRail creates an offramp order with Starknet USDC and the authenticated wallet as refund address.
3. Paycrest returns an exact crypto total, Starknet receive address, and expiry.
4. The client previews an STRK20 withdrawal without submitting it.
5. The user approves the exact payment in the wallet.
6. KudiRail polls provider history and can receive signed provider webhooks.

The exact total is the provider amount plus returned sender and transaction fees. KudiRail does not hard-code those fees.

## Status interpretation

- `initiated`: order exists and Paycrest has not detected a deposit.
- `deposited`: the offramp deposit was detected.
- `pending` or `fulfilling`: fiat delivery is in progress.
- `validated`: the provider confirmed fiat delivery.
- `settling` or `settled`: provider settlement is completing or complete.
- `refunding`: Paycrest detected funds and started a return.
- `refunded`: Paycrest reports the return completed; verify the return transaction before closing an incident.
- `expired`: Paycrest says no deposit was detected before expiry. This status does not prove that an independently verified transfer never happened.

## Expired order with a successful transfer

Treat this combination as an indexing or attribution incident:

1. Verify the transaction succeeded on Starknet Mainnet.
2. Compare the block timestamp with `validUntil`.
3. Verify the configured USDC token emitted the exact transfer to the assigned receive address.
4. Verify the STRK20 pool participated in the transaction.
5. Read the Paycrest order directly and record `amountPaid`, `amountReturned`, `txHash`, `updatedAt`, and transaction logs.
6. Request Paycrest reindexing for both the transaction hash and assigned receive address.
7. Poll the order again.
8. If the provider still reports zero paid and zero returned, request manual reconciliation. Do not send another payment to the expired address.

An automatic refund normally starts only after the provider attributes a deposit and then cannot fulfill it. If the provider reports `expired`, `amountPaid: 0`, and `amountReturned: 0`, no refund workflow has started even when the chain proves funds reached the assigned address.

## Support evidence

Provide Paycrest with:

- sender/order ID and KudiRoll reference;
- network and token;
- exact total sent;
- assigned receive address;
- configured refund address;
- order creation and expiry timestamps;
- transaction hash, successful receipt, and block timestamp;
- proof that the transfer occurred before expiry;
- the latest provider status and zero/non-zero paid and returned amounts; and
- results of transaction and address reindex requests.

Mask the bank account and do not send KudiRail credentials or wallet secrets.
