#!/usr/bin/env bash
# Starts a throwaway API + web dev server, runs the "Firm's day" browser smoke, stops what it started (by PID).
#   E2E_ADMIN_DATABASE_URL  admin connection to create/drop the scratch database (default $TEST_DATABASE_URL)
#   E2E_API_PORT / E2E_WEB_PORT  (default 3310 / 5310 — away from the usual dev ports)
#   CHROMIUM_PATH, PLAYWRIGHT_MODULE  passed through to firmsday.web.mjs
# Requires `pnpm build` first (runs apps/api/dist/main.js).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADMIN="${E2E_ADMIN_DATABASE_URL:-${TEST_DATABASE_URL:?set E2E_ADMIN_DATABASE_URL or TEST_DATABASE_URL}}"
API_PORT="${E2E_API_PORT:-3310}"; WEB_PORT="${E2E_WEB_PORT:-5310}"
DB="worko_e2e_$(date +%s)_$$"
base="${ADMIN%%\?*}"; DBURL="${base%/*}/$DB"
LOGDIR="$(mktemp -d)"; API_LOG="$LOGDIR/api.log"; WEB_LOG="$LOGDIR/web.log"
API_PID=""; WEB_PID=""
cleanup() {
  [[ -n "$WEB_PID" ]] && kill "$WEB_PID" 2>/dev/null || true
  [[ -n "$API_PID" ]] && kill "$API_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  psql "$ADMIN" -X -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true
  echo "logs: $LOGDIR"
}
trap cleanup EXIT
psql "$ADMIN" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB" >/dev/null
( cd "$ROOT/apps/api" && DATABASE_URL="$DBURL" node_modules/.bin/tsx src/db/migrate.ts >/dev/null )

( cd "$ROOT/apps/api" && exec env NODE_ENV=development PORT="$API_PORT" DATABASE_URL="$DBURL" PAYMENT_PROVIDER=mock PORTAL_DEV_LOG_OTP=1 \
    CORS_ORIGINS="http://localhost:$WEB_PORT" PUBLIC_API_URL="http://localhost:$API_PORT/v1" WEB_PUBLIC_URL="http://localhost:$WEB_PORT" \
    PORTAL_PUBLIC_URL="http://localhost:$WEB_PORT/#/portal" STORAGE_DIR="$LOGDIR/storage" ALLOW_SIGNUP=true AUTH_RATE_LIMIT=1000 SIGNUP_RATE_LIMIT=100 \
    node dist/main.js ) >"$API_LOG" 2>&1 &
API_PID=$!
( cd "$ROOT/apps/web" && exec env E2E_API_PORT="$API_PORT" node_modules/.bin/vite --config "$ROOT/scripts/e2e/vite.e2e.config.ts" --port "$WEB_PORT" --strictPort ) >"$WEB_LOG" 2>&1 &
WEB_PID=$!
for i in $(seq 1 60); do
  curl -sf "http://localhost:$API_PORT/v1/health" >/dev/null 2>&1 && curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1 && break
  sleep 1
  [[ $i == 60 ]] && { echo "servers did not start"; tail -20 "$API_LOG" "$WEB_LOG"; exit 1; }
done
API_URL="http://localhost:$API_PORT/v1" WEB_URL="http://localhost:$WEB_PORT/" OTP_LOG_FILE="$API_LOG" node "$ROOT/scripts/e2e/firmsday.web.mjs"
