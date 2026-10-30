# Getting started

## 1. Create the firm
Sign up with the firm name, a short **Firm ID** (used at every sign-in, e.g. `sharma-associates`), your state and the
first partner's name, e-mail and password. That partner has every permission. Turn on two-factor sign-in straight away:
**Security → Two-factor** (any authenticator app).

## 2. Billing entities and fees
- **Settings → Entities**: one entity is created for you. Add its GSTIN (Worko checks the GSTIN checksum before anything
  else), address, bank details and the invoice prefix (e.g. `SA`). Add more entities if the firm bills from a second
  firm/LLP or a non-GST proprietorship; each has its own gap-free invoice series per financial year (`SA/2627/0001`).
  The prefix locks once an invoice is issued.
- Choose the default entity in billing settings.
- **Settings → Services**: install the default service catalogue (GSTR-1, GSTR-3B, TDS returns, ITR, ROC filings, audits…).
  Each service has its checks (checklist), SLA and the compliance rule that gives it due dates. Add your own services.
- **Settings → Rates**: the fee per service (and per client where it differs), effective from a date. Auto-billing uses
  these; nothing is priced without a rate.
- **Settings → Terms & follow-ups**: payment terms and the reminder ladder for unpaid invoices.

## 3. People and roles
**Team → Add user**. Built-in roles:

| Role | Can, by default |
|---|---|
| Partner | Everything, firm-wide |
| Manager | Work, clients, billing, reports for their team (not settings, users, audit log or the vault) |
| Senior | Their own clients' tasks, compliance, documents, time, notices, audit work, communication |
| Article / Intern | Their own tasks, time, HR requests, documents and registers; no fees or invoices |
| Accountant | Billing, receipts, clients and reports (no task work) |
| Admin / Office | Settings, users, registers, HR, DSC register, audit log; clients view-only |
| Auditor (read-only) | View and export everything except the vault |

Roles are the built-in ones above (a role editor is not available yet). Partners can mark a client **sensitive** so
only named people see it. Set each person's reporting **manager** (timesheet and leave approvals go to them) and, in **Settings → HR**,
cost rates, office geofence/IP for attendance and leave types.

## 4. Clients
- **Clients → New**: type the GSTIN — the PAN, state and (where the lookup provider is configured) name are filled in;
  you can always type them yourself. Duplicates are caught by PAN, GSTIN or phone.
- **Clients → Import** takes an Excel/CSV file, shows a preview with every row's problems, and imports only after you
  confirm.
- On the client's page (the 360° view) set the partner, manager and staff (this decides who sees the client), contacts,
  groups, and **Services** — subscribe the client to the services you do for them (with an assignee override if needed).
- Portal passwords for government sites go in the client's **Credentials** tab (encrypted; revealing one needs the
  permission, may ask you to confirm your identity again, and is recorded in the audit log).

## 5. First month
**Tasks → Auto-create → preview** the month: Worko lists one task per client × service × period with due dates from the
rule pack. **Commit** creates them (running it again never duplicates). After that it runs by itself on the 1st of each
month. Invite clients to the portal from the client's page (**Portal → Invite**).

Install the desktop app and the Android app for staff who need offline work, tray reminders or attendance.
