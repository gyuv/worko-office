# PROGRESS

_Last session: 2026-10-28._ **Phase 5 complete and reviewed** (D66–D83). Resume at Phase 6 in docs/ROADMAP.md.

## Test status — 381 tests, all green (build/typecheck/lint clean, 12 packages)
| Package | Tests | Notes |
|---|---|---|
| `@worko/api` | 108 | + Phase 5: GST split intra/inter/unregistered, rounding, gap-free numbering under concurrency, immutability (REST + SQL triggers), notes capped per tax head, FIFO + TDS + advances, ageing ≡ balances, auto-billing/retainers idempotent, retry-safe follow-ups, webhook signature/replay/mock-route lockdown, Tally dry-run/export, scoped config; Phase 4: catalogue install, auto preview≡commit idempotent, assignment fallback, checks/review/close rules, task scope + sync + SQL≡canTask property test, bulk + undo (stale/invalid skips), to-dos owner-only, extension impact/approve, pack diff/approve, matrix, late fee, monthly job; Phase 3: clients CRUD/search/360, PII reveal + step-up, visibility & revocation, scope key, device-sync validation, register numbering, field hiding, merge, vault + extension pairing/restrictions, documents (signed downloads, malware/HTML refusal, versions, legal hold, share links, access log), registers + PDF + signatures, import/export, users deactivation, SQL≡can() property test (3000 cases), demo seed integrity, Phase 3 review regressions (child scope, delete cascade, access approval, counts, export audit, immutable register date, session-bound URLs, share lockout) |
| `@worko/sync` | 86 | + scope-key re-pull |
| `@worko/extension` | 29 | manifest allow-list, field finders, background fill flow |
| `@worko/mobile` | 37 | + paise parsing, outstanding, collections, allocation preview; + my tasks, task rules, compliance grouping, act-by reminders; clients search, links, register patches, signature queue |
| `@worko/web` | 43 | + rupee parsing, invoice actions by state/permission, tax rows, allocation plan, ageing check, issue + receipt flows; + kanban/sprint/gantt/calendar logic, bulk undo, auto-create wizard, matrix cells; clients list/create (GSTIN lookup, duplicates), step-up reveal, import wizard, registers |
| `@worko/domain` | 34 | + billing maths, Tally XML, + taskCtx/task rules, + client ctx, portal allow-list |
| others | 42 | rules 16, notify 9, desktop 8, ui-tokens 4, api-client 4, i18n 3 |

Verified manually (headless Chromium, real API, demo firm): partner client list (47 active), client 360, credential reveal through the step-up dialog, documents, registers, import wizard; article at phone width sees exactly their 12 clients and gets "not found" for others.

## Phase 3 deliverables
Migration `0005`; client master + visibility + revocation; envelope encryption; vault + MV3 extension; documents + share links; registers + receipts; import/export; GSTIN lookup adapter; users PATCH; web 360/import/documents/registers screens; Android offline clients/registers/signatures/scan upload; demo seed with 50 clients.

## Phase 4 deliverables
Migrations `0007`–`0008`; service catalogue + client subscriptions; tasks (checks, leader/manager/assignee/reviewer, review approval, billed/free/deleted outcome) synced with field validation; bulk with undo; to-dos + templates; idempotent auto-creation (preview/commit + monthly job); per-tenant rule packs with diff/approval; extensions with impact preview/approval; compliance matrix; indicative late-fee calculator (UNVERIFIED sample rates). Web: tasks list/kanban/calendar/gantt/sprint, drawer, auto-create wizard, services settings + client services tab, compliance matrix/extensions/packs/late fee, to-dos. Android: my tasks, task detail, to-dos, compliance due this month, offline act-by reminders. Smoke-tested web against the real API with the demo firm.

## Phase 5 deliverables
Migrations `0009`–`0010`; billing entities with gap-free per-FY series; rate tables (no hard-coded prices); GST invoices (CGST/SGST vs IGST, bill of supply, reimbursements, rupee round-off), immutable after issue; credit/debit notes capped per tax head; receipts with TDS, FIFO/manual allocation, advances; ageing + unbilled reports; auto-billing + retainers (task outcome billed); follow-up ladder (retry-safe, link-only messages); payment links (mock + Razorpay skeleton, signed webhooks); Tally XML dry-run/export with ledger map; invoice/receipt registers. Web: invoices, editor, auto-billing/retainers, unbilled, ageing, receipts, client billing tab, billing settings + Tally. Android: client outstanding, invoices, record receipt (online), collections today. Web smoke-tested against the real API with the demo firm. Razorpay, Tally XML, WhatsApp/email and GST particulars are UNVERIFIED (KNOWN_GAPS).

## Next (Phase 6)
Time, costing, capacity; attendance (geofence), leave, expenses.
