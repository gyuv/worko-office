# Modules

## Tasks and compliance
- Every task has a client (or is firm work), a service, a period (e.g. `2026-10`), roles (leader, manager, assignee,
  reviewer), checks, a **statutory due date** and an **act-by date** (the due date shifted for holidays where the law
  allows — both are shown). Status: open → in progress → pending client → review → done. Every task finally ends as
  **billed**, **free** or **deleted**, so nothing done is left unbilled by accident.
- Due dates come from the **rule pack** (data, with effective dates — never typed into code). Extensions are recorded
  and approved with an impact preview. Late-fee calculators are **indicative** only.
- Auto-creation runs monthly and is idempotent; deleted tasks are not recreated. **To-dos** are personal checklists.
- Status providers can mark a GST task as filed when the portal status confirms it (where configured; no CAPTCHA
  automation — ever).

## Billing and collections
- Invoices per entity with gap-free numbering per financial year; once issued they cannot be edited — use a credit or
  debit note, or cancel (the number stays used). Reimbursements are outside GST.
- Auto-billing from done tasks at rate-table prices; monthly retainers bill once per subscription per period.
- Receipts with TDS, advances, FIFO allocation; ageing buckets (not due, 0–30, 31–60, 61–90, 90+).
- Payment links (Razorpay) — the payment is recorded only from the gateway's signed confirmation. Follow-up ladder by
  e-mail/WhatsApp with escalation to the partner; it stops on payment or a promise-to-pay date.
- Tally: map ledgers, dry-run, export XML; the sync log prevents double posting.

## Time, costing and HR
- Timers (one at a time, server-timed, capped for forgotten timers) and manual entries; weekly submit, manager approval;
  approved time cannot be changed (reversal only).
- Job P&L: revenue from invoices minus time at each person's cost rate; WIP for unbilled work; capacity heat map.
  Cost figures are hidden from roles without cost visibility.
- Attendance by geofence or office network; leave types including article-specific ones (study/exam leave),
  comp-off granted automatically for approved holiday work; expenses and advances with partial approval.

## Communication
- One timeline per client: e-mail (Gmail/Outlook connected accounts), WhatsApp (Cloud API, templates), SMS, notes,
  portal messages. Consent and opt-out (STOP) are honoured; quiet hours hold messages to clients until morning.
- Templates with placeholders; rate table and monthly caps on paid channels; broadcasts.
- Team chat (works offline on desktop/Android), calendar with Google/Outlook sync, booking pages for client meetings.

## Practice: notices, audits, DSC, e-sign
- **Notices**: upload the notice PDF; fields can be drafted from its text (AI, if enabled) for you to confirm; status
  workflow, hearings calendar, response due dates, escalation, ageing, appeal levels.
- **Audit engagements**: programmes with preparer → reviewer → partner sign-off, workpapers, PBC (client request) lists,
  **UDIN** recording with format check and a link to the official ICAI UDIN portal. The audit task can't be closed
  (or billed) until its UDIN is recorded.
- **DSC register**: custody (with whom), expiry alerts at 60/30/15/7/0 days. **Licences** with renewal alerts.
- **E-signature** (Aadhaar e-sign through a provider), including bulk requests.

## Client portal and leads
- Portal: OTP sign-in, white-label (logo, colours), per-contact grants (documents by category/FY, invoices, payments,
  notices), uploads land in the client's file and notify the partner/manager instantly.
- **Leads**: pipeline (kanban), duplicate check, versioned proposals with an online accept link, one-click conversion to
  a client with services and an engagement letter.

## Automation and AI
- Rules: trigger → conditions → actions, with a dry-run that changes nothing, run history, quiet hours and cost meter.
  Prebuilt agents: Document Collection, Overdue Nudger, Invoice Follow-up, Renewal Reminder, Hearing Prep, Client
  Onboarding, Portal Upload Triage. A rule pauses itself after repeated failures.
- AI is **off until the firm opts in** (Settings → AI). Data is redacted before it leaves (PAN, GSTIN, Aadhaar, phone,
  e-mail, client names), costs are metered against caps, and every draft (reply, notice fields, classification) waits as
  a **suggestion** for a person to approve. The deployment can be run with AI disabled entirely.

## Reports and dashboards
- Built-in reports (unbilled by client, ageing, job P&L, utilisation, compliance status, notices by authority,
  attendance…), a report builder (dataset → columns → filters → group/totals → drill-down), saved and shared reports,
  role dashboards, exports (CSV, Excel, PDF) and schedules (e-mailed links; the recipient signs in to download).
- Every report runs with **your** permissions — two people can see different totals from the same saved report.
