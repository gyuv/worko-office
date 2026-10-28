# Worko — agent conventions

Practice & office management for Indian CA/CS firms. Web + Electron desktop + Expo Android, one NestJS backend.
Full spec: docs/PRD.md. Status: PROGRESS.md (update after every session). Gaps: docs/KNOWN_GAPS.md. Choices: docs/DECISIONS.md.

## Commands
- `pnpm install` · `pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test` (API integration tests need `TEST_DATABASE_URL`)
- `docker compose up -d` → Postgres 16, Redis, MinIO, Mailpit
- `cp .env.example .env` then `pnpm --filter @worko/api migrate` and `pnpm seed:demo` (firm `demo`, password `Demo@12345`)
- `pnpm dev` (API :3000 + web :5173) · `pnpm desktop:dev` · `pnpm mobile:dev`
- After editing `docs/openapi.yaml`: `pnpm --filter @worko/api-client generate` (CI fails if stale)

## Folder map
- `packages/domain` — product config, PAN/GSTIN/TAN/UDIN validators, paise money, FY helpers, permission matrix; `billing.ts` (GST split, rounding, FIFO, ageing, doc numbers) + `tally.ts` (pure Tally XML) + `hr.ts` (haversine/CIDR, leave days, accrual, comp-off, timer/cost/P&L/capacity maths, `canPerson`/`canSeeCost`) + `comm.ts` (phone/email normalisation, STOP keywords, template placeholders/render, rate/cap maths, booking slots, ICS)
- `packages/rules` — compliance rule engine + indicative late-fee calculator; `packs/*.json` are data, not code
- `packages/sync` — client SyncEngine, stores (memory/SQLite), RealtimeClient; `core.ts` = reference model + simulator
- `packages/notify` — categories, quiet hours, delivery planning, offline ReminderScheduler
- `packages/api-client` — generated from openapi.yaml; handles refresh + remote wipe
- `packages/ui-tokens`, `packages/i18n` — shared by all three apps
- `apps/api` — NestJS (ESM). `db/*.sql` ordered migrations; `src/db/db.service.ts` tenantTx; `src/sync/registry.ts` syncable tables; `src/jobs` Postgres job queue; `src/tasks` catalogue/tasks/auto-creation (`scope.ts` = taskScopeSql); `src/compliance` rule packs, extensions, matrix, late fees; `src/billing` entities/rates/invoices/receipts/auto-billing/follow-ups/payments (`providers.ts` = payment + messaging adapters)/ageing/Tally; `src/time` time entries/timers/live activity (`rules.ts` = shared entry validation) + job P&L/capacity reports; `src/hr` attendance (geofence/IP), leave ledger + comp-off job, expenses/advances, HR config + cost rates (`common.ts` = `personScopeSql`, approver checks); `src/comm` channel adapters + webhooks + OAuth (`channels.ts`), consent/rates/caps/matching (`common.ts`), templates/messages/timeline/inbox (`comm.service.ts`), broadcasts job, team chat + calendar/ICS/booking (`sync-rules.ts` = chat/calendar registry rules); `test/` integration tests (`helpers.ts` boots an app on a fresh DB)
- `apps/web` — Vite React SPA (also Electron's renderer); `apps/desktop` — Electron main/preload; `apps/mobile` — Expo; `apps/extension` — MV3 vault autofill

## Conventions
- TypeScript strict, ESM, zod on every external input. Money = integer paise. Dates = IST.
- All tenant queries go through `db.tenantTx(tenantId, …)` — never query tenant tables from `systemTx`.
- Every mutation writes an audit entry in the same transaction (`AuditService.record`). Never log secrets.
- New route ⇒ add it to `docs/openapi.yaml`, regenerate the client, add `@Perm` (or `@Public` deliberately).
- New tenant table ⇒ sync columns (+ `field_versions` if synced) + `CALL make_tenant_table(...)` + grants to `worko_app`; to sync it to devices add a registry entry.
- Server-side changes to synced rows ⇒ `SyncService.serverPatch` (keeps field versions) and `RealtimeService.publish` after commit.
- Tests must not depend on the wall clock (quiet hours!) — pin prefs/times.
- Client-scoped data: filter lists with `clientScopeSql(actor, module, action, params)`; check single rows with `can(actor, module, action, clientCtx(visibilityOf(row)))`; answer 404 for invisible rows. Visibility changes only via `ClientsService.setAccess` (revocations).
- Secrets/PII: encrypt with `KeyService` (AAD `entity:id:field`), reveal only behind `requireElevated(actor)` + audit; never put plaintext in audit diffs, logs or sync.
- Never hard-code statutory due dates or prices — rule packs / rate tables.
- Uncertain external behaviour ⇒ adapter + mock + `// VERIFY AGAINST OFFICIAL DOCS` + KNOWN_GAPS entry.
- UI strings via `@worko/i18n` keys; colours via `@worko/ui-tokens`; product name via `PRODUCT`.

## Definition of done (per module)
Migration · API with validation + permission check + audit entry · web screen · mobile screen · desktop behaviour ·
unit + integration tests · demo seed data · PROGRESS.md line.
