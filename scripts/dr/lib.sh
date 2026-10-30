# Shared helpers for backup.sh / restore.sh / drill.sh. Sourced, not executed.
# Secrets never appear on a command line: the passphrase is read from BACKUP_PASSPHRASE_FILE (openssl -pass file:),
# database passwords come from the URL in the environment (or ~/.pgpass), never from arguments.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[$(date -u +%H:%M:%SZ)] $*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found on PATH"; }

# AES-256-CBC with PBKDF2 (200k iterations, random salt). Integrity: SHA256SUMS of the encrypted files, plus an
# encrypted copy of that list (SHA256SUMS.enc) so a swapped artifact + rewritten SUMS is detected (D202).
ENC_ARGS=(-aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt)
pass_arg() {
  [[ -n "${BACKUP_PASSPHRASE_FILE:-}" ]] || die "BACKUP_PASSPHRASE_FILE is not set (a file holding the backup passphrase, mode 600)"
  [[ -r "$BACKUP_PASSPHRASE_FILE" ]] || die "cannot read BACKUP_PASSPHRASE_FILE"
  echo "file:$BACKUP_PASSPHRASE_FILE"
}
encrypt() { openssl enc "${ENC_ARGS[@]}" -pass "$(pass_arg)" -in "$1" -out "$2"; }
decrypt() { openssl enc -d "${ENC_ARGS[@]}" -pass "$(pass_arg)" -in "$1" -out "$2"; }

# Database name from a postgres:// URL (path component, query stripped).
db_name() { local u="${1%%\?*}"; echo "${u##*/}"; }
# Same URL pointing at another database.
db_url_with() { local u="$1" n="$2" q=""; [[ "$u" == *\?* ]] && q="?${u#*\?}" && u="${u%%\?*}"; echo "${u%/*}/$n$q"; }

# "table<TAB>rows" for every base table in public, ordered — used for the manifest and the drill comparison.
row_counts() {
  psql "$1" -X -A -t -v ON_ERROR_STOP=1 -c "SELECT format('SELECT %L || chr(9) || count(*) FROM public.%I;', tablename, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename" \
    | psql "$1" -X -A -t -v ON_ERROR_STOP=1
}
