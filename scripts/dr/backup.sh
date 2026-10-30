#!/usr/bin/env bash
# Worko backup: encrypted pg_dump (custom format) per database + roles + documents from the configured storage.
#
#   BACKUP_DATABASE_URLS  space-separated postgres:// URLs to dump (default: $DATABASE_URL). Use a role that can read
#                         every row (superuser or BYPASSRLS) — RLS would otherwise hide other tenants' rows.
#   BACKUP_DIR            where backup-<UTC timestamp>/ is written (default ./backups)
#   BACKUP_PASSPHRASE_FILE  file holding the encryption passphrase (required; keep it in a secrets manager, not here)
#   BACKUP_GLOBALS        1 = also dump roles/grants with pg_dumpall --roles-only (needs superuser; default 1)
#   STORAGE               local (default) | s3 — same switch the API uses (apps/api/src/storage/storage.ts)
#   STORAGE_DIR           local document root (default .storage)
#   S3_BUCKET / S3_ENDPOINT / S3_REGION + AWS credentials in the environment — for STORAGE=s3 (uses the aws CLI)
#   BACKUP_S3_TARGET      s3:// prefix the encrypted backup is copied to afterwards (optional; other region/account)
#
# Prints the backup directory on stdout. See docs/DR.md.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/lib.sh"
need pg_dump; need psql; need openssl; need sha256sum
pass_arg >/dev/null

URLS="${BACKUP_DATABASE_URLS:-${DATABASE_URL:-}}"
[[ -n "$URLS" ]] || die "set BACKUP_DATABASE_URLS or DATABASE_URL"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR:-./backups}/backup-$STAMP"
umask 077
mkdir -p "$OUT"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

dbs=()
for url in $URLS; do
  name="$(db_name "$url")"; dbs+=("$name")
  log "dumping database $name"
  row_counts "$url" > "$OUT/rows-$name.tsv"
  pg_dump --format=custom --compress=6 --no-password --file "$WORK/db-$name.dump" "$url"
  encrypt "$WORK/db-$name.dump" "$OUT/db-$name.dump.enc"
  rm -f "$WORK/db-$name.dump"
done

if [[ "${BACKUP_GLOBALS:-1}" == "1" ]]; then
  first="${URLS%% *}"
  if pg_dumpall --roles-only --no-role-passwords --dbname "$first" > "$WORK/globals.sql" 2>"$WORK/globals.err"; then
    encrypt "$WORK/globals.sql" "$OUT/globals.sql.enc"
  else
    log "warning: roles not dumped ($(head -1 "$WORK/globals.err")); recreate worko_app from the migrations' role setup"
  fi
fi

case "${STORAGE:-local}" in
  local)
    root="${STORAGE_DIR:-.storage}"
    if [[ -d "$root" ]]; then
      log "archiving documents from $root"
      tar -C "$root" -cf "$WORK/documents.tar" .
      encrypt "$WORK/documents.tar" "$OUT/documents.tar.enc"
    else
      log "no local document store at $root — skipped"
    fi ;;
  s3)
    need aws
    log "syncing documents from s3://${S3_BUCKET:-worko}"
    ep=(); [[ -n "${S3_ENDPOINT:-}" ]] && ep=(--endpoint-url "$S3_ENDPOINT")
    aws "${ep[@]}" s3 sync "s3://${S3_BUCKET:-worko}" "$WORK/documents" --only-show-errors
    tar -C "$WORK/documents" -cf "$WORK/documents.tar" .
    encrypt "$WORK/documents.tar" "$OUT/documents.tar.enc" ;;
  *) die "unknown STORAGE=${STORAGE}" ;;
esac

{
  echo "{"
  echo "  \"format\": 1,"
  echo "  \"createdAt\": \"$STAMP\","
  echo "  \"pgDump\": \"$(pg_dump --version | awk '{print $NF}')\","
  echo "  \"databases\": [$(printf '"%s",' "${dbs[@]}" | sed 's/,$//')],"
  echo "  \"storage\": \"${STORAGE:-local}\","
  echo "  \"cipher\": \"openssl aes-256-cbc pbkdf2 iter=200000 sha256\""
  echo "}"
} > "$OUT/manifest.json"
( cd "$OUT" && sha256sum -- *.enc rows-*.tsv manifest.json > SHA256SUMS )
encrypt "$OUT/SHA256SUMS" "$OUT/SHA256SUMS.enc"

if [[ -n "${BACKUP_S3_TARGET:-}" ]]; then
  need aws
  log "copying to $BACKUP_S3_TARGET/backup-$STAMP"
  aws s3 cp --recursive --only-show-errors "$OUT" "$BACKUP_S3_TARGET/backup-$STAMP"
fi
log "backup complete"
echo "$OUT"
