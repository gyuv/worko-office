import { daysBetween } from './billing.js';
import { addDaysIso } from './hr.js';

/**
 * Phase 8 pure rules: notices (M7), audit sign-offs (M8), DSC/licence expiry planning (M12) and the deterministic
 * notice-text parser used by the mock extractor. Same functions on server and devices.
 */

// ---------------- Notices ----------------
/** Authorities and their litigation ladders are data (firms may extend via settings later). */
export const NOTICE_AUTHORITIES = {
  income_tax: { label: 'Income tax', levels: ['assessing_officer', 'cit_appeals', 'itat', 'high_court', 'supreme_court'] },
  gst: { label: 'GST', levels: ['proper_officer', 'appellate_authority', 'gstat', 'high_court', 'supreme_court'] },
  tds: { label: 'TDS (TRACES/AO)', levels: ['assessing_officer', 'cit_appeals', 'itat', 'high_court', 'supreme_court'] },
  roc: { label: 'ROC / MCA', levels: ['registrar', 'regional_director', 'nclt', 'nclat', 'supreme_court'] },
  customs: { label: 'Customs', levels: ['adjudicating_authority', 'commissioner_appeals', 'cestat', 'high_court', 'supreme_court'] },
  labour: { label: 'PF / ESI / labour', levels: ['authority', 'appellate_authority', 'tribunal', 'high_court', 'supreme_court'] },
  other: { label: 'Other', levels: ['authority', 'appellate_authority', 'tribunal', 'high_court', 'supreme_court'] },
} as const;
export type NoticeAuthority = keyof typeof NOTICE_AUTHORITIES;
export const NOTICE_AUTHORITY_KEYS = Object.keys(NOTICE_AUTHORITIES) as [NoticeAuthority, ...NoticeAuthority[]];

export const NOTICE_STATUSES = ['received', 'under_review', 'drafting', 'submitted', 'hearing', 'closed'] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];
export const NOTICE_OUTCOMES = ['dropped', 'demand_confirmed', 'demand_reduced', 'appeal'] as const;
export type NoticeOutcome = (typeof NOTICE_OUTCOMES)[number];

/** Allowed workflow moves. A hearing may lead to another submission; closed is final (reopen = new notice/appeal). */
const NOTICE_FLOW: Record<NoticeStatus, NoticeStatus[]> = {
  received: ['under_review', 'drafting', 'closed'],
  under_review: ['drafting', 'submitted', 'closed'],
  drafting: ['under_review', 'submitted', 'closed'],
  submitted: ['hearing', 'drafting', 'closed'],
  hearing: ['submitted', 'drafting', 'closed'],
  closed: [],
};

export function noticeTransitionError(from: NoticeStatus, to: NoticeStatus, outcome?: NoticeOutcome | null): string | null {
  if (from === to) return null;
  if (!NOTICE_FLOW[from].includes(to)) return 'invalid_transition';
  if (to === 'closed' && !outcome) return 'outcome_required';
  return null;
}

export const isLevelOf = (authority: NoticeAuthority, level: string) => (NOTICE_AUTHORITIES[authority].levels as readonly string[]).includes(level);


/** Linked task due = response due − buffer, never before the issue date (or today when the notice arrives late). */
export function noticeTaskDue(responseDue: string, bufferDays: number, floor?: string | null): string {
  const d = addDaysIso(responseDue, -Math.max(0, bufferDays));
  return floor && d < floor ? (floor < responseDue ? floor : responseDue) : d;
}

export const AGE_BUCKETS = ['0-30', '31-60', '61-90', '91-180', '180+'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];
export function ageBucket(receivedOn: string, today: string): AgeBucket {
  const n = Math.max(0, daysBetween(receivedOn, today));
  return n <= 30 ? '0-30' : n <= 60 ? '31-60' : n <= 90 ? '61-90' : n <= 180 ? '91-180' : '180+';
}

// ---------------- Expiry planning (DSC, licences) ----------------
export const DEFAULT_EXPIRY_THRESHOLDS = [60, 30, 15, 7, 0];

/**
 * Thresholds (days before expiry) whose alert is due on `today`: only the tightest reached threshold fires, so a
 * record first seen 5 days before expiry alerts once (7), not for 60/30/15 too. Already-sent thresholds are skipped.
 * Returns [] once more than 30 days past expiry (stop nagging).
 */
export function dueThresholds(validTo: string, today: string, thresholds: number[], sent: number[]): number[] {
  const left = daysBetween(today, validTo);
  if (left < -30) return [];
  const reached = [...thresholds].sort((a, b) => a - b).filter((t) => left <= t);
  const tightest = reached[0];
  if (tightest === undefined || sent.some((s) => s <= tightest)) return [];
  return [tightest];
}

// ---------------- Audit sign-offs ----------------
export const SIGNOFF_LEVELS = ['preparer', 'reviewer', 'partner'] as const;
export type SignoffLevel = (typeof SIGNOFF_LEVELS)[number];
export type ProcedureSignState = { preparedBy: string | null; reviewedBy: string | null; partnerBy: string | null; notApplicable?: boolean };
export type SignRights = { canPrepare: boolean; canReview: boolean; canPartner: boolean };

/** Sign-off order preparer → reviewer → partner; nobody reviews (or partner-signs) their own preparation; no double signing. */
export function signoffError(s: ProcedureSignState, level: SignoffLevel, userId: string, r: SignRights): string | null {
  if (level === 'preparer') {
    if (!r.canPrepare) return 'forbidden';
    if (s.preparedBy) return 'already_signed';
    return null;
  }
  if (level === 'reviewer') {
    if (!r.canReview) return 'forbidden';
    if (!s.preparedBy) return 'preparer_signoff_required';
    if (s.reviewedBy) return 'already_signed';
    if (s.preparedBy === userId) return 'self_review';
    return null;
  }
  if (!r.canPartner) return 'forbidden';
  if (!s.reviewedBy) return 'reviewer_signoff_required';
  if (s.partnerBy) return 'already_signed';
  if (s.preparedBy === userId) return 'self_review';
  return null;
}

/** Levels invalidated when evidence changes after signing: every signed level (preparer must re-confirm the new evidence). */
export const invalidatedByEvidence = (s: ProcedureSignState): SignoffLevel[] =>
  SIGNOFF_LEVELS.filter((l) => (l === 'preparer' ? s.preparedBy : l === 'reviewer' ? s.reviewedBy : s.partnerBy));

// ---------------- Notice text parsing (mock extractor) ----------------
export type FieldSuggestion = { field: string; value: string | number; confidence: number; source: string };

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
/** dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd, dd Mon yyyy → yyyy-mm-dd (null if invalid). */
export function parseIndianDate(s: string): string | null {
  let y: string | undefined; let m: string | undefined; let d: string | undefined;
  let r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s.trim());
  if (r) [, d, m, y] = r;
  else if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim()))) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-,]+(\d{4})$/.exec(s.trim()))) { d = r[1]; m = MONTHS[r[2]!.toLowerCase()]; y = r[3]; }
  if (!y || !m || !d) return null;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso;
}

const DATE_RX = String.raw`(\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\s-][A-Za-z]{3,9}[\s-,]+\d{4})`;

/** Deterministic, regex-based field suggestions from notice text. Never authoritative: a user confirms each field. */
export function parseNoticeText(text: string): FieldSuggestion[] {
  const t = text.replace(/\r/g, '').slice(0, 200_000);
  const out: FieldSuggestion[] = [];
  const add = (field: string, value: string | number | null | undefined, confidence: number, source: string) => {
    if (value === null || value === undefined || value === '' || out.some((o) => o.field === field)) return;
    out.push({ field, value, confidence, source: source.trim().slice(0, 120) });
  };
  const has = (rx: RegExp) => rx.test(t);
  if (has(/\bGSTIN\b|\bCGST\b|\bSGST\b|Goods and Services Tax|DRC-0\d|ASMT-1\d/i)) add('authority', 'gst', 0.85, 'GST keywords');
  else if (has(/\bTRACES\b|\bTDS\b|\bTAN\b.*default/i)) add('authority', 'tds', 0.7, 'TDS keywords');
  else if (has(/Registrar of Companies|\bROC\b|\bMCA\b|Companies Act/i)) add('authority', 'roc', 0.75, 'ROC keywords');
  else if (has(/Income[- ]tax|\bITBA\b|Assessing Officer|\bPAN\b/i)) add('authority', 'income_tax', 0.85, 'Income-tax keywords');
  let r = /\b(?:u\/s|under section|section|sec\.?)\s*([0-9]{1,3}[A-Z]{0,3}(?:\s*\(\s*[0-9a-z]+\s*\))*)/i.exec(t);
  if (r) add('section', r[1]!.replace(/\s+/g, ''), 0.8, r[0]);
  r = /\b(?:DIN|Document Identification Number)\s*[:\-]?\s*([A-Z0-9/]{10,40})/i.exec(t);
  if (r) add('din', r[1]!, 0.9, r[0]);
  r = /\b(?:Reference|Ref\.?)\s*(?:No\.?|Number)?\s*[:\-]\s*([A-Za-z0-9/\-]{4,60})/i.exec(t);
  if (r) add('referenceNo', r[1]!, 0.7, r[0]);
  r = /\b(?:Assessment Year|A\.?Y\.?)\s*[:\-]?\s*(20\d{2})\s*[-–]\s*(\d{2,4})/i.exec(t);
  if (r) add('assessmentYear', `${r[1]}-${r[2]!.slice(-2)}`, 0.85, r[0]);
  r = /\b(?:Financial Year|F\.?Y\.?|Tax Period|Period)\s*[:\-]?\s*(20\d{2})\s*[-–]\s*(\d{2,4})/i.exec(t);
  if (r) add('financialYear', `${r[1]}-${r[2]!.slice(-2)}`, 0.75, r[0]);
  r = new RegExp(String.raw`\b(?:Date of (?:issue|notice)|Dated|Issue date|Date)\s*[:\-]?\s*${DATE_RX}`, 'i').exec(t);
  if (r) add('issueDate', parseIndianDate(r[1]!), 0.75, r[0]);
  r = new RegExp(String.raw`\b(?:on or before|due date|reply (?:by|within)|respond by|furnish .{0,40}? by|compliance date)\s*[:\-]?\s*${DATE_RX}`, 'i').exec(t);
  if (r) add('responseDue', parseIndianDate(r[1]!), 0.7, r[0]);
  r = /\b(?:demand|amount payable|tax payable|sum of)\s*(?:of)?\s*[:\-]?\s*(?:Rs\.?|INR|₹)\s*([0-9,]+(?:\.\d{1,2})?)/i.exec(t);
  if (r) {
    const rupees = Number(r[1]!.replace(/,/g, ''));
    if (Number.isFinite(rupees)) add('demandPaise', Math.round(rupees * 100), 0.7, r[0]);
  }
  r = /\bPAN\s*[:\-]?\s*([A-Z]{5}[0-9]{4}[A-Z])\b/.exec(t);
  if (r) add('pan', r[1]!, 0.9, r[0]);
  r = /\bGSTIN\s*[:\-]?\s*(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/.exec(t);
  if (r) add('gstin', r[1]!, 0.9, r[0]);
  return out;
}
