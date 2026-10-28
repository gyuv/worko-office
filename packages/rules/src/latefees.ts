import { z } from 'zod';
import { parse } from './dates.js';

/**
 * Indicative late-fee / interest rate tables. DATA, not code: rates live in packs/*.json and carry their own
 * `verified` flag. The arithmetic below assumes common patterns (per-day fee with a cap, flat fee, simple
 * interest per month-or-part or per day) — VERIFY AGAINST OFFICIAL DOCS before relying on any figure.
 */
export const lateFeeComponentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('per_day'), label: z.string(), perDayPaise: z.number().int().min(0), maxPaise: z.number().int().min(0).optional(),
    nilPerDayPaise: z.number().int().min(0).optional(), nilMaxPaise: z.number().int().min(0).optional(), capAtTax: z.boolean().default(false) }),
  z.object({ kind: z.literal('flat'), label: z.string(), amountPaise: z.number().int().min(0) }),
  z.object({ kind: z.literal('interest'), label: z.string(), basis: z.enum(['per_month_or_part', 'per_day']),
    ratePctPerMonth: z.number().min(0).optional(), ratePctPerAnnum: z.number().min(0).optional() }),
]);
export type LateFeeComponent = z.infer<typeof lateFeeComponentSchema>;

export const lateFeeTableSchema = z.object({
  id: z.string(), version: z.string().regex(/^\d+\.\d+\.\d+$/), notes: z.string().optional(),
  entries: z.array(z.object({
    ruleIds: z.array(z.string()).min(1), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    components: z.array(lateFeeComponentSchema).min(1), verified: z.boolean().default(false), source: z.string().optional(),
  })),
});
export type LateFeeTable = z.infer<typeof lateFeeTableSchema>;

export type LateFeeInput = { ruleId: string; dueDate: string; filedOn: string; taxAmountPaise?: number; nilReturn?: boolean };
export type LateFeeResult = {
  ruleId: string; daysLate: number; monthsLate: number; feePaise: number; interestPaise: number; totalPaise: number;
  lines: Array<{ label: string; amountPaise: number }>; verified: boolean; indicative: true; supported: boolean;
};

const dayNo = (s: string) => { const { y, m, d } = parse(s); return Date.UTC(y, m - 1, d) / 86_400_000; };
/** Months or part thereof between due and filing (due 20th, filed 21st = 1; filed 21st next month = 2). */
function monthsOrPart(due: string, filed: string): number {
  const a = parse(due); const b = parse(filed);
  let m = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d > a.d) m += 1;
  return Math.max(0, m);
}

export function computeLateFee(table: LateFeeTable, i: LateFeeInput): LateFeeResult {
  const daysLate = Math.max(0, dayNo(i.filedOn) - dayNo(i.dueDate));
  const monthsLate = daysLate ? monthsOrPart(i.dueDate, i.filedOn) : 0;
  const entry = table.entries.filter((e) => e.ruleIds.includes(i.ruleId) && e.effectiveFrom <= i.dueDate)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  const out: LateFeeResult = { ruleId: i.ruleId, daysLate, monthsLate, feePaise: 0, interestPaise: 0, totalPaise: 0, lines: [], verified: !!entry?.verified, indicative: true, supported: !!entry };
  if (!entry || !daysLate) return out;
  const tax = Math.max(0, i.taxAmountPaise ?? 0);
  for (const c of entry.components) {
    let amt = 0;
    if (c.kind === 'per_day') {
      const rate = i.nilReturn && c.nilPerDayPaise !== undefined ? c.nilPerDayPaise : c.perDayPaise;
      const max = i.nilReturn && c.nilMaxPaise !== undefined ? c.nilMaxPaise : c.maxPaise;
      amt = rate * daysLate;
      if (max !== undefined) amt = Math.min(amt, max);
      if (c.capAtTax && i.taxAmountPaise !== undefined) amt = Math.min(amt, tax);
      out.feePaise += amt;
    } else if (c.kind === 'flat') {
      amt = c.amountPaise; out.feePaise += amt;
    } else {
      amt = c.basis === 'per_month_or_part'
        ? Math.round((tax * (c.ratePctPerMonth ?? 0) * monthsLate) / 100)
        : Math.round((tax * (c.ratePctPerAnnum ?? 0) * daysLate) / 36_500);
      out.interestPaise += amt;
    }
    out.lines.push({ label: c.label, amountPaise: amt });
  }
  out.totalPaise = out.feePaise + out.interestPaise;
  return out;
}
