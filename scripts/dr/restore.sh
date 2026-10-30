#!/usr/bin/env bash
# Worko restore: verifies and decrypts a backup made by backup.sh and restores it.
#
#   restore.sh <backup-dir> <target-database-url> [source-db-name]
#
# The target database must exist and be empty (create it first; never restore over a live database — restore next to
# it and switch DATABASE_URL). source-db-name picks which dump to restore when the backup holds several.
#   BACKUP_PASSPHRASE_FILE  as for backup.sh (required)
#   RESTORE_GLOBALS=1       also replay roles (globals.sql) — only on a fresh cluster, needs superuser
#   RESTORE_DOCUMENTS=1     also restore documents to STORAGE (local: STORAGE_DIR; s3: S3_BUCKET via aws CLI)
#   RESTORE_JOBS            parallel pg_restore jobs (default 4)
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/lib.sh"
need pg_restore; need psql; need openssl; need sha256sum
[[ $# -ge 2 ]] || die "usage: restore.sh <backup-dir> <target-database-url> [source-db-name]"
SRC="$1"; TARGET="$2"
[[ -f "$SRC/SHA256SUMS" && -f "$SRC/SHA256SUMS.enc" ]] || die "$SRC is not a backup directory"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
umask 077

log "verifying checksums"
decrypt "$SRC/SHA256SUMS.enc" "$WORK/SHA256SUMS" || die "cannot decrypt SHA256SUMS.enc (wrong passphrase?)"
cmp -s "$WORK/SHA256SUMS" "$SRC/SHA256SUMS" || die "SHA256SUMS does not match its encrypted copy — backup tampered"
( cd "$SRC" && sha256sum --quiet -c SHA256SUMS ) || die "checksum mismatch"

NAME="${3:-}"
if [[ -z "$NAME" ]]; then
  set -- "$SRC"/db-*.dump.enc
  [[ $# -eq 1 ]] || die "backup holds several databases; pass the source db name"
  NAME="$(basename "$1" .dump.enc)"; NAME="${NAME#db-}"
fi
[[ -f "$SRC/db-$NAME.dump.enc" ]] || die "no dump for database $NAME"

existing="$(psql "$TARGET" -X -A -t -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
[[ "$existing" == "0" ]] || die "target database is not empty ($existing tables) — refusing to restore over it"

if [[ "${RESTORE_GLOBALS:-0}" == "1" && -f "$SRC/globals.sql.enc" ]]; then
  log "replaying roles"
  decrypt "$SRC/globals.sql.enc" "$WORK/globals.sql"
  psql "$TARGET" -X -q -f "$WORK/globals.sql" >/dev/null || log "warning: some roles already existed"
fi

log "restoring database $NAME"
decrypt "$SRC/db-$NAME.dump.enc" "$WORK/db.dump"
# --no-owner: objects belong to the restoring role; GRANTs (worko_app) are kept. RLS policies come with the schema.
check_pg_restore_version "$TARGET"
pg_restore --no-owner --exit-on-error --jobs "${RESTORE_JOBS:-4}" --dbname "$TARGET" "$WORK/db.dump"
rm -f "$WORK/db.dump"

if [[ "${RESTORE_DOCUMENTS:-0}" == "1" && -f "$SRC/documents.tar.enc" ]]; then
  decrypt "$SRC/documents.tar.enc" "$WORK/documents.tar"
  case "${STORAGE:-local}" in
    local) root="${STORAGE_DIR:-.storage}"; mkdir -p "$root"; log "restoring documents to $root"; tar -C "$root" -xf "$WORK/documents.tar" ;;
    s3) need aws; mkdir -p "$WORK/documents"; tar -C "$WORK/documents" -xf "$WORK/documents.tar"
        ep=(); [[ -n "${S3_ENDPOINT:-}" ]] && ep=(--endpoint-url "$S3_ENDPOINT")
        log "restoring documents to s3://${S3_BUCKET:-worko}"; aws "${ep[@]}" s3 sync "$WORK/documents" "s3://${S3_BUCKET:-worko}" --only-show-errors ;;
  esac
fi
log "restore complete"
