# A day at the firm

The release of Worko is tested against exactly this day ("the firm's day", ten steps — see docs/PRD.md §15).

## Partner
- **Home** shows what needs you: approvals, overdue work, unbilled amount, outstanding receivables, notices due.
- **Compliance** matrix: every client × return for the period, with state (open / done / overdue / not created).
  When the government extends a due date, record the extension and see "N due dates / M clients" before approving it.
- Approve and issue invoices (**Billing**), record UDINs for audit reports (**Audit engagements**), sign off engagements.
- **Reports**: unbilled work, ageing, job profitability (P&L), utilisation — the totals agree with the Billing and Time
  screens. Ask in plain English ("unbilled GST work FY 25-26 by user") if AI is switched on; you get an ordinary report
  you can check and save.

## Manager
- **Tasks** (list, kanban, calendar): filter by your team; reassign; bulk changes can be undone.
- Review work sent to you (status **Review**) and mark it done; tasks with a required UDIN cannot be closed without one.
- Approve timesheets and leave for people reporting to you (never your own).
- Watch **Notifications** for escalations (documents still pending from a client, overdue tasks, overdue invoices).

## Article / intern
- Morning: **Attendance → Check in** (desktop/web or Android; location only at the moment you check in, or the office
  network). Then **Tasks** shows only your work.
- Start the **timer** on a task, tick its checks as you go, note pending issues (e.g. "purchase register awaited") and
  set the task to **Pending client** when you are waiting for them.
- Send to **Review** with a reviewer when done. Submit your week's timesheet on Friday.
- On Android: scan documents into the client's file; everything works offline and syncs when you are back online.

## Accountant
- **Billing → Unbilled**: done work not yet invoiced, priced from the rate table. **Auto-draft** makes one draft per
  client; check and issue. CGST+SGST or IGST is decided by place of supply.
- **Receipts**: record bank/cash/cheque receipts with TDS (section 194J etc.); they settle the oldest invoices first.
  Online payments through payment links arrive by themselves (gateway receipts).
- Follow-ups go out on the ladder until the invoice is paid or the client promises a date. **Tally** export from the
  desktop app.

## Client (portal)
- Open the firm's portal link, enter your e-mail or mobile number and the 6-digit code you receive (no password).
- See what the firm needs from you (requests), upload documents, reply, see your invoices and receipts, pay online,
  sign documents sent for e-signature. You only see what the firm has granted (e.g. only ITR documents, no invoices).
- One login can cover several group companies; switch between them at the top.
