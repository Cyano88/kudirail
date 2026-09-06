# Isolated PostgreSQL restore drill

The PostgreSQL restore drill workflow creates disposable PostgreSQL 18 source and target databases in CI. It runs the real migrations and account/authentication stores with synthetic data and a freshly generated disposable encryption key. No production secrets or records are used, and no database dumps are uploaded as artifacts.

The source contains two tenants, Personal and Enterprise teams, workers, a draft, synthetic submitted transaction history, an audit chain, pending funding/bank-creation recovery, and valid/revoked sessions. PostgreSQL pg_dump creates a custom-format backup; pg_restore loads a separate empty database. Verification compares the complete account snapshots, checks sessions and audit integrity, rejects the wrong encryption key/tenant, revokes a restored session and saves a new worker after restoration.

Run through GitHub Actions using workflow_dispatch or a pull request. The script refuses non-local or incorrectly named databases and requires test mode and CI. This is a logical backup compatibility drill. It does not certify Railway managed snapshots, production backup retention, recovery time objectives, key escrow, key rotation or a restore of live customer data.

Before wider release, verify the managed backup schedule and retention, restore a managed snapshot into an isolated environment with outbound payments and customer notifications disabled, provide the matching encryption key securely, and record recovery time and data-loss boundaries. Revoke restored authentication sessions before serving traffic. Restored payment statuses must be reconciled against chain/provider evidence before allowing payment retries because a backup may predate an actual payment.

## Managed production audit - September 6, 2026

Read-only Railway CLI checks on the production Postgres service confirmed:

- The database volume is Ready.
- Point-in-time recovery is disabled and its backup bucket is not wired.
- The backup schedule list is empty.
- The existing backup list is empty.

Creating the initial managed snapshot failed with `OAUTH_INSUFFICIENT_GRANT`. No managed backup was created, no schedule was changed, and no production restore was attempted. Reauthenticate the Railway CLI with project access before retrying snapshot creation and enabling daily/weekly schedules. Verify both the resulting backup record and schedule retention after success.

Railway's [recovery guide](https://docs.railway.com/guides/postgres-backups-restores) distinguishes ordinary volume snapshots, which restore to the original service, from point-in-time recovery into a new service and portable logical dumps. Do not run an ordinary production volume restore as an isolated drill. Select and verify a separate target first. The passing synthetic CI drill remains the only completed restoration evidence.
