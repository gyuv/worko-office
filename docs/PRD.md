# Worko — Product Requirements

**Promise:** every piece of work is created once, has an owner and due date, moves through defined stages, gets billed,
gets collected, and nothing is forgotten. Market: India (INR, April–March FY, lakh/crore, IST). Users: CA/CS/tax firms, 1–60+ users,
multi-partner, multi-branch, multi-entity billing. Surfaces: web (+PWA, client portal), Electron desktop (offline), Android (offline).

The owner's master prompt is the authoritative long-form spec; this document turns it into testable requirements. Section
numbers (§) refer to that prompt.

## Personas
Partner · Manager · Senior · Article/Intern · Accountant · Admin/Office · Client user · Freelancer · Super-admin.

## Modules, key stories and acceptance criteria

| # | Module | Key user stories | Acceptance criteria (abridged) |
|---|---|---|---|
| M1 | Tenancy, auth, permissions, audit (§4, §11) | As admin I control every user's rights per module/action/scope; I see who did what. | RLS blocks cross-tenant access; role editor covers module×action×scope + field hiding + sensitive clients; 2FA TOTP; device list + remote logout/wipe; immutable hash-chained audit with export. |
| M2 | Clients & contacts (§5.1) | Add a client by typing a GSTIN; import 200 clients from Excel with a preview. | GSTIN checksum + provider autofill + manual fallback; multiple GSTINs/contacts; groups (many-to-many); duplicate detection by PAN/GSTIN/phone; custom fields; 360° single screen. |
| M3 | Credential vault + extension (§5.1) | Reveal a portal password only if allowed; autofill on official portals. | Envelope-encrypted; reveal = permission + optional step-up + audit; extension only on allow-listed domains; never in logs/backups/messages. |
| M4 | Leads, proposals (§5.2) | Convert accepted proposal into services + engagement letter. | Kanban pipeline; e-accept link; versioned proposals; one-click conversion. |
| M5 | Tasks & checks (§5.3) | System creates GSTR-3B tasks for all clients each month and assigns them. | Service catalogue with checks/SLA; idempotent auto-creation per client×service×period with preview; roles leader/manager/assignee/reviewer; pending issues; to-do templates; list/kanban/calendar/gantt/sprint; bulk with undo; every task ends billed/free/deleted. |
| M6 | Compliance engine & trackers (§5.4, §6) | Publish a due-date extension and see impact before approving. | Rules are data with effective dates; golden tests; matrix view; statutory + act-by dates; extension diff "N due dates / M clients"; indicative late-fee calculators. |
| M7 | Notices (§5.5) | Upload a notice PDF; AI drafts fields; I confirm. | Status workflow; hearing calendar; escalation; ageing; litigation levels. |
| M8 | Audit workpapers & UDIN (§5.6) | Close an audit task only after recording its UDIN. | Programmes with preparer/reviewer/partner sign-off; PBC lists; UDIN format validation + deep link to ICAI portal (no imitation). |
| M9 | Billing & collections (§5.7) | Auto-draft invoices for completed GST tasks; follow up dues until paid. | GST-compliant per firm entity series, CGST/SGST vs IGST by place of supply; credit/debit notes; receipts with TDS; Razorpay links + webhook; ageing buckets; follow-up ladder with stop-on-payment. |
| M10 | Time, costing, capacity (§5.8) | See which jobs lose money. | Timers/approval; cost rate per user; job P&L; capacity heat map; live activity. |
| M11 | Portal status providers (§5.9) | Task completes when GST portal status confirms filing. | Pluggable providers + mock; last-synced display; no CAPTCHA automation. |
| M12 | Documents & registers (§5.10) | Scan on Android, file into client/FY/category. | Versioning, OCR search, share links, inward/outward registers with signatures, DSC register with 60/30/15/7/0 alerts, licences, e-sign incl. bulk. |
| M13 | Communication hub (§5.11, §9) | One timeline per client across email/WhatsApp/notes. | Gmail/Outlook OAuth; WhatsApp Cloud API via providers, consent + opt-out, template manager, rate table + caps; team chat offline-capable; calendar sync. |
| M14 | HR (§5.12) | Article checks in by geofence; study leave tracked. | Geofence/IP attendance; leave types incl. article-specific; comp-off auto-grant; expense advances with partial approval. |
| M15 | Automation (§5.13) | Turn on the Document Collection Agent. | Trigger→conditions→actions builder; prebuilt agents; dry-run; run history; quiet hours; cost meter. |
| M16 | Client portal (§5.14) | Client uploads documents and pays online. | White-label; OTP login; granular visibility; instant reflection in office apps. |
| M17 | Dashboards & reports (§5.15) | Partner sees unbilled, ageing, utilisation that reconcile. | All listed reports with filters/drill-down/schedule/export; report builder; NL query → permission-checked report definition. |
| M18 | Integrations (§5.16) | Push receipts to Tally from desktop. | Local Tally XML connector with mapping, dry-run, sync log; public API + webhooks + API keys. |
| M19 | Notifications (§7) | Desktop toast fires for overdue task even offline. | 7 channels; cross-device read dedupe; escalation; digests; quiet hours; ack for critical; delivery log. |
| M20 | Sync (§8) | Offline Android change reaches manager's desktop in seconds. | Outbox + cursor pull + WS hints; field merge; strict tables; permission purge; remote wipe; simulator convergence. |
| M21 | AI (§10) | Ask "unbilled GST work FY 25-26 by user". | Opt-in; redaction; sources shown; human approval before anything is sent/filed; no-AI mode. |
| M22 | SaaS & admin (§4, §12) | Super-admin sets plans/seats/flags. | Switchable multi-tenancy features; impersonation with consent logging; DPDP tooling. |

## Non-functional (§12)
p95 < 300 ms common reads; 100k-row virtualised lists; search < 200 ms; desktop cold start < 3 s; mobile < 2.5 s; WCAG 2.1 AA;
≥ 80 % coverage on domain/rules/sync/billing; India residency.

## End-to-end acceptance: "The firm's day" (§15)
The ten-step scenario in the master prompt is the release gate; each step maps to an e2e test in Phase 12.
