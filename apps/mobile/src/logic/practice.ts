import { daysBetween, isValidUdin, NOTICE_AUTHORITY_KEYS, NOTICE_STATUSES, noticeTransitionError, type NoticeOutcome, type NoticeStatus } from '@worko/domain';
import type { LocalRow } from '@worko/sync';
import { parsePaise, rupeesInputToPaise } from './billing';
import { istDay } from './comm';
import { todayIST } from './registers';
import { addDays } from './tasks';

/**
 * Phase 8 on the phone (D120): notices, hearings and DSCs sync read-only (client-scoped); every change goes through REST.
 * Dates are IST calendar days ('YYYY-MM-DD'); `today` is always injectable so nothing depends on the wall clock.
 */

const str = (v: unknown) => (v == null || v === '' ? null : String(v));
const day = (v: unknown) => (v == null || v === '' ? null : String(v).slice(0, 10));

// ---------------- Notices ----------------
export type NoticeItem = {
  id: string; clientId: string; authority: string; level: string | null; section: string | null; referenceNo: string | null; din: string | null; title: string;
  issueDate: string | null; receivedOn: string | null; responseDue: string | null; assessmentYear: string | null; financialYear: string | null; period: string | null;
  demandPaise: number; status: NoticeStatus; outcome: string | null; finalDemandPaise: number | null; assigneeId: string | null; reviewerId: string | null; taskId: string | null;
};

export function toNoticeItem(r: LocalRow): NoticeItem {
  const f = r.fields;
  const status = (NOTICE_STATUSES as readonly string[]).includes(String(f.status)) ? (f.status as NoticeStatus) : 'received';
  return {
    id: r.id, clientId: String(f.client_id ?? ''), authority: String(f.authority ?? 'other'), level: str(f.level), section: str(f.section), referenceNo: str(f.reference_no),
    din: str(f.din), title: String(f.title ?? ''), issueDate: day(f.issue_date), receivedOn: day(f.received_on), responseDue: day(f.response_due),
    assessmentYear: str(f.assessment_year), financialYear: str(f.financial_year), period: str(f.period), demandPaise: parsePaise(f.demand_paise), status,
    outcome: str(f.outcome), finalDemandPaise: f.final_demand_paise == null ? null : parsePaise(f.final_demand_paise),
    assigneeId: str(f.assignee_id), reviewerId: str(f.reviewer_id), taskId: str(f.task_id),
  };
}
export const toNoticeItems = (rows: LocalRow[]) => rows.filter((r) => !r.deleted).map(toNoticeItem);

export const isOpenNotice = (n: Pick<NoticeItem, 'status'>) => n.status !== 'closed';
export const isNoticeOverdue = (n: NoticeItem, today: string) => isOpenNotice(n) && !!n.responseDue && n.responseDue < today;
export const noticeDaysLeft = (n: NoticeItem, today: string) => (n.responseDue ? daysBetween(today, n.responseDue) : null);

export type HearingStatus = 'scheduled' | 'adjourned' | 'held' | 'cancelled';
export type HearingItem = {
  id: string; noticeId: string; clientId: string; startsAt: string; endsAt: string | null; venue: string | null; virtualLink: string | null;
  status: HearingStatus; prepDone: boolean; ownerId: string | null; adjournedFrom: string | null;
};
export function toHearingItem(r: LocalRow): HearingItem {
  const f = r.fields;
  const status = (['scheduled', 'adjourned', 'held', 'cancelled'] as const).find((s) => s === f.status) ?? 'scheduled';
  return {
    id: r.id, noticeId: String(f.notice_id ?? ''), clientId: String(f.client_id ?? ''), startsAt: String(f.starts_at ?? ''), endsAt: str(f.ends_at), venue: str(f.venue),
    virtualLink: str(f.virtual_link), status, prepDone: !!f.prep_done, ownerId: str(f.owner_id), adjournedFrom: str(f.adjourned_from),
  };
}
export const toHearingItems = (rows: LocalRow[]) => rows.filter((r) => !r.deleted).map(toHearingItem).filter((h) => !Number.isNaN(Date.parse(h.startsAt)));
export const hearingDay = (h: Pick<HearingItem, 'startsAt'>) => istDay(h.startsAt);

/** Scheduled hearings whose IST day is within [today, today + days − 1], earliest first. days = 1 ⇒ today only. */
export function hearingsInRange(hs: HearingItem[], today: string, days: number): HearingItem[] {
  const end = addDays(today, days - 1);
  return hs.filter((h) => h.status === 'scheduled' && hearingDay(h) >= today && hearingDay(h) <= end)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
}

export const SOON_DAYS = 7;
export type NoticeGroups = { overdue: NoticeItem[]; dueSoon: NoticeItem[]; hearingWeek: NoticeItem[]; other: NoticeItem[]; closed: NoticeItem[] };

/**
 * Overdue (response due before today) → due soon (today … today+6) → has a scheduled hearing this week → other open → closed.
 * Each notice lands in exactly one group; within a group the nearest date comes first.
 */
export function groupNotices(ns: NoticeItem[], hearings: HearingItem[], today: string, soonDays = SOON_DAYS): NoticeGroups {
  const soonEnd = addDays(today, soonDays - 1);
  const weekHearing = new Map<string, string>();
  for (const h of hearingsInRange(hearings, today, 7)) if (!weekHearing.has(h.noticeId)) weekHearing.set(h.noticeId, h.startsAt);
  const g: NoticeGroups = { overdue: [], dueSoon: [], hearingWeek: [], other: [], closed: [] };
  for (const n of ns) {
    if (!isOpenNotice(n)) g.closed.push(n);
    else if (n.responseDue && n.responseDue < today) g.overdue.push(n);
    else if (n.responseDue && n.responseDue <= soonEnd) g.dueSoon.push(n);
    else if (weekHearing.has(n.id)) g.hearingWeek.push(n);
    else g.other.push(n);
  }
  const byDue = (a: NoticeItem, b: NoticeItem) => (a.responseDue ?? '9999').localeCompare(b.responseDue ?? '9999') || a.title.localeCompare(b.title);
  g.overdue.sort(byDue); g.dueSoon.sort(byDue); g.other.sort(byDue);
  g.hearingWeek.sort((a, b) => weekHearing.get(a.id)!.localeCompare(weekHearing.get(b.id)!));
  g.closed.sort((a, b) => (b.receivedOn ?? '').localeCompare(a.receivedOn ?? ''));
  return g;
}

export type NoticeFilter = { status: 'open' | 'all' | NoticeStatus; authority: string | null; mine: boolean; q: string };
export function filterNotices(ns: NoticeItem[], f: NoticeFilter, userId: string, clientName: (id: string) => string | undefined): NoticeItem[] {
  const q = f.q.trim().toLowerCase();
  return ns.filter((n) => (f.status === 'all' || (f.status === 'open' ? isOpenNotice(n) : n.status === f.status))
    && (!f.authority || n.authority === f.authority)
    && (!f.mine || n.assigneeId === userId || n.reviewerId === userId)
    && (!q || [n.title, n.section, n.referenceNo, n.din, n.assessmentYear, n.financialYear, clientName(n.clientId)].some((x) => x?.toLowerCase().includes(q))));
}
export const AUTHORITIES = NOTICE_AUTHORITY_KEYS;

/** Statuses the workflow allows from `from` (same rule as the server, from @worko/domain). */
export const allowedTransitions = (from: NoticeStatus): NoticeStatus[] =>
  NOTICE_STATUSES.filter((to) => to !== from && noticeTransitionError(from, to, 'dropped') === null);

export type StatusBody = { status: NoticeStatus; outcome?: NoticeOutcome | null; outcomeNote?: string | null; finalDemandPaise?: number | null };
export type StatusCheck = { ok: true; body: StatusBody } | { ok: false; error: 'invalid_transition' | 'outcome_required' | 'final_demand' };
export function buildStatusBody(from: NoticeStatus, to: NoticeStatus, outcome: NoticeOutcome | null, note: string, finalDemandRupees: string): StatusCheck {
  const err = noticeTransitionError(from, to, outcome);
  if (err === 'invalid_transition' || from === to) return { ok: false, error: 'invalid_transition' };
  if (err === 'outcome_required') return { ok: false, error: 'outcome_required' };
  if (to !== 'closed') return { ok: true, body: { status: to } };
  const fd = finalDemandRupees.trim() ? rupeesInputToPaise(finalDemandRupees) : null;
  if (finalDemandRupees.trim() && fd === null) return { ok: false, error: 'final_demand' };
  return { ok: true, body: { status: to, outcome, outcomeNote: note.trim() || null, finalDemandPaise: fd } };
}

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;
const validDate = (d: string) => DATE_RX.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

export type HearingForm = { date: string; start: string; end: string; venue: string; link: string; reason?: string };
export type HearingBody = { startsAt: string; endsAt: string | null; venue: string | null; virtualLink: string | null; reason?: string | null };
export type HearingCheck = { ok: true; body: HearingBody } | { ok: false; error: 'date' | 'time' | 'order' | 'past' | 'link' };
/** IST date + HH:MM → offset date-times for POST /notices/{id}/hearings or /hearings/{id}/adjourn. */
export function buildHearingBody(f: HearingForm, today: string): HearingCheck {
  if (!validDate(f.date.trim())) return { ok: false, error: 'date' };
  if (f.date.trim() < today) return { ok: false, error: 'past' };
  if (!TIME_RX.test(f.start.trim()) || (f.end.trim() && !TIME_RX.test(f.end.trim()))) return { ok: false, error: 'time' };
  if (f.end.trim() && f.end.trim() <= f.start.trim()) return { ok: false, error: 'order' };
  const link = f.link.trim();
  if (link && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(link)) return { ok: false, error: 'link' };
  const at = (hm: string) => `${f.date.trim()}T${hm}:00+05:30`;
  const body: HearingBody = { startsAt: at(f.start.trim()), endsAt: f.end.trim() ? at(f.end.trim()) : null, venue: f.venue.trim() || null, virtualLink: link || null };
  if (f.reason !== undefined) body.reason = f.reason.trim() || null;
  return { ok: true, body };
}

// ---------------- Extraction review ----------------
export type Suggestion = { field: string; value: string | number; confidence: number; source: string };
/** Fields the server lets a confirmation set (notices.service EXTRACTABLE). */
export const EXTRACTABLE = ['authority', 'section', 'din', 'referenceNo', 'assessmentYear', 'financialYear', 'issueDate', 'responseDue', 'demandPaise'] as const;
export type ReviewRow = { field: string; value: string; accepted: boolean; confidence: number; source: string };

/** Editable rows: one per confirmable suggestion; demand shown in rupees; accepted by default only when confidence ≥ 0.7. */
export function reviewRows(sg: Suggestion[]): ReviewRow[] {
  return sg.filter((s) => (EXTRACTABLE as readonly string[]).includes(s.field)).map((s) => ({
    field: s.field, confidence: s.confidence, source: s.source, accepted: s.confidence >= 0.7,
    value: s.field === 'demandPaise' && typeof s.value === 'number' ? paiseToRupeesInput(s.value) : String(s.value),
  }));
}
export const paiseToRupeesInput = (p: number) => `${Math.trunc(p / 100)}${p % 100 ? `.${String(Math.abs(p % 100)).padStart(2, '0')}` : ''}`;

export type MergeResult = { ok: true; fields: Record<string, string | number> } | { ok: false; errors: string[] };
/** Only accepted rows are sent; values are validated per field (dates, year ranges, rupees → integer paise, authority key). */
export function mergeAccepted(rows: ReviewRow[], requireAuthority: boolean): MergeResult {
  const fields: Record<string, string | number> = {};
  const errors: string[] = [];
  for (const r of rows) {
    if (!r.accepted) continue;
    const v = r.value.trim();
    if (!v) { errors.push(r.field); continue; }
    if (r.field === 'demandPaise') { const p = rupeesInputToPaise(v); if (p === null) errors.push(r.field); else fields[r.field] = p; }
    else if (r.field === 'issueDate' || r.field === 'responseDue') { if (validDate(v)) fields[r.field] = v; else errors.push(r.field); }
    else if (r.field === 'assessmentYear' || r.field === 'financialYear') { if (/^\d{4}-\d{2}$/.test(v)) fields[r.field] = v; else errors.push(r.field); }
    else if (r.field === 'authority') { if ((NOTICE_AUTHORITY_KEYS as readonly string[]).includes(v)) fields[r.field] = v; else errors.push(r.field); }
    else fields[r.field] = v.slice(0, 200);
  }
  if (requireAuthority && !('authority' in fields) && !errors.includes('authority')) errors.push('authority');
  return errors.length ? { ok: false, errors } : { ok: true, fields };
}

// ---------------- DSC ----------------
export type DscItem = {
  id: string; clientId: string | null; holderKind: string; holderName: string; dscClass: string; dscType: string; issuer: string; serialNo: string | null;
  validFrom: string | null; validTo: string | null; tokenLabel: string | null; custody: 'in_office' | 'with_client' | 'with_staff'; custodyUserId: string | null;
};
export function toDscItem(r: LocalRow): DscItem {
  const f = r.fields;
  const custody = (['in_office', 'with_client', 'with_staff'] as const).find((c) => c === f.custody) ?? 'in_office';
  return {
    id: r.id, clientId: str(f.client_id), holderKind: String(f.holder_kind ?? ''), holderName: String(f.holder_name ?? ''), dscClass: String(f.dsc_class ?? ''),
    dscType: String(f.dsc_type ?? ''), issuer: String(f.issuer ?? ''), serialNo: str(f.serial_no), validFrom: day(f.valid_from), validTo: day(f.valid_to),
    tokenLabel: str(f.token_label), custody, custodyUserId: str(f.custody_user_id),
  };
}
export const toDscItems = (rows: LocalRow[]) => rows.filter((r) => !r.deleted).map(toDscItem);

export type ExpiryBand = 'expired' | 'critical' | 'warning' | 'ok' | 'unknown';
/** expired (< today) · critical (≤ 7 days) · warning (≤ 30 days) · ok. */
export function expiryBand(validTo: string | null, today: string): ExpiryBand {
  if (!validTo || !validDate(validTo)) return 'unknown';
  const left = daysBetween(today, validTo);
  return left < 0 ? 'expired' : left <= 7 ? 'critical' : left <= 30 ? 'warning' : 'ok';
}
const BAND_ORDER: Record<ExpiryBand, number> = { expired: 0, critical: 1, warning: 2, ok: 3, unknown: 4 };

/** Search by holder, client name, serial, token label or issuer; soonest expiry first. */
export function searchDsc(items: DscItem[], q: string, clientName: (id: string) => string | undefined, today: string): DscItem[] {
  const s = q.trim().toLowerCase();
  const serial = s.replace(/[\s-]/g, '');
  return items.filter((d) => !s || [d.holderName, d.tokenLabel, d.issuer, d.clientId ? clientName(d.clientId) : null].some((x) => x?.toLowerCase().includes(s))
    || (!!serial && !!d.serialNo && d.serialNo.toLowerCase().replace(/[\s-]/g, '').includes(serial)))
    .sort((a, b) => BAND_ORDER[expiryBand(a.validTo, today)] - BAND_ORDER[expiryBand(b.validTo, today)] || (a.validTo ?? '9999').localeCompare(b.validTo ?? '9999') || a.holderName.localeCompare(b.holderName));
}

// ---------------- UDIN entry (never generation — that happens on the official ICAI portal) ----------------
export const normaliseUdin = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
export type UdinForm = { udin: string; membershipNo: string; documentType: string; generatedOn: string };
export type UdinError = 'udin_empty' | 'udin_length' | 'udin_format' | 'membership' | 'document_type' | 'date' | 'future';
export function validateUdinForm(f: UdinForm, today: string = todayIST()): { ok: true; value: UdinForm } | { ok: false; errors: UdinError[] } {
  const errors: UdinError[] = [];
  const udin = normaliseUdin(f.udin);
  if (!udin) errors.push('udin_empty');
  else if (udin.length !== 18) errors.push('udin_length');
  else if (!isValidUdin(udin)) errors.push('udin_format');
  const m = f.membershipNo.trim();
  if (!/^\d{6}$/.test(m)) errors.push('membership');
  if (!f.documentType.trim()) errors.push('document_type');
  const d = f.generatedOn.trim();
  if (!validDate(d)) errors.push('date');
  else if (d > today) errors.push('future');
  return errors.length ? { ok: false, errors } : { ok: true, value: { udin, membershipNo: m, documentType: f.documentType.trim().slice(0, 100), generatedOn: d } };
}

// ---------------- Audit sign-off ----------------
export type ProcedureState = { preparedBy: string | null; reviewedBy: string | null; partnerBy: string | null; notApplicable: boolean };
/** Next level to sign, or null when fully signed / not applicable. The server decides who may sign; this only drives the button. */
export function nextSignLevel(p: ProcedureState): 'preparer' | 'reviewer' | 'partner' | null {
  if (p.notApplicable) return null;
  return !p.preparedBy ? 'preparer' : !p.reviewedBy ? 'reviewer' : !p.partnerBy ? 'partner' : null;
}
const REFUSALS = ['self_review', 'preparer_signoff_required', 'reviewer_signoff_required', 'already_signed', 'evidence_changed', 'forbidden'] as const;
export type RefusalCode = (typeof REFUSALS)[number] | 'other';
export const refusalCode = (code: string | undefined | null, status?: number): RefusalCode =>
  (REFUSALS as readonly string[]).includes(code ?? '') ? (code as RefusalCode) : status === 403 ? 'forbidden' : 'other';

// ---------------- E-sign ----------------
/** Retry re-sends failed items (server: 409 nothing_to_retry otherwise). */
export const canRetryEsign = (status: string, itemStatuses?: string[]) =>
  status !== 'cancelled' && status !== 'completed' && (itemStatuses ? itemStatuses.includes('failed') : status === 'partially_failed');
export const canCancelEsign = (status: string) => !['completed', 'cancelled'].includes(status);
