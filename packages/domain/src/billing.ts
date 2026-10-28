import type { Paise } from './money.js';

/**
 * Billing arithmetic (M9). Pure and shared by the API, desktop and tests. All money is integer paise.
 *
 * Rounding (D67): every line is rounded to the paisa (qty × rate, then tax per component); the invoice
 * total is rounded to the nearest rupee (half up) and the difference is shown as a separate round-off line.
 * Intra-state CGST and SGST are each computed on the line's taxable value at half the rate, so both
 * halves are always equal on the invoice.
 */

export const INVOICE_KINDS = ['invoice', 'credit_note', 'debit_note'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];
export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const RECEIPT_MODES = ['cash', 'bank', 'upi', 'cheque', 'online'] as const;
export type ReceiptMode = (typeof RECEIPT_MODES)[number];
/** Supply type decided from supplier registration and place of supply. */
export type SupplyType = 'intra' | 'inter' | 'unregistered';

export type LineInput = {
  qty: number; ratePaise: Paise; discountPaise?: Paise; gstRate: number; reimbursement?: boolean;
};
export type LineTax = {
  amountPaise: Paise; taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise; totalPaise: Paise; reimbursement: boolean;
};
export type InvoiceTotals = {
  supplyType: SupplyType; lines: LineTax[];
  taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise; reimbursementPaise: Paise;
  roundOffPaise: Paise; totalPaise: Paise;
};

/** Round half away from zero to an integer (paise). */
const r = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));

export function supplyTypeOf(supplierGstin: string | null | undefined, supplierState: string, posState: string | null | undefined): SupplyType {
  if (!supplierGstin) return 'unregistered';
  return !posState || posState === supplierState ? 'intra' : 'inter';
}

/** Tax for one line. Reimbursements (pure-agent expenses) carry no GST and are outside the taxable value. */
export function lineTax(l: LineInput, supply: SupplyType): LineTax {
  if (!Number.isFinite(l.qty) || l.qty <= 0) throw new Error('qty must be > 0');
  if (!Number.isInteger(l.ratePaise) || l.ratePaise < 0) throw new Error('rate must be integer paise ≥ 0');
  const amount = r(l.qty * l.ratePaise);
  const discount = l.discountPaise ?? 0;
  if (!Number.isInteger(discount) || discount < 0 || discount > amount) throw new Error('discount must be integer paise within the amount');
  const taxable = amount - discount;
  if (l.reimbursement || supply === 'unregistered' || l.gstRate <= 0) {
    return { amountPaise: amount, taxablePaise: l.reimbursement ? 0 : taxable, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: taxable, reimbursement: !!l.reimbursement };
  }
  if (supply === 'intra') {
    const half = r((taxable * l.gstRate) / 200);
    return { amountPaise: amount, taxablePaise: taxable, cgstPaise: half, sgstPaise: half, igstPaise: 0, totalPaise: taxable + 2 * half, reimbursement: false };
  }
  const igst = r((taxable * l.gstRate) / 100);
  return { amountPaise: amount, taxablePaise: taxable, cgstPaise: 0, sgstPaise: 0, igstPaise: igst, totalPaise: taxable + igst, reimbursement: false };
}

/** Totals for a document; `roundToRupee` false keeps paise (used for credit/debit notes of an exact amount). */
export function computeInvoice(lines: LineInput[], supply: SupplyType, opts: { roundToRupee?: boolean } = {}): InvoiceTotals {
  const out = lines.map((l) => lineTax(l, supply));
  const sum = (f: (x: LineTax) => number) => out.reduce((s, x) => s + f(x), 0);
  const taxable = sum((x) => x.taxablePaise);
  const cgst = sum((x) => x.cgstPaise); const sgst = sum((x) => x.sgstPaise); const igst = sum((x) => x.igstPaise);
  const reimb = sum((x) => (x.reimbursement ? x.totalPaise : 0));
  const exact = taxable + cgst + sgst + igst + reimb;
  const total = opts.roundToRupee === false ? exact : r(exact / 100) * 100;
  return { supplyType: supply, lines: out, taxablePaise: taxable, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, reimbursementPaise: reimb, roundOffPaise: total - exact, totalPaise: total };
}

/** What is still owed on a receivable. */
export function balanceOf(x: { totalPaise: Paise; allocatedPaise: Paise; tdsPaise: Paise; creditedPaise: Paise }): Paise {
  return x.totalPaise - x.allocatedPaise - x.tdsPaise - x.creditedPaise;
}

export type OpenItem = { id: string; balancePaise: Paise };
export type Allocation = { invoiceId: string; amountPaise: Paise; tdsPaise: Paise };

/**
 * FIFO allocation of a receipt (cash + TDS) over open items already sorted oldest first. TDS is applied
 * before cash on each item (TDS certificates follow the invoices they relate to). Returns allocations
 * and what is left over as an advance.
 */
export function allocateFifo(amountPaise: Paise, tdsPaise: Paise, items: OpenItem[]): { allocations: Allocation[]; advance: { amountPaise: Paise; tdsPaise: Paise } } {
  let cash = amountPaise; let tds = tdsPaise;
  const allocations: Allocation[] = [];
  for (const it of items) {
    if (cash + tds <= 0) break;
    if (it.balancePaise <= 0) continue;
    const t = Math.min(tds, it.balancePaise);
    const c = Math.min(cash, it.balancePaise - t);
    if (t + c <= 0) continue;
    allocations.push({ invoiceId: it.id, amountPaise: c, tdsPaise: t });
    tds -= t; cash -= c;
  }
  return { allocations, advance: { amountPaise: cash, tdsPaise: tds } };
}

export const AGEING_BUCKETS = ['notDue', 'd0_30', 'd31_60', 'd61_90', 'd90plus'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** Days past the due date → bucket. Not yet due (≤ 0 days) is `notDue`; day 1–30 overdue is `d0_30`. */
export function ageingBucket(daysPastDue: number): AgeingBucket {
  if (daysPastDue <= 0) return 'notDue';
  if (daysPastDue <= 30) return 'd0_30';
  if (daysPastDue <= 60) return 'd31_60';
  if (daysPastDue <= 90) return 'd61_90';
  return 'd90plus';
}

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const DOC_SERIES = { invoice: '', credit_note: 'CN', debit_note: 'DN', receipt: 'R' } as const;
export type DocSeries = keyof typeof DOC_SERIES;

/**
 * Document number: `<PREFIX><SERIES>/<yyYY>/<seq>`, e.g. `SMA/2627/0007`, `SMACN/2627/0001`. A GST invoice number
 * may have at most 16 characters (// VERIFY AGAINST OFFICIAL DOCS — CGST Rule 46(b)), so prefixes are ≤ 4 chars.
 */
export function docNumber(prefix: string, series: DocSeries, fyStart: number, seq: number): string {
  const fy = `${String(fyStart % 100).padStart(2, '0')}${String((fyStart + 1) % 100).padStart(2, '0')}`;
  return `${prefix}${DOC_SERIES[series]}/${fy}/${String(seq).padStart(4, '0')}`;
}
export const INVOICE_PREFIX_REGEX = /^[A-Z0-9]{1,4}$/;

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below1000(n: number): string {
  const h = Math.floor(n / 100); const rest = n % 100;
  const t = rest < 20 ? ONES[rest]! : `${TENS[Math.floor(rest / 10)]}${rest % 10 ? ' ' + ONES[rest % 10] : ''}`;
  return [h ? `${ONES[h]} Hundred` : '', t].filter(Boolean).join(' ');
}
/** Indian-system amount in words for invoices: "Rupees One Lakh Eighteen Thousand Only". */
export function amountInWords(paise: Paise): string {
  const neg = paise < 0; const abs = Math.abs(paise);
  let n = Math.floor(abs / 100); const p = abs % 100;
  const parts: string[] = [];
  for (const [div, name] of [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']] as const) {
    const q = Math.floor(n / div);
    if (q) { parts.push(`${q >= 1000 ? amountInWords(q * 100).replace(/^Rupees | Only$/g, '') : below1000(q)} ${name}`); n %= div; }
  }
  if (n) parts.push(below1000(n));
  const rupees = parts.join(' ') || 'Zero';
  return `${neg ? 'Minus ' : ''}Rupees ${rupees}${p ? ` and ${below1000(p)} Paise` : ''} Only`;
}

/**
 * Seed SAC codes by service category. SAMPLE DATA — // VERIFY AGAINST OFFICIAL DOCS (CBIC services classification);
 * firms edit `service_type.sac_code` per service. 18% is a seed default (billing_settings.default_gst_rate), not a rule.
 */
export const SEED_SAC_BY_CATEGORY: Record<string, string> = {
  GST: '998231', 'Income tax': '998232', TDS: '998231', ROC: '998216', Payroll: '998223', Accounting: '998222', Advisory: '998311', Other: '998239',
};
export const SEED_GST_RATE = 18;

export type FollowupStep = { step: number; daysAfterDue: number; channels: Array<'email' | 'whatsapp'>; escalate?: boolean };
/** Seed reminder ladder (data, editable per firm): on the due date, +7 days, +15 days escalated to the partner. */
export const SEED_LADDER: FollowupStep[] = [
  { step: 0, daysAfterDue: 0, channels: ['email'] },
  { step: 1, daysAfterDue: 7, channels: ['email', 'whatsapp'] },
  { step: 2, daysAfterDue: 15, channels: ['email', 'whatsapp'], escalate: true },
];

/** The ladder step due on `asOf` (the latest one reached), or null. Missed earlier steps are not sent. */
export function dueStep(ladder: FollowupStep[], dueDate: string, asOf: string): FollowupStep | null {
  const d = daysBetween(dueDate, asOf);
  const reached = ladder.filter((s) => d >= s.daysAfterDue).sort((a, b) => b.daysAfterDue - a.daysAfterDue);
  return reached[0] ?? null;
}
