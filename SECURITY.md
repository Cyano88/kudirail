# Security policy

## Supported version

Until the first stable release, only the current `main` branch receives security fixes.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing an exploit, production endpoint details, credentials, wallet information, employee data, bank data, or transaction material that could identify a payroll participant.

Include:

- affected commit and component;
- impact and reproduction steps using sanitized data;
- whether funds or private payroll data may be at risk;
- any safe mitigation already tested.

Maintainers should acknowledge a report within three business days, establish a remediation plan, and coordinate disclosure only after affected deployments are fixed.

## Security boundaries

- KudiRail must never receive or store wallet private keys, viewing keys, notes, proofs, OTPs, or recovery phrases.
- Paycrest API credentials and webhook secrets are server-only.
- STRK20 shield and unshield legs are public; private-transfer participants and amounts are confidential inside the pool.
- A protocol or provider integration does not make KudiRail automatically compliant. Operators remain responsible for applicable legal, KYC/KYB, sanctions, reporting, and data-protection requirements.
