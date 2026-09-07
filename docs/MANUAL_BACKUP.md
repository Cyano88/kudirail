# Encrypted manual database backups

This workflow needs no new Railway subscription. It is operator-run before releases; no automatic schedule is installed. Railway's dashboard reported managed backups and PITR require Pro, explaining the managed-backup blocker. Reauthentication did not resolve it.

## Verified production drill - September 7, 2026

An encrypted production export was created at 06:16:51 UTC through a temporary loopback SSH tunnel. No public database proxy was added. The PostgreSQL 18.6 server supplied pg_dump; a fresh local PostgreSQL 17.11 database successfully restored this particular schema using pg_restore 17.11. This verifies the current dump's compatibility, not a general PostgreSQL downgrade guarantee. Use matching-major recovery tools for future restores where possible.

The verifier compared all four public tables against SHA-256 fingerprints read in the same repeatable-read snapshot as pg_dump, decrypted every account with the saved application key, and deleted restored authentication sessions and challenges. Restore and verification took 0.443 seconds locally, excluding setup, export and cleanup; this is not a full incident recovery-time commitment. No payment application ran against the restored database. The disposable local cluster was stopped and removed after verification.

The retained archive is outside the repositories. Its separate encryption key is wrapped using Windows CurrentUser DPAPI. Account encryption key material is included only inside the authenticated encrypted archive so the backup can recover account data without relying on a subsequently rotated live key. Neither key nor archive is committed or uploaded to CI.

## Operator commands

Run from the backend repository with Node dependencies installed. Supply these values privately through the process environment, never in issue comments, command arguments, terminal output or committed files:

- Backup: `KUDI_BACKUP_SOURCE_URL` and `KUDIROLL_DATA_ENCRYPTION_KEY`.
- Restore: `KUDI_BACKUP_TARGET_URL`, pointing to a fresh local database named `kudiroll_recovery_<suffix>`.
- Utilities: `PG_DUMP_BIN` and `PG_RESTORE_BIN` when not on PATH. A matching pg_dump is required. `KUDI_PG_DUMP_PREFIX` optionally contains a JSON argument array for an SSH transport; never include passwords in it.
- Non-Windows operators: provide an independently secured canonical 32-byte base64url `KUDI_BACKUP_KEY` and run `node --import tsx scripts/manual-backup.ts backup|verify <archive>`.

Windows operators can keep the backup key protected by DPAPI:

```powershell
./scripts/manual-backup.ps1 -Mode backup -Archive <new-archive-path> -KeyFile <dpapi-key-path>
./scripts/manual-backup.ps1 -Mode verify -Archive <existing-archive-path> -KeyFile <same-dpapi-key-path>
```

Create the parent directories first and restrict them to the operator. Supply connection settings via the deployment secret store in the running process. Use an authenticated SSH tunnel for private Railway databases. Remote direct connections require verified TLS; no TLS verification bypass is implemented. This command does not create tunnels, install database tools or initialize restore databases automatically.

Backup export is read-only. The archive uses AES-256-GCM and never writes a plaintext dump. Existing archive paths are rejected. This small-alpha workflow buffers data in memory and caps dump output at 128 MiB; use a reviewed streaming approach for larger databases. Unexpected public tables fail closed until coverage is reviewed. Restore authenticates the archive before connecting, rejects remote/production-named/nonempty targets, compares restored contents, checks account decryption, and revokes sessions/challenges. It does not reconcile external transactions or enable the app. Always reconcile chain/provider outcomes before any restored system can retry payments.

## Remaining resilience work

- A local archive and a CurrentUser DPAPI key do not cover loss of the Windows account or computer. Copy the encrypted archive to another trusted device/storage location and separately escrow the recovery key securely, then test recovery there. Do not merely copy the DPAPI blob and assume another machine can unlock it.
- Repeat before releases and migrations; a manual backup does not protect changes made after its snapshot.
- Test recovery with matching PostgreSQL major versions and document full operational recovery time.
- Retention, independent key escrow, key rotation and incident cutover remain separate drills. Managed snapshots/PITR are still disabled on the current plan.
