# Roadmap

Each phase ends with a runnable build, green tests, reviewer-subagent audit, KNOWN_GAPS update and a conventional commit.

## Phase 0 — Planning docs ✅
## Phase 1 — Foundation ✅
- [x] Monorepo (pnpm, Turborepo, TS strict ESM), CI workflow, docker-compose, .env.example
- [x] `@worko/domain`: config constant, PAN/GSTIN(checksum)/TAN/UDIN validators, INR + lakh/crore, GST split, FY/regime labels, permission matrix + system roles
- [x] Foundation migration with RLS + sync trigger (verified against Postgres 16)
- [x] NestJS API skeleton (health, rules endpoints, zod pipe) + tests
- [x] DB layer: migration runner, per-request tenant transaction as `worko_app` (RLS), UUIDv7 ids
- [x] Auth: email+password (scrypt) + lockout, phone OTP (mock SMS), TOTP 2FA, refresh rotation with reuse detection, device sessions, remote logout + remote wipe
- [x] Global auth guard + `@Perm` permission checks, privilege-escalation guard, hash-chained audit log + verify endpoint
- [x] Contract-first `openapi.yaml`, generated `@worko/api-client` (refresh/wipe aware), routes≡spec contract test, CI staleness check
- [x] `@worko/ui-tokens` (WCAG-tested palette, status semantics), `@worko/i18n`, light/dark/system theme
- [x] Web shell: login (password/TOTP/OTP), sidebar + mobile bottom nav, Ctrl+K palette, g-shortcuts, home, team, security (devices, wipe, 2FA), audit viewer, offline banner, PWA manifest
- [x] Electron shell: tray-resident, auto-start, native toasts, badge, safeStorage tokens, wipe handler, link allow-list
- [x] Expo shell: OTP login, SecureStore tokens, 5-tab bottom nav, devices screen, Android bundle builds in CI
- [x] `pnpm seed:demo` — demo firm with 5 role users (clients/tasks/invoices added as modules land)
## Phase 2 — Sync + notifications core ✅
- [x] Reviewer audit of Phase 1 (findings fixed)
- [x] ESLint config + CI lint step (Prettier deferred — see KNOWN_GAPS)
- [x] Teams + team membership drives team scope; team lead as escalation fallback
- [x] Pure sync core + 50-seed simulator (`@worko/sync`)
- [x] `/sync/push`, `/sync/pull` (registry, field-level merge, conflict log + restore, strict tables, idempotency), commit-ordered cursors
- [x] WebSocket change feed with live session revocation
- [x] Client SyncEngine + Memory/SQLite/IndexedDB(encrypted) stores + RealtimeClient; wired in web, desktop and Android
- [x] Notification service: in-app inbox (synced), Web Push (VAPID) + FCM adapter slot, retry/backoff, gone-endpoint cleanup, quiet hours, escalation chain with acknowledgement, cross-device read dedupe
- [x] Local reminder scheduler (desktop toasts, web toasts, Android exact alarms + channels)
- [ ] Staged initial sync (essentials first) — single global cursor today; progress shown
- [ ] Digests (morning/evening summary) — preference stored, sender not built
## Phase 3 — Clients, groups, vault, documents, inward/outward, GSTIN adapter, import wizard, browser extension ✅
- [x] Client master (registrations, contacts, groups, custom fields, encrypted Aadhaar/bank), 360 view on web, offline list/detail on Android
- [x] Visibility (own/team/branch/groups/all + sensitive allow-list) — SQL ≡ can() property test; revocations to exactly the devices that held the rows; scope-key re-pull
- [x] GSTIN checksum + lookup adapter (mock), duplicate detection, merge, import wizard (xlsx/csv) + export
- [x] Credential vault (envelope encryption, step-up reveal, audit) + MV3 browser extension (pairing, allow-listed autofill)
- [x] Documents (storage adapters, versions, signed downloads, share links, legal hold, trash, access log, search), mobile scan-upload, desktop drag-and-drop
- [x] Inward/outward registers (per-FY numbers incl. offline entries, signatures, PDF receipts)
- [x] Users PATCH (deactivate, roles, manager, branch); field hiding on REST + sync
- [ ] Licensed GSTIN/PAN/TAN/CIN lookups, OCR, chunked uploads, watermarking, Tally masters import (see KNOWN_GAPS)
## Phase 4 — Service catalogue, tasks, checks, to-dos, auto-creation/assignment ✅
- [x] Compliance rule engine core + seed pack + golden tests (`@worko/rules`)
- [x] Rule pack storage/versions, firm approval flow, matrix view, trackers, late-fee calculators
## Phase 5 — Billing, receipts, ageing, auto-billing, follow-ups, reimbursements, payment links, Tally connector, exports ✅
## Phase 6 — Time, costing, capacity; attendance (geofence), leave, expenses ✅
## Phase 7 — Email, WhatsApp/SMS, broadcasts, team chat, calendar sync, appointments ✅
## Phase 8 — Notices, audit workpapers, UDIN, DSC, licences, e-signature ✅
## Phase 9 — Client portal (web + Android), leads/proposals
## Phase 10 — Automation builder, prebuilt agents, AI features
## Phase 11 — Dashboards, report catalogue, report builder, scheduled reports, NL query
## Phase 12 — Super-admin, SaaS billing, public API/webhooks, DPDP tooling, DR, hardening, installers, AAB, manual, "Firm's day" e2e
