import { AGEING_BUCKETS, allocateFifo, type AgeingBucket, type Allocation, type OpenItem } from '@worko/domain';

/** Parses a rupee amount typed by a user ("1,23,456.5") into integer paise without float arithmetic. */
export function parseRupees(input: string): number | null {
  const s = input.replace(/[,\s₹]/g, '');
  const m = /^(\d{1,13})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** Paise → editable rupee string ("1234.50"), integer maths only. */
export function paiseToInput(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '';
  const neg = paise < 0; const a = Math.abs(paise);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

// ---------- Invoice state → actions ----------

export type InvoiceLike = {
  kind: 'invoice' | 'credit_note' | 'debit_note'; status: 'draft' | 'issued' | 'partially_paid' | 'paid' | 'cancelled';
  balancePaise: number; allocatedPaise?: number; tdsPaise?: number; creditedPaise?: number;
};
export type InvoiceAction = 'edit' | 'delete' | 'issue' | 'cancel' | 'note' | 'send' | 'paymentLink' | 'followUp' | 'pdf';
type Can = (module: 'billing', action: 'create' | 'edit' | 'approve' | 'print') => boolean;

/** What the UI offers for an invoice in a given state; the server re-checks every one. */
export function allowedActions(inv: InvoiceLike, can: Can): InvoiceAction[] {
  const out: InvoiceAction[] = [];
  const open = inv.status === 'issued' || inv.status === 'partially_paid';
  if (inv.status === 'draft') {
    if (can('billing', 'edit')) out.push('edit', 'delete', 'issue');
    return out;
  }
  if (can('billing', 'print')) out.push('pdf');
  if (inv.status === 'cancelled' || inv.kind === 'credit_note') return out;
  if (can('billing', 'edit')) {
    out.push('send');
    if (open && inv.balancePaise > 0) out.push('paymentLink', 'followUp');
  }
  if (inv.kind === 'invoice' && can('billing', 'approve')) {
    out.push('note');
    const settled = (inv.allocatedPaise ?? 0) + (inv.tdsPaise ?? 0) + (inv.creditedPaise ?? 0);
    if (inv.status === 'issued' && settled === 0) out.push('cancel');
  }
  return out;
}

// ---------- Tax display ----------

export type TaxRow = { key: 'taxable' | 'cgst' | 'sgst' | 'igst' | 'reimbursement' | 'roundOff' | 'total'; paise: number };
type Totals = { supplyType: 'intra' | 'inter' | 'unregistered'; taxablePaise?: number; cgstPaise?: number; sgstPaise?: number; igstPaise?: number; reimbursementPaise?: number; roundOffPaise?: number; totalPaise: number };

/** Server-computed totals as display rows: CGST+SGST for intra-state, IGST for inter-state, none when unregistered. */
export function taxRows(i: Totals): TaxRow[] {
  const rows: TaxRow[] = [{ key: 'taxable', paise: i.taxablePaise ?? 0 }];
  if (i.supplyType === 'intra') rows.push({ key: 'cgst', paise: i.cgstPaise ?? 0 }, { key: 'sgst', paise: i.sgstPaise ?? 0 });
  if (i.supplyType === 'inter') rows.push({ key: 'igst', paise: i.igstPaise ?? 0 });
  if (i.reimbursementPaise) rows.push({ key: 'reimbursement', paise: i.reimbursementPaise });
  if (i.roundOffPaise) rows.push({ key: 'roundOff', paise: i.roundOffPaise });
  rows.push({ key: 'total', paise: i.totalPaise });
  return rows;
}

// ---------- Receipt allocation ----------

export type OpenInvoice = OpenItem & { number: string | null; dueDate: string | null };
export type AllocationPlan = { allocations: Allocation[]; advancePaise: number; advanceTdsPaise: number; errors: Array<'overAllocated' | 'overBalance' | 'tdsMismatch'> };

/**
 * Preview of how a receipt is applied. Without overrides: FIFO (same rule as the server, from @worko/domain).
 * With manual amounts (cash per invoice, paise): TDS still goes first, oldest first, and the cash remainder is the advance.
 */
export function planAllocation(amountPaise: number, tdsPaise: number, items: OpenInvoice[], manual?: Record<string, number>): AllocationPlan {
  if (!manual) {
    const r = allocateFifo(amountPaise, tdsPaise, items);
    return { allocations: r.allocations, advancePaise: r.advance.amountPaise, advanceTdsPaise: r.advance.tdsPaise, errors: [] };
  }
  const errors: AllocationPlan['errors'] = [];
  let tds = tdsPaise; let cash = 0;
  const allocations: Allocation[] = [];
  for (const it of items) {
    const c = manual[it.id] ?? 0;
    const t = Math.min(tds, Math.max(0, it.balancePaise - c));
    if (c + t > it.balancePaise) errors.push('overBalance');
    if (c + t > 0) allocations.push({ invoiceId: it.id, amountPaise: c, tdsPaise: t });
    tds -= t; cash += c;
  }
  if (cash > amountPaise) errors.push('overAllocated');
  if (tds > 0) errors.push('tdsMismatch');
  return { allocations, advancePaise: Math.max(0, amountPaise - cash), advanceTdsPaise: tds, errors: [...new Set(errors)] };
}

// ---------- Ageing ----------

export type AgeingRow = { clientId?: string; buckets?: Partial<Record<AgeingBucket, number>>; totalPaise?: number };

/** Σ of the bucket columns and Σ of client balances; the report shows both and flags a mismatch. */
export function ageingCheck(rows: AgeingRow[], totals: Partial<Record<AgeingBucket, number>> & { totalPaise?: number }) {
  const bucketSum = Object.fromEntries(AGEING_BUCKETS.map((b) => [b, rows.reduce((s, r) => s + (r.buckets?.[b] ?? 0), 0)])) as Record<AgeingBucket, number>;
  const sumOfBalances = rows.reduce((s, r) => s + (r.totalPaise ?? 0), 0);
  const sumOfBuckets = AGEING_BUCKETS.reduce((s, b) => s + (totals[b] ?? 0), 0);
  const ok = sumOfBalances === (totals.totalPaise ?? 0) && sumOfBuckets === sumOfBalances && AGEING_BUCKETS.every((b) => bucketSum[b] === (totals[b] ?? 0));
  return { bucketSum, sumOfBalances, sumOfBuckets, ok };
}

export const TALLY_ACCOUNT_KEYS = ['sales', 'output_cgst', 'output_sgst', 'output_igst', 'round_off', 'reimbursement', 'tds_receivable', 'bank', 'cash'] as const;
