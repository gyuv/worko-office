# Roadmap

Each phase ends with a runnable build, green tests, reviewer-subagent audit, KNOWN_GAPS update and a conventional commit.

## Phase 0 — Planning docs ✅
## Phase 1 — Foundation (in progress)
- [x] Monorepo (pnpm, Turborepo, TS strict ESM), CI workflow, docker-compose, .env.example
- [x] `@worko/domain`: config constant, PAN/GSTIN(checksum)/TAN/UDIN validators, INR + lakh/crore, GST split, FY/regime labels, permission matrix + system roles
- [x] Foundation migration with RLS + sync trigger (verified against Postgres 16)
- [x] NestJS API skeleton (health, rules endpoints, zod pipe) + tests
- [ ] DB access layer (Drizzle) with per-request `SET LOCAL app.tenant_id` transaction interceptor
- [ ] Auth: email+password (argon2), phone OTP, TOTP 2FA, refresh rotation, device sessions, remote logout
- [ ] Permission guard decorator + audit interceptor with hash chain
- [ ] OpenAPI generation from controllers + `@worko/api-client` codegen + contract tests
- [ ] `@worko/ui-tokens`, i18n (i18next) setup, light/dark theme
- [ ] Web shell (Vite + React + Tailwind + shadcn, Ctrl+K palette, login)
- [ ] Electron shell (tray, auto-start, toasts), Expo shell (bottom nav)
- [ ] Seed tooling + demo firm skeleton
## Phase 2 — Sync + notifications core
- [x] Pure sync core + 50-seed simulator (`@worko/sync`)
- [ ] `/sync/push`, `/sync/pull`, WS gateway, outbox relay; SQLite adapters for desktop/Android; staged initial sync
- [ ] Notification service: in-app, desktop native, FCM, Web Push; local reminder scheduler; quiet hours; escalation
## Phase 3 — Clients, groups, vault, documents, inward/outward, GSTIN adapter, import wizard, browser extension
## Phase 4 — Service catalogue, tasks, checks, to-dos, auto-creation/assignment
- [x] Compliance rule engine core + seed pack + golden tests (`@worko/rules`)
- [ ] Rule pack storage/versions, firm approval flow, matrix view, trackers, late-fee calculators
## Phase 5 — Billing, receipts, ageing, auto-billing, follow-ups, reimbursements, payment links, Tally connector, exports
## Phase 6 — Time, costing, capacity; attendance (geofence), leave, expenses
## Phase 7 — Email, WhatsApp/SMS, broadcasts, team chat, calendar sync, appointments
## Phase 8 — Notices, audit workpapers, UDIN, DSC, licences, e-signature
## Phase 9 — Client portal (web + Android), leads/proposals
## Phase 10 — Automation builder, prebuilt agents, AI features
## Phase 11 — Dashboards, report catalogue, report builder, scheduled reports, NL query
## Phase 12 — Super-admin, SaaS billing, public API/webhooks, DPDP tooling, DR, hardening, installers, AAB, manual, "Firm's day" e2e
