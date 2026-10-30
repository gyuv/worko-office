#!/usr/bin/env bash
# Restore drill: restores a backup into a scratch database next to the live one, verifies it, and drops it.
#
#   drill.sh <backup-dir> [source-db-name]
#
#   DRILL_ADMIN_URL   connection used to CREATE/DROP the scratch database (default: $DATABASE_URL with /postgres)
#   DRILL_STRICT=1    row counts must equal the manifest exactly (quiescent source, e.g. CI); default allows the live
#                     source to have grown between the counts and the dump snapshot (restored >= 99 % of manifest)
#   DRILL_KEEP=1      keep the scratch database for inspection
#   FIELD_ENCRYPTION_KEY / KMS_LOCAL_MASTER_KEY (+ KMS_LOCAL_PREVIOUS_KEYS after a rotation) — so the drill can unwrap
#                     tenant keys and decrypt samples
# Exit code 0 = drill passed. Writes a short report on stdout.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
. "$DIR/lib.sh"
need psql
[[ $# -ge 1 ]] || die "usage: drill.sh <backup-dir> [source-db-name]"
SRC="$1"; NAME="${2:-}"
ADMIN="${DRILL_ADMIN_URL:-$(db_url_with "${DATABASE_URL:?set DATABASE_URL or DRILL_ADMIN_URL}" postgres)}"
SCRATCH="worko_drill_$(date -u +%Y%m%d%H%M%S)_$$"
TARGET="$(db_url_with "$ADMIN" "$SCRATCH")"
cleanup() { [[ "${DRILL_KEEP:-0}" == "1" ]] || psql "$ADMIN" -X -q -c "DROP DATABASE IF EXISTS $SCRATCH WITH (FORCE)" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "creating scratch database $SCRATCH"
psql "$ADMIN" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $SCRATCH" >/dev/null
start=$(date +%s)
"$DIR/restore.sh" "$SRC" "$TARGET" ${NAME:+"$NAME"}
restored=$(date +%s)
if [[ -z "$NAME" ]]; then f=("$SRC"/rows-*.tsv); NAME="$(basename "${f[0]}" .tsv)"; NAME="${NAME#rows-}"; fi

# Verification set: row counts vs manifest, audit hash chains, tenant key unwrap + sample decryptions (verify.ts).
row_counts "$TARGET" > "${TMPDIR:-/tmp}/$SCRATCH.rows"
status=0
DRILL_ROWS_EXPECTED="$SRC/rows-$NAME.tsv" DRILL_ROWS_ACTUAL="${TMPDIR:-/tmp}/$SCRATCH.rows" DRILL_DATABASE_URL="$TARGET" \
  "$ROOT/apps/api/node_modules/.bin/tsx" "$DIR/verify.ts" || status=$?
rm -f "${TMPDIR:-/tmp}/$SCRATCH.rows"
echo "restore_seconds=$((restored - start)) total_seconds=$(( $(date +%s) - start ))"
exit $status
