import { allocateFifo, daysBetween, type Allocation } from '@worko/domain';
import type { LocalRow } from '@worko/sync';

/**
 * Billing on the phone (D72): invoice + receipt headers sync read-only. bigint paise arrive as decimal strings
 * ('11800'), so every money field goes through `parsePaise` — integers only, never floats.
 */

const INT = /^-?\d+$/;

/** Integer paise from a synced value: number (integer) or decimal-integer string. Anything else → 0. */
export function parsePaise(v: unknown): number {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v !== 'string') return 0;
  const s = v.trim();
  if (!INT.test(s)) return 0;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : 0;
}

/** User-typed rupees ("1,180.50", "₹ 500") → paise without float maths; null when invalid. */
export function rupeesInputToPaise(input: string): number | null {
  const s = input.replace(/[₹,\s]/g, '');
  if (!s) return 0;
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(n) ? n : null;
}

export type InvoiceStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'cancelled';
export type InvoiceItem = {
  id: string; clientId: string; kind: string; status: InvoiceStatus; number: string | null;
  issueDate: string | null; dueDate: string | null; totalPaise: number; balancePaise: number;
  allocatedPaise: number; tdsPaise: number; creditedPaise: number; billToName: string; promiseToPay: string | null;
};

const str = (v: unknown) => (v == null || v === '' ? null : String(v).slice(0, 10));

export function toInvoiceItem(r: LocalRow): InvoiceItem {
  const f = r.fields;
  const billTo = (f.bill_to && typeof f.bill_to === 'object' ? f.bill_to : {}) as { name?: unknown };
  return {
    id: r.id, clientId: String(f.client_id ?? ''), kind: String(f.kind ?? 'invoice'), status: String(f.status ?? 'draft') as InvoiceStatus,
    number: f.number ? String(f.number) : null, issueDate: str(f.issue_date), dueDate: str(f.due_date),
    totalPaise: parsePaise(f.total_paise), balancePaise: parsePaise(f.balance_paise), allocatedPaise: parsePaise(f.allocated_paise),
    tdsPaise: parsePaise(f.tds_paise), creditedPaise: parsePaise(f.credited_paise),
    billToName: typeof billTo.name === 'string' ? billTo.name : '', promiseToPay: str(f.promise_to_pay),
  };
}

export const toInvoiceItems = (rows: LocalRow[]) => rows.filter((r) => !r.deleted).map(toInvoiceItem);

/** Receivable with a balance: issued/partially paid invoices and debit notes (credit notes reduce, never owe). */
export const isOpen = (i: InvoiceItem) => (i.status === 'issued' || i.status === 'partially_paid') && i.kind !== 'credit_note' && i.balancePaise > 0;

/** Days past due as of `today` (yyyy-mm-dd, IST); 0 when not due / no due date. Pure — the caller passes today. */
export function daysOverdue(i: Pick<InvoiceItem, 'dueDate'>, today: string): number {
  if (!i.dueDate) return 0;
  return Math.max(0, daysBetween(i.dueDate, today));
}
export const isOverdue = (i: InvoiceItem, today: string) => isOpen(i) && daysOverdue(i, today) > 0;

/** Oldest due first (falls back to issue date), then number — same order the server allocates FIFO in. */
export function fifoOrder(items: InvoiceItem[]): InvoiceItem[] {
  const key = (i: InvoiceItem) => i.dueDate ?? i.issueDate ?? '9999-12-31';
  return [...items].sort((a, b) => key(a).localeCompare(key(b)) || (a.issueDate ?? '').localeCompare(b.issueDate ?? '') || (a.number ?? '').localeCompare(b.number ?? ''));
}

export type Outstanding = { open: InvoiceItem[]; outstandingPaise: number; overduePaise: number; overdueCount: number; maxDaysOverdue: number; advancePaise: number; netPaise: number };

/** Client outstanding from synced headers; advance = unallocated cash of synced receipts. */
export function clientOutstanding(invoices: InvoiceItem[], receipts: LocalRow[], clientId: string, today: string): Outstanding {
  const open = fifoOrder(invoices.filter((i) => i.clientId === clientId && isOpen(i)));
  let outstandingPaise = 0; let overduePaise = 0; let overdueCount = 0; let maxDaysOverdue = 0;
  for (const i of open) {
    outstandingPaise += i.balancePaise;
    const d = daysOverdue(i, today);
    if (d > 0) { overduePaise += i.balancePaise; overdueCount++; maxDaysOverdue = Math.max(maxDaysOverdue, d); }
  }
  const advancePaise = receipts.filter((r) => !r.deleted && r.fields.client_id === clientId).reduce((s, r) => s + parsePaise(r.fields.unallocated_paise), 0);
  return { open, outstandingPaise, overduePaise, overdueCount, maxDaysOverdue, advancePaise, netPaise: outstandingPaise - advancePaise };
}

export type InvoiceFilter = 'all' | 'unpaid' | 'overdue';

export function filterInvoices(items: InvoiceItem[], filter: InvoiceFilter, today: string, q = '', clientNames?: Map<string, string>): InvoiceItem[] {
  const needle = q.trim().toLowerCase();
  return items
    .filter((i) => i.status !== 'draft')
    .filter((i) => filter === 'all' || (filter === 'unpaid' ? isOpen(i) : isOverdue(i, today)))
    .filter((i) => !needle || [i.number, i.billToName, clientNames?.get(i.clientId)].some((x) => x?.toLowerCase().includes(needle)))
    .sort((a, b) => (b.issueDate ?? '').localeCompare(a.issueDate ?? '') || (b.number ?? '').localeCompare(a.number ?? ''));
}

/** Collections list: overdue open invoices, most days overdue first, then larger balance. */
export function collectionsToday(items: InvoiceItem[], today: string): Array<InvoiceItem & { days: number }> {
  return items.filter((i) => isOverdue(i, today)).map((i) => ({ ...i, days: daysOverdue(i, today) }))
    .sort((a, b) => b.days - a.days || b.balancePaise - a.balancePaise || a.id.localeCompare(b.id));
}

export const RECEIPT_MODES = ['cash', 'bank', 'upi', 'cheque', 'online'] as const;
export type ReceiptMode = (typeof RECEIPT_MODES)[number];

export type ReceiptForm = { amount: string; tds: string; tdsSection: string; mode: string; reference: string; receivedOn: string };
export type ReceiptError = 'amount' | 'tds' | 'tdsSection' | 'mode' | 'date' | 'empty';

/** Validates the form into a REST body (allocations omitted ⇒ server FIFO). */
export function buildReceipt(clientId: string, f: ReceiptForm):
  { ok: true; body: { clientId: string; receivedOn: string; amountPaise: number; tdsPaise: number; tdsSection: string | null; mode: ReceiptMode; reference: string | null } }
  | { ok: false; errors: ReceiptError[] } {
  const errors: ReceiptError[] = [];
  const amount = rupeesInputToPaise(f.amount); const tds = rupeesInputToPaise(f.tds);
  if (amount === null) errors.push('amount');
  if (tds === null) errors.push('tds');
  if ((tds ?? 0) > 0 && !f.tdsSection.trim()) errors.push('tdsSection');
  if (!RECEIPT_MODES.includes(f.mode as ReceiptMode)) errors.push('mode');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.receivedOn)) errors.push('date');
  if (amount !== null && tds !== null && amount + tds <= 0) errors.push('empty');
  if (errors.length) return { ok: false, errors };
  return { ok: true, body: { clientId, receivedOn: f.receivedOn, amountPaise: amount!, tdsPaise: tds!, tdsSection: tds! > 0 ? f.tdsSection.trim() : null,
    mode: f.mode as ReceiptMode, reference: f.reference.trim() || null } };
}

/** Indicative FIFO preview over the client's synced open invoices; the server decides the final allocation. */
export function allocationPreview(open: InvoiceItem[], amountPaise: number, tdsPaise: number): { allocations: Allocation[]; advancePaise: number } {
  const r = allocateFifo(amountPaise, tdsPaise, fifoOrder(open.filter(isOpen)).map((i) => ({ id: i.id, balancePaise: i.balancePaise })));
  return { allocations: r.allocations, advancePaise: r.advance.amountPaise + r.advance.tdsPaise };
}

export type Grant = { module: string; action: string; scope: string };
/** UI gating only (the server enforces): any grant other than scope 'none'. */
export const hasGrant = (grants: Grant[] | undefined, module: string, action: string) =>
  !!grants?.some((g) => g.module === module && g.action === action && g.scope !== 'none');
