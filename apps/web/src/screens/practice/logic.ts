import {
  daysBetween, isValidUdin, NOTICE_AUTHORITIES, NOTICE_STATUSES, noticeTransitionError, signoffError,
  type FieldSuggestion, type NoticeStatus, type ProcedureSignState, type SignoffLevel, type SignRights,
} from '@worko/domain';
import { paiseToInput, parseRupees } from '../billing/logic';

/** Phase 8 pure UI logic (notices, extraction, sign-offs, DSC bands, UDIN entry, e-sign summaries). */

// ---------- Notices ----------
/** Statuses reachable from `from` (closing additionally needs an outcome, asked for in the UI). */
export const allowedTransitions = (from: NoticeStatus): NoticeStatus[] =>
  NOTICE_STATUSES.filter((to) => to !== from && noticeTransitionError(from, to, 'dropped') === null);

export const OPEN_RESPONSE_STATUSES: NoticeStatus[] = ['received', 'under_review', 'drafting'];
export const isNoticeOverdue = (n: { status: string; responseDue: string | null }, today: string) =>
  OPEN_RESPONSE_STATUSES.includes(n.status as NoticeStatus) && !!n.responseDue && n.responseDue < today;

export const levelsOf = (authority: string): readonly string[] =>
  (NOTICE_AUTHORITIES as Record<string, { levels: readonly string[] }>)[authority]?.levels ?? [];

// ---------- Extraction ----------
/** Fields the server lets an extraction fill (PAN/GSTIN are shown for matching only). */
export const EXTRACTABLE = ['authority', 'section', 'din', 'referenceNo', 'assessmentYear', 'financialYear', 'issueDate', 'responseDue', 'demandPaise'] as const;
export type ExtractableField = (typeof EXTRACTABLE)[number];
export type FieldDraft = { field: ExtractableField; suggested: string; confidence: number | null; source: string | null; value: string; accepted: boolean };

const shown = (field: string, v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '';
  if (field === 'demandPaise') return typeof v === 'number' ? paiseToInput(v) : String(v);
  return String(v);
};

/** One draft row per extractable field: the best suggestion side by side with the editable value (nothing accepted yet). */
export function draftsFrom(suggestions: FieldSuggestion[]): FieldDraft[] {
  return EXTRACTABLE.map((field) => {
    const best = suggestions.filter((s) => s.field === field).sort((a, b) => b.confidence - a.confidence)[0];
    const v = shown(field, best?.value);
    return { field, suggested: v, confidence: best ? best.confidence : null, source: best?.source ?? null, value: v, accepted: false };
  });
}
/** Suggestions the server shows for matching only (PAN, GSTIN …). */
export const matchOnly = (s: FieldSuggestion[]) => s.filter((x) => !(EXTRACTABLE as readonly string[]).includes(x.field));

/** Editing a value counts as accepting it; clearing it un-accepts. */
export function editDraft(d: FieldDraft[], field: ExtractableField, value: string): FieldDraft[] {
  return d.map((x) => (x.field === field ? { ...x, value, accepted: value.trim() !== '' } : x));
}
export const toggleDraft = (d: FieldDraft[], field: ExtractableField, accepted: boolean) => d.map((x) => (x.field === field ? { ...x, accepted } : x));
export const acceptAll = (d: FieldDraft[]) => d.map((x) => ({ ...x, accepted: x.value.trim() !== '' }));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const YR = /^\d{4}-\d{2}$/;
export function draftError(x: FieldDraft): string | null {
  if (!x.accepted) return null;
  const v = x.value.trim();
  if (!v) return 'required';
  if ((x.field === 'issueDate' || x.field === 'responseDue') && !DATE.test(v)) return 'date';
  if ((x.field === 'assessmentYear' || x.field === 'financialYear') && !YR.test(v)) return 'year';
  if (x.field === 'demandPaise' && parseRupees(v) === null) return 'amount';
  if (x.field === 'authority' && !(v in NOTICE_AUTHORITIES)) return 'authority';
  return null;
}

/** Body `fields` for confirm: only accepted rows, with the user's (possibly corrected) values; demand in paise. */
export function confirmFields(d: FieldDraft[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const x of d) {
    if (!x.accepted || draftError(x)) continue;
    const v = x.value.trim();
    out[x.field] = x.field === 'demandPaise' ? parseRupees(v)! : v;
  }
  return out;
}

// ---------- Audit sign-offs ----------
export type Grant = { module: string; action: string; scope: string };
export type MeLike = { id: string; grants: Grant[]; superAdmin?: boolean };
/** Client-side hint of the server's rights (D121); the server re-checks every sign-off. */
export function signRights(me: MeLike, engagement: { partnerId: string | null }): SignRights {
  const has = (a: string) => me.grants.some((g) => g.module === 'audit' && g.action === a && g.scope !== 'none');
  const firmApprove = me.grants.some((g) => g.module === 'audit' && g.action === 'approve' && g.scope === 'all');
  return { canPrepare: has('edit'), canReview: has('approve'), canPartner: !!me.superAdmin || firmApprove || (engagement.partnerId === me.id && has('approve')) };
}

export type ProcLike = ProcedureSignState & { notApplicable?: boolean };
export type ButtonState = { enabled: boolean; reason: string | null; signed: boolean };
/** Enabled state + reason code for one sign-off button (`p8.why.<code>`). Stale evidence blocks every level. */
export function signoffButton(p: ProcLike, level: SignoffLevel, userId: string, r: SignRights, staleEvidence = false): ButtonState {
  const signedBy = level === 'preparer' ? p.preparedBy : level === 'reviewer' ? p.reviewedBy : p.partnerBy;
  if (signedBy) return { enabled: false, reason: 'already_signed', signed: true };
  if (p.notApplicable) return { enabled: false, reason: 'not_applicable', signed: false };
  const why = signoffError(p, level, userId, r);
  if (why) return { enabled: false, reason: why, signed: false };
  if (staleEvidence) return { enabled: false, reason: 'evidence_changed', signed: false };
  return { enabled: true, reason: null, signed: false };
}

// ---------- DSC / licence expiry ----------
export type Band = 'expired' | '7' | '15' | '30' | '60' | 'ok';
/** Colour band for days to expiry (60/30/15/7/expired). */
export function expiryBand(validTo: string | null, today: string): Band {
  if (!validTo) return 'ok';
  const left = daysBetween(today, validTo);
  return left < 0 ? 'expired' : left <= 7 ? '7' : left <= 15 ? '15' : left <= 30 ? '30' : left <= 60 ? '60' : 'ok';
}
export const BAND_CLASS: Record<Band, string> = {
  expired: 'bg-overdue text-primary-fg', '7': 'border border-overdue text-overdue', '15': 'border border-due-soon text-due-soon', '30': 'bg-surface-alt text-due-soon',
  '60': 'bg-surface-alt text-primary', ok: 'bg-surface-alt text-done',
};

// ---------- UDIN entry ----------
export const normalizeUdin = (s: string) => s.replace(/\s+/g, '').toUpperCase();
/** Error code (`p8.udin.err.<code>`) for the entry form, or null. Generation happens only on the official ICAI portal. */
export function udinInputError(udin: string, membershipNo: string, generatedOn: string, today: string): string | null {
  const u = normalizeUdin(udin);
  if (!isValidUdin(u)) return 'format';
  if (!/^\d{6}$/.test(membershipNo)) return 'membership';
  if (u.slice(2, 8) !== membershipNo) return 'membership_mismatch';
  if (!DATE.test(generatedOn)) return 'date';
  if (generatedOn > today) return 'future_date';
  return null;
}

// ---------- E-sign ----------
export type EsignItemLike = { status: string; signers?: Array<{ status: string }> };
export type EsignSummary = { total: number; signed: number; failed: number; open: number; cancelled: number; signersSigned: number; signersTotal: number };
export function esignSummary(items: EsignItemLike[]): EsignSummary {
  const n = (s: string[]) => items.filter((i) => s.includes(i.status)).length;
  const signers = items.flatMap((i) => i.signers ?? []);
  return { total: items.length, signed: n(['signed']), failed: n(['failed']), open: n(['pending', 'sent']), cancelled: n(['cancelled']),
    signersSigned: signers.filter((s) => s.status === 'signed').length, signersTotal: signers.filter((s) => s.status !== 'cancelled').length };
}
/** Mock and skeleton (ASP) providers are not verified against official docs. */
export const unverifiedProvider = (p: string | null | undefined) => !p || p === 'mock' || p === 'asp';

/** `#/esign/sign/<token>` (or path) → token, for the logged-out signer page. */
export function esignPublicToken(hash: string, pathname = ''): string | null {
  const src = /^#\/?esign\/sign\//.test(hash) ? hash.replace(/^#\/?/, '') : pathname.replace(/^\/+/, '');
  const parts = src.split('?')[0]!.split('/').filter(Boolean);
  if (parts[0] !== 'esign' || parts[1] !== 'sign' || !parts[2]) return null;
  try { return decodeURIComponent(parts[2]); } catch { return parts[2]; }
}

/** IST `datetime-local` value → ISO with offset. */
export const istInputToIso = (v: string) => (v ? `${v.length === 16 ? `${v}:00` : v}+05:30` : '');
export const isoToIstInput = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 16);
export const humanize = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const parseThresholds = (s: string): number[] | null => {
  const xs = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (!xs.length || xs.some((x) => !/^\d{1,3}$/.test(x))) return null;
  return [...new Set(xs.map(Number))].sort((a, b) => b - a);
};
