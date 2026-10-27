# Decisions

| # | Decision | Why |
|---|---|---|
| D1 | pnpm + Turborepo monorepo, TypeScript ESM everywhere (API included) | Shared zod schemas/types across API, web, desktop, mobile; ESM avoids CJS/ESM interop errors with shared packages. |
| D2 | **Drizzle** over Prisma, with hand-written ordered SQL migrations in `apps/api/db` | RLS policies, triggers, procedures and partial indexes are first-class in SQL; Prisma's migration engine fights RLS. Drizzle gives typed queries without owning the schema DDL. |
| D3 | Tenant isolation via Postgres RLS on `current_setting('app.tenant_id')` set with `SET LOCAL` per transaction; tables use `FORCE ROW LEVEL SECURITY` | Defence in depth: a missing `WHERE tenant_id` in app code cannot leak data. Verified locally (cross-tenant insert rejected). |
| D4 | Sync cursor = global Postgres sequence bumped by trigger on every insert/update | Monotonic, gap-tolerant, no clock dependence; clients pull `cursor > n`. |
| D5 | Field-level LWW by **server receive order** (not client clocks); losing values go to a conflict log. "Strict" tables (invoice, receipt, filed status) use optimistic concurrency and reject stale writes | Immune to device clock skew; money/legal records never silently overwritten (spec §8). |
| D6 | Due dates as structured expressions `{anchor, addMonths, day}` + per-period overrides, not free-text | Machine-checkable by JSON Schema, golden-testable, editable by non-engineers in an admin UI. Free-text like "7th of next month" is rendered from the structure. |
| D7 | Rule versions are effective-dated by period start; a pack version is a full snapshot | Firms can diff two versions and approve; past periods keep their historical rule. |
| D8 | Money as integer paise | No floating-point drift in GST splits and ledgers. |
| D9 | Statutory "due" and holiday-shifted "act-by" both stored | Spec §5.4; shifting is a per-rule policy since not every law shifts. Default `none`. |
| D10 | Regime: FY ≤ 2025-26 labelled "FY/AY" (ITA 1961); from 2026-27 "Tax Year" (ITA 2025) | Spec §6; both coexist; form names remain data. |
| D11 | Web: React + Vite SPA; client portal as a separate Vite entry with white-label theme (no SSR needed — portal is behind login) | Simpler than Next.js; shares renderer with Electron. |
| D12 | Desktop: Electron + better-sqlite3 with SQLCipher; mobile: Expo dev-client + op-sqlite (SQLCipher) | Both run `@worko/sync` unchanged. |
| D13 | AI via one `AiService` with redaction; default model configurable via `AI_MODEL` env | Model-agnostic; no-AI mode keeps everything functional. |
| D14 | UDIN: record + validate format + deep-link to the official ICAI portal only | ICAI warns against look-alike interfaces; we never imitate generation. |
| D15 | GSTIN checksum validated locally (mod-36 algorithm) before any provider lookup | Saves paid lookup credits, instant feedback. |
| D16 | Audit log is append-only (no UPDATE/DELETE policy) and hash-chained (`prev_hash` → `hash`) | Tamper-evidence for finance and credential reveals (spec §11). |
