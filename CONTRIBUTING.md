# Contributing to KudiRail

KudiRail welcomes focused contributions that improve private payroll safety, reliability, API design, or documentation.

## Before opening a change

1. Open an issue describing the user problem and proposed scope.
2. Do not include real employee names, payroll amounts, wallet secrets, viewing keys, proofs, bank details, credentials, or production logs.
3. Keep Paycrest and Mainnet money-moving behavior disabled in local development unless you are performing an explicitly approved certification run.

## Development checks

Use Node.js 22 or newer and npm:

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

Add regression coverage using the existing Node test runner. Keep changes scoped and update user-facing privacy documentation when behavior changes.

## Pull requests

- Explain the behavior before and after the change.
- List automated and manual verification performed.
- Call out privacy, security, migration, and rollback implications.
- Never claim automatic compliance, anonymous fiat settlement, or privacy beyond the documented STRK20 boundary.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not a public issue.
