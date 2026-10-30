# Disaster recovery

Scripts: `scripts/dr/` (`backup.sh`, `restore.sh`, `drill.sh`, `verify.ts`, shared `lib.sh`). Tested by
`apps/api/test/dr.int.test.ts` (backup → drill against local Postgres; wrong passphrase and a tampered artifact refuse).
Decisions D200–D202.

## Targets

| | Target | How |
|---|---|---|
| RPO (data loss) | ≤ 5 minutes for the database; ≤ 24 h for documents in local storage, ≈ 0 with S3 versioning + cross-region replication | WAL archiving (below) + nightly `backup.sh`; documents follow the storage provider |
| RTO (back in service) | ≤ 4 hours for a full database loss; ≤ 8 hours for loss of the region | `restore.sh` into a new instance; region runbook below |
| Drill | Monthly, and after every major release | `drill.sh` against the latest nightly backup; keep the printed report |

Measure the real RTO from the drill output (`restore_seconds`) and adjust these numbers with the firm-size you host.

## What is backed up

| Item | How | Encrypted |
|---|---|---|
| Each database (`BACKUP_DATABASE_URLS`) | `pg_dump --format=custom`, consistent snapshot | yes (`db-<name>.dump.enc`) |
| Roles/grants (`worko_app` etc.) | `pg_dumpall --roles-only --no-role-passwords` | yes (`globals.sql.enc`) |
| Documents | `STORAGE=local`: tar of `STORAGE_DIR`; `STORAGE=s3`: `aws s3 sync` of `S3_BUCKET` then tar | yes (`documents.tar.enc`) |
| Row counts per table | `rows-<db>.tsv` (verification only; table names + counts, no data) | no |
| Integrity | `SHA256SUMS` of everything + an encrypted copy `SHA256SUMS.enc` | — |

Encryption: `openssl enc -aes-256-cbc -pbkdf2 -iter 200000` with a passphrase read from `BACKUP_PASSPHRASE_FILE`
(never on the command line, never in the repo). Tampering is caught by the checksum list, which is itself protected by
its encrypted copy (D202). Store the passphrase in the secrets manager, separately from the backups, with two people who
can retrieve it.

What is **not** in a backup: the field-encryption master key (`FIELD_ENCRYPTION_KEY` / KMS key). Tenant data keys are in
the database only wrapped by it, so a stolen backup alone does not reveal vault passwords, Aadhaar or bank numbers — and
a backup is useless without the key. Keep the master key in KMS with its own backup policy.

Already-encrypted columns (`*_enc`) stay encrypted inside the dump. Audit logs, sync tables and the job queue are
ordinary tables and come back as they were (the audit hash chain is verified by the drill).

## Running

```bash
# nightly (cron/systemd timer on a host that can reach the database), as a role with BYPASSRLS or superuser
export BACKUP_DATABASE_URLS="postgres://backup@db.internal:5432/worko"
export BACKUP_PASSPHRASE_FILE=/run/secrets/worko-backup-pass BACKUP_DIR=/var/backups/worko
export STORAGE=s3 S3_BUCKET=worko-prod AWS_REGION=ap-south-1
export BACKUP_S3_TARGET=s3://worko-backups-hyd     # copy to a second region (India: Mumbai → Hyderabad)
scripts/dr/backup.sh                               # prints the backup directory

# monthly drill (restores into a scratch DB next to production, verifies, drops it)
DRILL_ADMIN_URL=postgres://admin@db.internal:5432/postgres FIELD_ENCRYPTION_KEY=… scripts/dr/drill.sh /var/backups/worko/backup-20261112T203000Z

# real restore (target database created empty first)
createdb -h newdb.internal worko
scripts/dr/restore.sh /var/backups/worko/backup-… postgres://admin@newdb.internal:5432/worko
RESTORE_DOCUMENTS=1 STORAGE=s3 S3_BUCKET=worko-prod-restored scripts/dr/restore.sh …   # documents too
```

The drill checks, and prints only counts and pass/fail (never decrypted values):
1. **Row counts** per table equal the backup's `rows-<db>.tsv` (`DRILL_STRICT=1`) or are within 1 % (default, because a
   live source keeps writing between the count and the dump snapshot);
2. **Audit hash chain** of every tenant, using the API's own `AuditService.verify`;
3. **Keys**: every tenant's wrapped data key unwraps with the configured master key, and up to three encrypted client
   fields per tenant decrypt with their AAD (`client:<id>:aadhaar|bank`).

Retention suggestion: 14 nightly, 8 weekly, 12 monthly; delete older ones with the bucket's lifecycle rules. Backups hold
personal data — they fall under the DPDP retention and erasure rules (see Settings → Privacy and docs/KNOWN_GAPS.md:
an erased person remains inside older backups until those expire).

## Point-in-time recovery (Postgres 16)

Nightly dumps alone give a 24-hour RPO. For ≤ 5 minutes, archive WAL continuously (managed Postgres such as RDS/Cloud SQL
does this for you — turn on PITR with ≥ 7 days retention and skip this section).

Self-managed `postgresql.conf`:

```ini
wal_level = replica
archive_mode = on
archive_timeout = 300            # force a segment at least every 5 minutes → RPO ≤ 5 min
archive_command = 'test ! -f /wal-archive/%f && cp %p /wal-archive/%f'   # or: pgbackrest --stanza=worko archive-push %p
max_wal_senders = 5
```

Take a base backup weekly (`pg_basebackup -D /base/$(date +%F) -Ft -z -X stream`, or pgBackRest/WAL-G which also
encrypt and ship to S3 — preferred for production). Recovery to a moment:

```ini
# on a fresh data directory restored from the base backup
restore_command = 'cp /wal-archive/%f %p'
recovery_target_time = '2026-11-12 15:42:00+05:30'
recovery_target_action = 'promote'
```

then `touch recovery.signal` and start Postgres. Pick a target just before the incident (the audit log's `at` column
helps find it). After promotion run `drill.sh`-style checks: `GET /v1/audit/verify` per tenant and a smoke test.

## Runbooks

### Database lost or corrupted
1. Stop the API workers (`docker compose stop api` / scale to 0) so nothing writes to a half-restored database.
2. Decide the recovery point: latest WAL (PITR) or the last nightly dump. Note it in the incident log.
3. Create a new empty database (or instance); restore: PITR as above, or `restore.sh <backup> <new-url>`.
4. If roles are missing on a new cluster: `RESTORE_GLOBALS=1` (then set the `worko_app` password from the secrets
   manager — role passwords are never in backups).
5. Run the verification: `DRILL_STRICT=0` checks via `verify.ts` (or `GET /v1/audit/verify` per tenant) — must pass.
6. Point `DATABASE_URL` at it, start the API, run the smoke tests in docs/RELEASE.md.
7. Devices: offline clients keep their outbox and push it again; the server dedupes by mutation key. Changes made
   after the recovery point and not still queued on a device are lost — tell the firms the exact recovery time.

### Region lost (Mumbai unavailable)
1. Declare the incident; freeze deploys.
2. In the standby region (Hyderabad): provision Postgres 16, Redis, object storage and the API from the same images.
3. Restore the newest backup copied by `BACKUP_S3_TARGET` (or the cross-region read replica / PITR copy if you run one).
   Documents: switch `S3_BUCKET` to the replicated bucket (S3 CRR) or `RESTORE_DOCUMENTS=1` from the backup.
4. Restore the KMS key access in that region (multi-region KMS key or the escrowed key) — without it encrypted fields
   cannot be read.
5. Update DNS for the API/web/portal hosts; `PUBLIC_API_URL`, `WEB_PUBLIC_URL`, `PORTAL_PUBLIC_URL` stay the same names.
6. Re-register webhooks only if their URLs changed (payment gateway, WhatsApp, e-sign).
7. Data residency: both regions must be in India.

### Key compromise
- **Backup passphrase leaked**: generate a new passphrase, update the secrets manager, take a fresh backup, then delete
  (or re-encrypt) backups made with the old one. Backups never contain the field master key, so field data stays
  protected; database contents in those backups must be treated as exposed if the backup files were also obtained.
- **Field master key (KEK) leaked**: follow part B's key-rotation command `rotate-kek` (D199; see its header in
  `apps/api/src/db/rotate-kek.ts`) — new key as the current master key, the old one listed as a previous key while it
  runs, then removed. Data keys are re-wrapped, ciphertexts untouched. Then take a fresh backup and run `drill.sh` with
  only the new key configured, so restored data is proven readable without the old key. Older backups still need the
  old key to unwrap — keep it escrowed until those backups expire, or re-run the drill/restore with it listed as previous.
- **JWT signing key / webhook secrets leaked**: replace them in the secrets manager and restart (see docs/RELEASE.md
  env table); all sessions must sign in again after a JWT key change; re-enter webhook secrets at the providers.
- **Database credentials leaked**: rotate the `worko_app` and backup role passwords, check `audit_log` and Postgres logs
  for the exposure window, run `GET /v1/audit/verify` for every tenant.
- Record every rotation in the incident log; DPDP breach notification duties may apply (Settings → Privacy).
