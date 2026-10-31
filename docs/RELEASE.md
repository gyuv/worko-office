# Release checklist

Applies to the API, web/portal, Electron desktop and Android app, which ship together from one tag.
Disaster recovery: docs/DR.md. Decisions D200–D209.

## 1. Versioning
- One version for the monorepo release: `MAJOR.MINOR.PATCH` (semver), tag `vX.Y.Z` on `main`.
  - MAJOR: an API change old devices can't handle (they must update before sync works), or a data migration that
    can't be rolled back. MINOR: features/migrations that are backwards compatible. PATCH: fixes only.
- Bump `version` in `apps/desktop/package.json` (installer + auto-update feed) and `apps/mobile/app.json`
  (`expo.version`, user-visible). Android `versionCode` is managed by EAS (`appVersionSource: remote`, `autoIncrement`
  on the production profile) — never set it by hand; it only ever goes up (D204).
- `runtimeVersion` follows `appVersion`: an OTA JS update never reaches a binary with a different version.
- Changelog: summarise user-visible changes per persona (partner / staff / client) — firms read it.

## 2. Pre-flight (CI must be green on the release commit)
```bash
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm lint
TEST_DATABASE_URL=postgres://… pnpm test          # includes the "Firm's day" e2e (apps/api/test/firmsday.e2e.test.ts) and the DR test
pnpm --filter @worko/api-client generate && git diff --exit-code packages/api-client
```
- The release gate is the ten-step "Firm's day" (docs/PRD.md §15): all ten `it`s pass. Also run the browser smoke:
  `scripts/e2e/run-firmsday-web.sh` (needs `pnpm build`, Postgres, and a Chromium: `CHROMIUM_PATH`/`PLAYWRIGHT_MODULE`).
- Review docs/KNOWN_GAPS.md for anything newly release-blocking (signing, provider verification).
- Restore drill on the latest production backup within the last 30 days (docs/DR.md).

## 3. Migrations
- Migrations are ordered SQL files `apps/api/db/NNNN_*.sql`, applied in filename order by `pnpm --filter @worko/api migrate`
  (each once; recorded in the migrations table). Never edit a released migration — add a new one.
- Order of a deploy: **backup → migrate → API → web → desktop/Android rollout**.
  1. `scripts/dr/backup.sh` (and note the WAL position / time for PITR).
  2. Run migrations with the owner role (not `worko_app`). Migrations must be backwards compatible with the previous API
     version for one release (add columns nullable/defaulted, backfill, enforce in the next release), so the old API
     keeps working while the new one rolls out and devices on old builds keep syncing.
  3. Roll the API (two instances: rolling restart; the job queue is Postgres-based and safe to run on several).
  4. Publish web/portal static files (cache-busted by Vite hashes; `index.html` no-cache).
  5. Desktop: upload the installers + `latest*.yml` to `WORKO_UPDATE_URL` (staged: internal channel first).
  6. Android: Play internal track → closed → production with staged rollout (10 % → 50 % → 100 %).

## 4. Environment (production)
Secrets come from the secrets manager, never the repo or images. `NODE_ENV=production` makes the API refuse weak
configuration (mock payment provider, default webhook secrets, missing master key).

| Variable | Notes |
|---|---|
| `DATABASE_URL` | `worko_app` role (RLS applies). Pool/timeouts: `DB_POOL`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_TX_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_MS` |
| `JWT_SIGNING_KEY` | ≥ 32 random bytes. Changing it signs everyone out |
| `KMS_LOCAL_MASTER_KEY` / `FIELD_ENCRYPTION_KEY` | Field-encryption master key (KEK). Rotation: `pnpm --filter @worko/api rotate-kek` with `KMS_LOCAL_PREVIOUS_KEYS` (D199). Escrow it — backups are unreadable without it |
| `PUBLIC_API_URL` | Base of signed invoice links sent to clients (`https://api…/v1`) |
| `WEB_PUBLIC_URL` | Web app base used in e-mailed report links; its host must serve `/.well-known/assetlinks.json` for Android App Links (`apps/mobile/store/assetlinks.template.json`) |
| `PORTAL_PUBLIC_URL` | Client-portal base for invitations (`https://app…/#/portal`) |
| `CORS_ORIGINS` | Exact web/portal origins, comma-separated |
| `TRUST_PROXY` | Number of trusted proxy hops (1 behind one load balancer). Wrong value = wrong client IP for attendance IP checks and rate limits |
| `STORAGE=s3`, `S3_BUCKET`, `S3_REGION` (ap-south-1), credentials | India residency; versioning on |
| `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Mock is refused in production (D81) |
| `COMM_EMAIL_PROVIDER`, `SMTP_*`; `COMM_WHATSAPP_PROVIDER=meta`, `WHATSAPP_*`; `COMM_SMS_PROVIDER=http`, `SMS_*`, `DLT_ENTITY_ID`; `COMM_WEBHOOK_SECRET` | Channel providers; DLT templates must be registered before SMS goes live |
| `GOOGLE_CLIENT_ID/SECRET`, `MS_CLIENT_ID/SECRET` | Mail/calendar OAuth |
| `ESIGN_PROVIDER`, `ESIGN_ASP_*`, `ESIGN_WEBHOOK_SECRET` | ASP adapter is unverified (KNOWN_GAPS) |
| `AI_PROVIDER` (mock\|anthropic), `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_DISABLED` | `AI_DISABLED=1` = no-AI deployment; firms must still opt in |
| `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT`, `FCM_SERVICE_ACCOUNT_JSON` | Web push / Android push |
| `ALLOW_SIGNUP`, `RATE_LIMIT`, `AUTH_RATE_LIMIT`, `SIGNUP_RATE_LIMIT`, `PORTAL_AUTH_RATE_LIMIT`, `PUBLIC_PAGE_RATE_LIMIT`, `BOOKING_RATE_LIMIT`, `MAX_BODY_BYTES` | Abuse limits |
| `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_DISABLE_AFTER` | Outbound webhooks (public API, part B) |
| `REPORT_TIMEOUT_MS`, `REPORT_MAX_SCAN`, `DASHBOARD_BUDGET_ROWS`, `DASHBOARD_BUDGET_MS` | Report engine limits |
| `ICAI_UDIN_PORTAL_URL` | Deep link only |
| Never in production | `PORTAL_DEV_LOG_OTP`, `PAYMENT_WEBHOOK_SECRET` dev default, `GSTIN_LOOKUP_PROVIDER=mock` unless intended |

Build-time (not API): desktop `WORKO_UPDATE_URL` (+ signing: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); mobile `WORKO_API_BASE`, `WORKO_WEB_HOST`, `EAS_PROJECT_ID` (EAS env).

## 5. Building the clients
**Desktop** (`apps/desktop/electron-builder.yml`): `pnpm --filter @worko/desktop dist:win | dist:mac | dist:linux`
(each builds the web renderer first). Outputs in `apps/desktop/release/`: `Worko-Setup-X.Y.Z.exe` (NSIS),
`Worko-X.Y.Z-{x64,arm64}.dmg`, `Worko-X.Y.Z-x86_64.AppImage`, plus `latest*.yml` for the update server. Build each on its
own OS (or CI runners: windows-latest, macos-latest, ubuntu-latest). Code signing: Windows needs an OV/EV certificate
(else SmartScreen warns), macOS needs a Developer ID + notarisation (else Gatekeeper blocks and auto-update cannot work).
`dist:linux:dir` makes an unpacked build without the AppImage step (quick local check).

**Android** (`apps/mobile/eas.json`): profiles `development` (dev client APK), `preview` (internal APK for testers),
`production` (AAB for Play). Steps:
1. `eas login`; `eas init` once (sets the project id → `EAS_PROJECT_ID`).
2. Signing keystore: let EAS generate and hold it (`credentialsSource: remote`) and enrol in **Play App Signing** (Google
   holds the app-signing key; ours is only the upload key). If you manage it yourself: generate with `keytool`, store the
   `.jks` + passwords in the secrets manager, never in git (`*.jks`, `*.keystore`, `credentials.json`,
   `apps/mobile/secrets/` are git-ignored). Losing the upload key is recoverable via Play support; leaking it is not —
   rotate via Play Console.
3. Set EAS environment variables `WORKO_API_BASE`, `WORKO_WEB_HOST`.
4. `pnpm --filter @worko/mobile aab` (cloud) or `aab:local` (needs Android SDK + JDK 17 locally).
5. Put Play's **app-signing** SHA-256 fingerprint into `assetlinks.template.json`, serve it at
   `https://$WORKO_WEB_HOST/.well-known/assetlinks.json` (content-type `application/json`, no redirects).
6. `eas submit -p android --profile production` (internal track, draft) with the Play service-account JSON from the
   secrets manager at `apps/mobile/secrets/play-service-account.json` (git-ignored).
7. Play Console: Data safety form and permission declarations (text in docs/manual/admin.md → Android permissions).

## 5a. Unsigned installers from GitHub Actions (no certificates needed)
`.github/workflows/release-builds.yml` builds on GitHub-hosted runners: **Windows** `Worko-Setup-X.Y.Z.exe` (NSIS x64,
windows-latest), **macOS** `Worko-X.Y.Z.dmg` + `Worko-X.Y.Z-arm64.dmg` (macos-latest, ad-hoc signed, not notarised),
**Android** `Worko-X.Y.Z.apk` (ubuntu-latest: `expo prebuild` + `gradlew assembleRelease`, signed with the **debug
keystore** — sideload only, Play rejects it; Play needs the AAB flow in §5).

Server address: the apps are built against one API. Set it as a repository variable **Settings → Secrets and
variables → Actions → Variables → `WORKO_API_BASE`** = `https://api.example.in/v1` (or type it in the *Run workflow*
form, which wins). Unset → placeholder `https://api.worko.invalid/v1` (the apps install but cannot sign in).
Desktop reads it from `dist/build-config.json` (`scripts/write-build-config.mjs`, https only), Android from
`app.config.js` → `extra.apiBase`, and the web renderer's CSP `connect-src` gets that origin. Optional variable
`WORKO_UPDATE_URL` (update feed; the in-app updater is not wired yet).

Getting the files:
- **Any run** (manual *Actions → Release builds → Run workflow*, or a push to a `claude/**` branch): open the run →
  *Artifacts* → `worko-windows`, `worko-macos`, `worko-android` (zip downloads, kept 90 days).
- **Tag** `git tag v0.1.0 && git push origin v0.1.0`: the same builds are attached to a GitHub **pre-release** for that tag.

Installing unsigned builds (tell testers):
- Windows: SmartScreen "Windows protected your PC" → **More info → Run anyway**.
- macOS: Gatekeeper says the app can't be opened → **right-click Worko.app → Open → Open**, or
  `xattr -dr com.apple.quarantine /Applications/Worko.app`. Use the `-arm64` dmg on Apple Silicon.
- Android: allow **Install unknown apps** for the browser/file manager, then open the APK. A later Play build has a
  different signature — uninstall the sideloaded APK first.

## 6. Smoke tests after deploy (production, a test firm)
1. `GET /v1/health` is 200; the web app loads; staff sign-in works (TOTP for a partner).
2. Create a test client; open Tasks; run auto-creation **preview** only.
3. Draft (don't issue) an invoice; open its PDF.
4. Portal: OTP sign-in for the test contact; the dashboard opens.
5. Payment: create a link on a ₹1 test invoice in the provider's test mode only (never in production keys) — or
   confirm the webhook endpoint answers 401 to an unsigned request.
6. Desktop: install, sign in, go offline, change a task, go online — the change syncs; a test notification shows a toast.
7. Android: install from the internal track, sign in, check in (location prompt), scan a document, open a
   `https://…/reports/download/…` link — the app opens it.
8. `GET /v1/audit/verify` for the test firm is ok.

## 7. Rollback
- **API/web**: redeploy the previous image/static bundle. Safe because migrations are backwards compatible for one
  release (section 3). Never run "down" migrations on production data.
- **A migration itself is wrong**: stop the API; restore from the pre-deploy backup or PITR to the noted time
  (docs/DR.md); changes made after that point are lost — devices re-push what is still queued in their outboxes.
- **Desktop**: re-publish the previous build under a higher version number (update clients never downgrade); until the
  in-app updater is wired (KNOWN_GAPS) users reinstall from the download page. **Android**: halt the staged rollout in Play Console; ship a fixed build with a higher `versionCode`.
- Announce the rollback to firms (status page / in-app notice) with the time window affected.
