# PROGRESS

_Last session: 2026-10-28._ **Phase 4 complete and reviewed** (D54–D65). Resume at Phase 5 in docs/ROADMAP.md.

## Test status — 326 tests, all green (build/typecheck/lint clean, 12 packages)
| Package | Tests | Notes |
|---|---|---|
| `@worko/api` | 91 | + Phase 4: catalogue install, auto preview≡commit idempotent, assignment fallback, checks/review/close rules, task scope + sync + SQL≡canTask property test, bulk + undo (stale/invalid skips), to-dos owner-only, extension impact/approve, pack diff/approve, matrix, late fee, monthly job; Phase 3: clients CRUD/search/360, PII reveal + step-up, visibility & revocation, scope key, device-sync validation, register numbering, field hiding, merge, vault + extension pairing/restrictions, documents (signed downloads, malware/HTML refusal, versions, legal hold, share links, access log), registers + PDF + signatures, import/export, users deactivation, SQL≡can() property test (3000 cases), demo seed integrity, Phase 3 review regressions (child scope, delete cascade, access approval, counts, export audit, immutable register date, session-bound URLs, share lockout) |
| `@worko/sync` | 86 | + scope-key re-pull |
| `@worko/extension` | 29 | manifest allow-list, field finders, background fill flow |
| `@worko/mobile` | 28 | + my tasks, task rules, compliance grouping, act-by reminders; clients search, links, register patches, signature queue |
| `@worko/web` | 28 | + kanban/sprint/gantt/calendar logic, bulk undo, auto-create wizard, matrix cells; clients list/create (GSTIN lookup, duplicates), step-up reveal, import wizard, registers |
| `@worko/domain` | 24 | + taskCtx/task rules, + client ctx, portal allow-list |
| others | 42 | rules 16, notify 9, desktop 8, ui-tokens 4, api-client 4, i18n 3 |

Verified manually (headless Chromium, real API, demo firm): partner client list (47 active), client 360, credential reveal through the step-up dialog, documents, registers, import wizard; article at phone width sees exactly their 12 clients and gets "not found" for others.

## Phase 3 deliverables
Migration `0005`; client master + visibility + revocation; envelope encryption; vault + MV3 extension; documents + share links; registers + receipts; import/export; GSTIN lookup adapter; users PATCH; web 360/import/documents/registers screens; Android offline clients/registers/signatures/scan upload; demo seed with 50 clients.

## Phase 4 deliverables
Migrations `0007`–`0008`; service catalogue + client subscriptions; tasks (checks, leader/manager/assignee/reviewer, review approval, billed/free/deleted outcome) synced with field validation; bulk with undo; to-dos + templates; idempotent auto-creation (preview/commit + monthly job); per-tenant rule packs with diff/approval; extensions with impact preview/approval; compliance matrix; indicative late-fee calculator (UNVERIFIED sample rates). Web: tasks list/kanban/calendar/gantt/sprint, drawer, auto-create wizard, services settings + client services tab, compliance matrix/extensions/packs/late fee, to-dos. Android: my tasks, task detail, to-dos, compliance due this month, offline act-by reminders. Smoke-tested web against the real API with the demo firm.

## Next (Phase 5)
Billing, receipts, ageing, auto-billing, follow-ups, reimbursements, payment links, Tally connector, exports.
