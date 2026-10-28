import { z } from 'zod';
import { effectiveScope, hiddenFieldsOf, type Action, type Actor, type Module } from './permissions.js';

/**
 * Phase 6 (M10 time/costing/capacity + M14 HR) pure rules: geofence, CIDR, IST dates, leave-day counting, accrual,
 * comp-off, timer maths, cost/P&L allocation, capacity. No I/O, no wall clock — callers pass "now".
 */

export const TIME_STATUSES = ['draft', 'submitted', 'approved', 'rejected'] as const;
export type TimeStatus = (typeof TIME_STATUSES)[number];
export const LEAVE_STATUSES = ['pending', 'approved', 'partially_approved', 'rejected', 'cancelled'] as const;
export const ATTENDANCE_STATUSES = ['ok', 'flagged', 'needs_approval', 'approved', 'rejected'] as const;
export const CLAIM_STATUSES = ['draft', 'submitted', 'approved', 'partially_approved', 'rejected', 'paid'] as const;
export const ADVANCE_STATUSES = ['requested', 'approved', 'rejected', 'paid', 'settled'] as const;
export const LEAVE_LEDGER_REASONS = ['opening', 'accrual', 'grant', 'comp_off', 'leave', 'cancel', 'lapse', 'adjustment'] as const;

// ---------- Firm HR settings (data, validated; defaults are firm-editable, not statutory) ----------

export const hrSettingsSchema = z.object({
  attendance: z.object({
    /** What makes a check-in "in office": none (always ok), geofence, ip, either, both. */
    mode: z.enum(['none', 'geofence', 'ip', 'either', 'both']).default('geofence'),
    /** Outside the fence/IP list: allowed but flagged, or allowed pending approval. */
    outside: z.enum(['flag', 'approval']).default('flag'),
    ipAllowList: z.array(z.string().max(64)).max(100).default([]),
    /** Device-claimed vs server time difference that is flagged as clock skew. */
    skewFlagMinutes: z.number().int().min(1).max(1440).default(10),
    /** Offline check-ins older than this many days (device time) are refused. */
    offlineMaxDays: z.number().int().min(0).max(31).default(3),
    /** Longest attendance day; longer days are capped and flagged `minutes_capped`. */
    maxMinutes: z.number().int().min(60).max(1440).default(960),
  }).default({}),
  workWeek: z.object({
    weekendDays: z.array(z.number().int().min(0).max(6)).max(6).default([0]),
    excludeWeekends: z.boolean().default(true),
    excludeHolidays: z.boolean().default(true),
  }).default({}),
  capacity: z.object({ defaultWeeklyMinutes: z.number().int().min(0).max(10_080).default(2_400) }).default({}),
  timer: z.object({ capMinutes: z.number().int().min(15).max(1_440).default(720) }).default({}),
  compOff: z.object({
    enabled: z.boolean().default(true), typeKey: z.string().max(40).default('comp_off'),
    halfDayMinutes: z.number().int().min(30).max(1_440).default(240), fullDayMinutes: z.number().int().min(60).max(1_440).default(420),
    expiryDays: z.number().int().min(1).max(730).default(90),
    /** The daily job re-evaluates this many past days, so late approvals/rejections/reversals are reflected. */
    lookbackDays: z.number().int().min(0).max(60).default(7),
  }).default({}),
});
export type HrSettings = z.infer<typeof hrSettingsSchema>;
export const defaultHrSettings = (): HrSettings => hrSettingsSchema.parse({});

/** Leave accrual rule (data on the leave type). */
export const accrualSchema = z.object({
  kind: z.enum(['none', 'monthly', 'annual']).default('none'),
  /** Days credited per month (monthly) or at the FY start (annual, credited in April). */
  days: z.number().min(0).max(60).default(0),
});
export type Accrual = z.infer<typeof accrualSchema>;

// ---------- Dates (IST, ISO yyyy-mm-dd) ----------

const DAY = 86_400_000;
/** IST calendar date of an instant. */
export const istDate = (at: Date): string => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
export const addDaysIso = (iso: string, k: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10);
/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();
/** Monday of the ISO week containing `iso`. */
export const mondayOf = (iso: string): string => addDaysIso(iso, -((weekdayOf(iso) + 6) % 7));
export function* eachDay(from: string, to: string): Generator<string> { for (let d = from; d <= to; d = addDaysIso(d, 1)) yield d; }

export type WorkCalendar = { weekendDays: number[]; holidays: ReadonlySet<string>; excludeWeekends?: boolean; excludeHolidays?: boolean };
export const isWeekend = (iso: string, cal: Pick<WorkCalendar, 'weekendDays'>) => cal.weekendDays.includes(weekdayOf(iso));
/** A day that is neither a weekend nor a holiday (always both checks, independent of leave-counting settings). */
export const isWorkingDay = (iso: string, cal: WorkCalendar) => !isWeekend(iso, cal) && !cal.holidays.has(iso);

/**
 * Leave days in [from, to] with optional half days at either end. Weekends/holidays are skipped when the firm says so
 * (WorkCalendar.excludeWeekends/excludeHolidays, default true). A one-day request with both halves set is invalid.
 */
export function leaveDays(r: { from: string; to: string; startHalf?: boolean; endHalf?: boolean }, cal: WorkCalendar): number {
  if (r.to < r.from) throw new Error('to before from');
  if (r.from === r.to && r.startHalf && r.endHalf) throw new Error('one day cannot be two halves');
  const skipW = cal.excludeWeekends ?? true; const skipH = cal.excludeHolidays ?? true;
  let n = 0;
  for (const d of eachDay(r.from, r.to)) {
    if ((skipW && isWeekend(d, cal)) || (skipH && cal.holidays.has(d))) continue;
    n += ((d === r.from && r.startHalf) || (d === r.to && r.endHalf)) ? 0.5 : 1;
  }
  return n;
}

// ---------- Geofence + IP ----------

export type LatLng = { lat: number; lng: number };
/** Great-circle distance in metres (haversine, mean Earth radius). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_008.8; const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad; const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export type Fence = LatLng & { id: string; radiusM: number };
/** Nearest office fence and whether the point is inside it (distance ≤ radius). */
export function nearestFence(p: LatLng, fences: Fence[]): { id: string; distanceM: number; inside: boolean } | null {
  let best: { id: string; distanceM: number; inside: boolean } | null = null;
  for (const f of fences) {
    const d = haversineMeters(p, f);
    if (!best || d < best.distanceM) best = { id: f.id, distanceM: Math.round(d), inside: d <= f.radiusM };
  }
  if (best) best.inside = fences.some((f) => haversineMeters(p, f) <= f.radiusM);
  return best;
}
/** Stored precision: 4 decimals ≈ 11 m — enough to audit a fence decision, not a precise trail (D88). */
export const roundCoord = (x: number, decimals = 4) => Math.round(x * 10 ** decimals) / 10 ** decimals;

/** '::ffff:1.2.3.4' → '1.2.3.4'; lower-cases IPv6. */
export const normaliseIp = (ip: string) => { const s = ip.trim().toLowerCase(); const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s); return m ? m[1]! : s; };
function ipToBig(ip: string): { v: 4 | 6; n: bigint } | null {
  const s = normaliseIp(ip);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) {
    const parts = s.split('.').map(Number);
    if (parts.some((x) => x > 255)) return null;
    return { v: 4, n: parts.reduce((acc, x) => (acc << 8n) + BigInt(x), 0n) };
  }
  if (!/^[0-9a-f:]+$/.test(s) || !s.includes(':')) return null;
  const [head, tail, ...rest] = s.split('::');
  if (rest.length) return null;
  const h = head ? head.split(':') : []; const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n) };
}
/** True if `ip` is inside `cidr` (IPv4 or IPv6; a bare address means /32 or /128). Malformed input → false. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsS] = cidr.trim().split('/');
  const a = ipToBig(ip); const b = ipToBig(net ?? '');
  if (!a || !b || a.v !== b.v) return false;
  const width = a.v === 4 ? 32 : 128;
  const bits = bitsS === undefined ? width : Number(bitsS);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  const shift = BigInt(width - bits);
  return (a.n >> shift) === (b.n >> shift);
}
export const isValidCidr = (cidr: string) => { const [net, bits] = cidr.split('/'); const x = ipToBig(net ?? ''); return !!x && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (x.v === 4 ? 32 : 128))); };
export const ipAllowed = (ip: string | null | undefined, list: string[]) => !!ip && list.some((c) => ipInCidr(ip, c));

/** Attendance decision from fence/IP results and the firm policy. */
export function attendanceDecision(policy: HrSettings['attendance'], r: { inFence: boolean | null; ipOk: boolean | null }): { ok: boolean; status: 'ok' | 'flagged' | 'needs_approval'; flags: string[] } {
  const flags: string[] = [];
  const fence = r.inFence === true; const ip = r.ipOk === true;
  let ok: boolean;
  switch (policy.mode) {
    case 'none': ok = true; break;
    case 'geofence': ok = fence; break;
    case 'ip': ok = ip; break;
    case 'either': ok = fence || ip; break;
    case 'both': ok = fence && ip; break;
  }
  if (!ok) {
    if (['geofence', 'either', 'both'].includes(policy.mode) && !fence) flags.push(r.inFence === null ? 'no_location' : 'out_of_fence');
    if (['ip', 'either', 'both'].includes(policy.mode) && !ip) flags.push(r.ipOk === null ? 'ip_unknown' : 'ip_not_allowed');
  }
  return { ok, status: ok ? 'ok' : policy.outside === 'approval' ? 'needs_approval' : 'flagged', flags };
}
export const skewMinutes = (deviceAt: Date | null | undefined, serverAt: Date) => (deviceAt ? Math.round(Math.abs(serverAt.getTime() - deviceAt.getTime()) / 60_000) : 0);

// ---------- Timer, cost, P&L ----------

/** Minutes between server timestamps (rounded to the nearest minute, at least 1), capped. */
export function timerMinutes(startedAt: Date, stoppedAt: Date, capMinutes: number): { minutes: number; capped: boolean } {
  const raw = Math.max(1, Math.round((stoppedAt.getTime() - startedAt.getTime()) / 60_000));
  return raw > capMinutes ? { minutes: capMinutes, capped: true } : { minutes: raw, capped: false };
}
/** Cost of `minutes` at an hourly rate (paise), rounded to the paisa per entry. Negative minutes (reversals) → negative cost. */
export const costPaise = (minutes: number, hourlyPaise: number) => Math.round((minutes * hourlyPaise) / 60);

/** Splits `amount` over weights (largest remainder, ties to the earliest), exact to the paisa. Zero weights → equal split. */
export function allocateByWeight(amount: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const w = weights.some((x) => x > 0) ? weights.map((x) => Math.max(0, x)) : weights.map(() => 1);
  const total = w.reduce((s, x) => s + x, 0);
  const sign = amount < 0 ? -1 : 1; const abs = Math.abs(amount);
  const raw = w.map((x) => (abs * x) / total);
  const out = raw.map(Math.floor);
  let left = abs - out.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const o of order) { if (left <= 0) break; out[o.i]! += 1; left -= 1; }
  return out.map((x) => x * sign);
}

export type PnlRow = { revenuePaise: number; costPaise: number | null; wipPaise: number; minutes: number };
export function pnlOf(r: PnlRow) {
  const margin = r.costPaise === null ? null : r.revenuePaise - r.costPaise;
  return { ...r, marginPaise: margin, marginPct: margin === null || r.revenuePaise === 0 ? null : Math.round((margin * 10_000) / r.revenuePaise) / 100, loss: margin !== null && margin < 0 };
}

// ---------- Capacity ----------

/**
 * Capacity minutes of a week: the weekly capacity spread over the week's working days (weekdays that are not weekends),
 * minus holidays and leave days on working days.
 */
export function weekCapacity(weekStart: string, weeklyMinutes: number, cal: WorkCalendar, leave: ReadonlyMap<string, number>): { capacityMinutes: number; workDays: number; holidays: number; leaveDays: number } {
  const days = [...eachDay(weekStart, addDaysIso(weekStart, 6))].filter((d) => !isWeekend(d, cal));
  if (!days.length) return { capacityMinutes: 0, workDays: 0, holidays: 0, leaveDays: 0 };
  const perDay = weeklyMinutes / days.length;
  let avail = 0; let hol = 0; let lv = 0;
  for (const d of days) {
    if (cal.holidays.has(d)) { hol += 1; continue; }
    const l = Math.min(1, leave.get(d) ?? 0);
    lv += l; avail += 1 - l;
  }
  return { capacityMinutes: Math.round(avail * perDay), workDays: days.length, holidays: hol, leaveDays: lv };
}
export const utilisationPct = (minutes: number, capacity: number) => (capacity > 0 ? Math.round((minutes * 1000) / capacity) / 10 : null);

// ---------- Leave ledger ----------

/** Credit for a leave type in a month 'YYYY-MM' (monthly: every month; annual: April, the FY start). */
export function accrualFor(a: Accrual, period: string): number {
  if (a.kind === 'monthly') return a.days;
  if (a.kind === 'annual') return period.slice(5) === '04' ? a.days : 0;
  return 0;
}
/** Days lapsing at the FY start: the balance above the carry-forward cap (null cap = carry everything). */
export const carryForwardLapse = (balance: number, cap: number | null) => (cap === null || balance <= cap ? 0 : Math.round((balance - cap) * 2) / 2);
/** Comp-off days earned by work minutes on a non-working day. */
export const compOffDays = (minutes: number, cfg: Pick<HrSettings['compOff'], 'halfDayMinutes' | 'fullDayMinutes'>) => (minutes >= cfg.fullDayMinutes ? 1 : minutes >= cfg.halfDayMinutes ? 0.5 : 0);

export type LedgerEntry = { delta: number; expiresOn?: string | null; on: string };
/**
 * Available balance: debits consume the earliest-expiring credits first (FIFO by expiry, then date); credits past their
 * expiry on `asOf` (expiresOn < asOf) no longer count. Credits without expiry never lapse.
 */
export function availableBalance(entries: LedgerEntry[], asOf: string): number {
  const credits = entries.filter((e) => e.delta > 0).map((e) => ({ ...e, left: e.delta }))
    .sort((a, b) => (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999') || a.on.localeCompare(b.on));
  let debt = -entries.filter((e) => e.delta < 0).reduce((s, e) => s + e.delta, 0);
  for (const c of credits) { const take = Math.min(c.left, debt); c.left -= take; debt -= take; }
  const live = credits.filter((c) => !c.expiresOn || c.expiresOn >= asOf).reduce((s, c) => s + c.left, 0);
  return Math.round((live - debt) * 2) / 2;
}

/**
 * Which credits a debit of `days` consumes (same FIFO as `availableBalance`: earliest expiry first, after existing debits;
 * credits expired on `asOf` are skipped). Returned parts keep the credit's expiry so a cancellation can restore it; any part
 * not covered by a credit is returned with `expiresOn: null`.
 */
export function consumeCredits(entries: LedgerEntry[], days: number, asOf: string): Array<{ days: number; expiresOn: string | null }> {
  const credits = entries.filter((e) => e.delta > 0).map((e) => ({ ...e, left: e.delta }))
    .sort((a, b) => (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999') || a.on.localeCompare(b.on));
  let debt = -entries.filter((e) => e.delta < 0).reduce((s, e) => s + e.delta, 0);
  for (const c of credits) { const take = Math.min(c.left, debt); c.left -= take; debt -= take; }
  const out: Array<{ days: number; expiresOn: string | null }> = [];
  let need = days;
  for (const c of credits) {
    if (need <= 0) break;
    if (c.left <= 0 || (c.expiresOn && c.expiresOn < asOf)) continue;
    const take = Math.min(c.left, need);
    out.push({ days: take, expiresOn: c.expiresOn ?? null }); need -= take;
  }
  if (need > 0) out.push({ days: need, expiresOn: null });
  return out;
}

// ---------- Person-scoped permissions (time, hr) ----------

export type PersonCtx = { userId: string; branchId: string | null; teamIds: string[]; managerId: string | null };

/**
 * May `a` do `module:action` on a person's own records (time entries, attendance, leave, claims)? The person themself
 * always may view/edit their own; their manager may; otherwise the actor's scope over that person:
 * all → anyone; branch → same branch; team → shares a team; own/groups → only themself.
 */
export function canPerson(a: Actor & { superAdmin?: boolean }, module: Module, action: Action, p: PersonCtx): boolean {
  if (a.superAdmin) return true;
  if (p.managerId === a.userId) return true;
  const g = effectiveScope(a, module, action);
  if (p.userId === a.userId) return !!g && g.scope !== 'none';
  if (!g || g.scope === 'none') return false;
  switch (g.scope) {
    case 'all': return true;
    case 'branch': return (p.branchId ?? null) === (a.branchId ?? null);
    case 'team': return p.teamIds.some((t) => a.teamIds.includes(t));
    default: return false;
  }
}
/** May the actor create/edit their OWN personal records in `module`? Any edit or create grant suffices (D85). */
export const canOwn = (a: Actor & { superAdmin?: boolean }, module: Module) => !!a.superAdmin
  || (effectiveScope(a, module, 'edit')?.scope ?? 'none') !== 'none' || (effectiveScope(a, module, 'create')?.scope ?? 'none') !== 'none';
/** Approval of someone else's record: manager, or `module:approve` over that person — never one's own (D86). */
export const canApprovePerson = (a: Actor & { superAdmin?: boolean }, module: Module, p: PersonCtx) =>
  p.userId !== a.userId && (p.managerId === a.userId || (!!a.superAdmin || (effectiveScope(a, module, 'approve')?.scope ?? 'none') !== 'none') && canPerson(a, module, 'approve', p));
/** Cost rates (and cost/margin figures) are sensitive: firm-wide settings:view or hr:approve, and not hidden by `cost.*` (D87). */
export const canSeeCost = (a: Actor & { superAdmin?: boolean }) => !!a.superAdmin || (!hiddenFieldsOf(a).includes('cost.*')
  && (effectiveScope(a, 'settings', 'view')?.scope === 'all' || effectiveScope(a, 'hr', 'approve')?.scope === 'all'));
