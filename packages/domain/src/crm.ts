import { z } from 'zod';
import { computeInvoice, type SupplyType } from './billing.js';
import { renderTemplate } from './comm.js';
import type { Paise } from './money.js';

// ---------- Leads pipeline (M4) ----------

/** Pipeline stages are data; `won` and `lost` are terminal columns of the kanban. */
export const LEAD_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const LEAD_SOURCES = ['referral', 'website', 'walk_in', 'campaign', 'existing_client', 'booking', 'other'] as const;
export const LEAD_ACTIVITY_KINDS = ['note', 'call', 'email', 'meeting'] as const;

const OPEN: LeadStage[] = ['new', 'contacted', 'qualified', 'proposal'];

/**
 * Allowed kanban moves: any open stage → any open stage (forward or back), open → won/lost, lost → reopen (new/contacted/qualified).
 * Won is final (a converted lead keeps its client link). Lost needs a reason.
 */
export function leadTransitionError(from: LeadStage, to: LeadStage, lostReason?: string | null): string | null {
  if (from === to) return null;
  if (from === 'won') return 'lead_won_final';
  if (from === 'lost' && !['new', 'contacted', 'qualified'].includes(to)) return 'invalid_transition';
  if (to === 'lost' && !lostReason?.trim()) return 'lost_reason_required';
  if (!OPEN.includes(from) && from !== 'lost') return 'invalid_transition';
  return null;
}

/** Kanban ordering: a position strictly between two neighbours (fractional indexing on doubles; rebalanced by the server when gaps get tiny). */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1024;
  if (before === null) return after! - 1024;
  if (after === null) return before + 1024;
  if (after <= before) throw new Error('after must be greater than before');
  return before + (after - before) / 2;
}
export const needsRebalance = (before: number | null, after: number | null) => before !== null && after !== null && after - before < 1e-6;

// ---------- Proposals ----------

export const PROPOSAL_FREQUENCIES = ['one_time', 'monthly', 'quarterly', 'annual'] as const;
export type ProposalFrequency = (typeof PROPOSAL_FREQUENCIES)[number];
export const PROPOSAL_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired', 'withdrawn'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export type ProposalLine = {
  serviceTypeId: string | null; description: string; frequency: ProposalFrequency; qty: number; feePaise: Paise; gstRate: number; discountPaise?: Paise;
};
export type ProposalTotals = {
  supplyType: SupplyType;
  /** Per frequency: one billing cycle's taxable / tax / total (paise, unrounded). */
  byFrequency: Record<ProposalFrequency, { taxablePaise: Paise; taxPaise: Paise; totalPaise: Paise }>;
  /** First-year contract value: one-time + 12 × monthly + 4 × quarterly + annual. */
  firstYear: { taxablePaise: Paise; taxPaise: Paise; totalPaise: Paise };
};
const PER_YEAR: Record<ProposalFrequency, number> = { one_time: 1, monthly: 12, quarterly: 4, annual: 1 };

/** GST per line via the billing helpers (same split/rounding as invoices), grouped per billing frequency. */
export function proposalTotals(lines: ProposalLine[], supply: SupplyType): ProposalTotals {
  const byFrequency = Object.fromEntries(PROPOSAL_FREQUENCIES.map((f) => [f, { taxablePaise: 0, taxPaise: 0, totalPaise: 0 }])) as ProposalTotals['byFrequency'];
  for (const f of PROPOSAL_FREQUENCIES) {
    const ls = lines.filter((l) => l.frequency === f);
    if (!ls.length) continue;
    const t = computeInvoice(ls.map((l) => ({ qty: l.qty, ratePaise: l.feePaise, discountPaise: l.discountPaise ?? 0, gstRate: l.gstRate })), supply, { roundToRupee: false });
    byFrequency[f] = { taxablePaise: t.taxablePaise, taxPaise: t.cgstPaise + t.sgstPaise + t.igstPaise, totalPaise: t.totalPaise };
  }
  const firstYear = { taxablePaise: 0, taxPaise: 0, totalPaise: 0 };
  for (const f of PROPOSAL_FREQUENCIES) {
    firstYear.taxablePaise += byFrequency[f].taxablePaise * PER_YEAR[f];
    firstYear.taxPaise += byFrequency[f].taxPaise * PER_YEAR[f];
    firstYear.totalPaise += byFrequency[f].totalPaise * PER_YEAR[f];
  }
  return { supplyType: supply, byFrequency, firstYear };
}

export type VersionDiff = {
  added: ProposalLine[]; removed: ProposalLine[]; changed: Array<{ key: string; fields: string[]; from: ProposalLine; to: ProposalLine }>;
  terms: boolean; validUntil: boolean;
};
const lineKey = (l: ProposalLine, i: number) => (l.serviceTypeId ? `svc:${l.serviceTypeId}:${l.frequency}` : `line:${l.description.toLowerCase()}:${i}`);

/** Line-level diff between two proposal versions (services matched by service × frequency, free lines by description). */
export function diffProposalVersions(a: { lines: ProposalLine[]; terms: string | null; validUntil: string | null }, b: { lines: ProposalLine[]; terms: string | null; validUntil: string | null }): VersionDiff {
  const am = new Map(a.lines.map((l, i) => [lineKey(l, i), l]));
  const bm = new Map(b.lines.map((l, i) => [lineKey(l, i), l]));
  const out: VersionDiff = { added: [], removed: [], changed: [], terms: (a.terms ?? '') !== (b.terms ?? ''), validUntil: a.validUntil !== b.validUntil };
  for (const [k, l] of bm) {
    const prev = am.get(k);
    if (!prev) { out.added.push(l); continue; }
    const fields = (['description', 'qty', 'feePaise', 'gstRate', 'discountPaise'] as const).filter((f) => (prev[f] ?? 0) !== (l[f] ?? 0));
    if (fields.length) out.changed.push({ key: k, fields, from: prev, to: l });
  }
  for (const [k, l] of am) if (!bm.has(k)) out.removed.push(l);
  return out;
}

/** Can a public e-accept link act on `linkVersion`? Only the latest sent version of a still-open, unexpired proposal. */
export function proposalAcceptError(p: { status: ProposalStatus; sentVersion: number | null; currentVersion: number; validUntil: string | null }, linkVersion: number, todayIst: string): string | null {
  if (p.status === 'accepted' || p.status === 'declined') return 'already_decided';
  if (p.status === 'withdrawn') return 'withdrawn';
  if (p.sentVersion === null || linkVersion !== p.sentVersion || p.currentVersion !== p.sentVersion) return 'superseded';
  if (p.status === 'expired' || (p.validUntil && p.validUntil < todayIst)) return 'expired';
  if (p.status !== 'sent') return 'not_sent';
  return null;
}

/** Variables an engagement-letter template may use. */
export const ENGAGEMENT_LETTER_VARIABLES = ['client.name', 'contact.name', 'firm.name', 'date', 'services', 'fees', 'terms', 'proposal.number', 'valid_until'] as const;
export const DEFAULT_ENGAGEMENT_LETTER = [
  'Date: {{date}}', '', 'To: {{client.name}}', 'Attention: {{contact.name}}', '', 'Subject: Engagement letter ({{proposal.number}})', '',
  'Thank you for appointing {{firm.name}}. This letter confirms the scope of our engagement:', '', '{{services}}', '', 'Fees (exclusive of GST unless stated): {{fees}}', '',
  'Terms: {{terms}}', '', 'Please sign and return a copy of this letter to confirm your acceptance.', '', 'For {{firm.name}}',
].join('\n');

export const crmSettingsSchema = z.object({
  proposalValidityDays: z.number().int().min(1).max(365).default(30),
  engagementLetterTemplate: z.string().min(20).max(20_000).default(DEFAULT_ENGAGEMENT_LETTER),
  defaultTerms: z.string().max(5000).default('Fees are payable within 15 days of invoice. Out-of-pocket expenses are billed at actuals.'),
}).strict();
export type CrmSettings = z.infer<typeof crmSettingsSchema>;

/**
 * Engagement letter text: the firm's template is rendered first (short values escaped/trimmed by `renderTemplate`), then long
 * free text (services list, terms) is substituted raw at one-time sentinel markers — so placeholders inside user text are never
 * expanded and values are never re-scanned (D138).
 */
export function renderEngagementLetter(tpl: string, vars: Record<string, string>, raw: { services: string; terms: string }): string {
  // A marker that occurs in none of the inputs (not a secret; works in browsers and React Native too).
  let tag = ''; const all = tpl + Object.values(vars).join('') + raw.services + raw.terms;
  do tag = Math.random().toString(36).slice(2, 12); while (all.includes(tag));
  const mark = { services: `@@S${tag}@@`, terms: `@@T${tag}@@` };
  const text = renderTemplate(tpl, { ...vars, services: mark.services, terms: mark.terms }).text;
  return text.split(mark.services).join(raw.services).split(mark.terms).join(raw.terms);
}
