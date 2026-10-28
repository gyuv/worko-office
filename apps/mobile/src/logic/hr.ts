import { addDaysIso, availableBalance, defaultHrSettings, eachDay, isWeekend, leaveDays, mondayOf, type HrSettings, type WorkCalendar } from '@worko/domain';
import type { LocalRow } from '@worko/sync';
import { rupeesInputToPaise } from './billing';

/**
 * Phase 6 on the phone (D89): own time entries (drafts editable offline), own timer (read-only), own attendance
 * (insert = check-in, update = check-out), holidays + leave types (read-only), own leave requests + ledger (read-only).
 * Everything here is pure — callers pass "today" (IST) and the synced rows.
 */

const day = (v: unknown) => (v == null || v === '' ? null : String(v).slice(0, 10));
/** Synced numeric(…) arrives as a string ("1.5"); half-day precision. */
export function parseDays(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : 0;
  return Number.isFinite(n) ? Math.round(n * 2) / 2 : 0;
}
const int = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '')); return Number.isSafeInteger(n) ? n : 0; };

// ---------- time entries ----------

export type TimeStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type TimeItem = {
  id: string; userId: string; taskId: string | null; clientId: string | null; workDate: string; minutes: number; billable: boolean;
  notes: string; source: string; status: TimeStatus; capped: boolean; decisionNote: string | null; reversesId: string | null;
};
export function toTimeItem(r: LocalRow): TimeItem {
  const f = r.fields;
  return {
    id: r.id, userId: String(f.user_id ?? ''), taskId: f.task_id ? String(f.task_id) : null, clientId: f.client_id ? String(f.client_id) : null,
    workDate: day(f.work_date) ?? '', minutes: int(f.minutes), billable: f.billable !== false, notes: String(f.notes ?? ''), source: String(f.source ?? 'manual'),
    status: (String(f.status ?? 'draft') as TimeStatus), capped: !!f.capped, decisionNote: f.decision_note ? String(f.decision_note) : null,
    reversesId: f.reverses_id ? String(f.reverses_id) : null,
  };
}
/** Owner may edit draft/rejected (content) on the device; approved never; submitted only via withdraw. */
export const isEditable = (e: Pick<TimeItem, 'status' | 'source'>) => (e.status === 'draft' || e.status === 'rejected') && e.source !== 'reversal';

export type WeekDay = { date: string; minutes: number; entries: TimeItem[] };
export type Week = { weekStart: string; weekEnd: string; days: WeekDay[]; totalMinutes: number; billableMinutes: number; draftCount: number; submittable: boolean; byStatus: Record<TimeStatus, number> };

/** Seven days Mon–Sun of the week containing `anyDay`, own entries only (deleted rows excluded by the caller/store). */
export function groupWeek(entries: TimeItem[], anyDay: string, userId: string): Week {
  const weekStart = mondayOf(anyDay); const weekEnd = addDaysIso(weekStart, 6);
  const mine = entries.filter((e) => e.userId === userId && e.workDate >= weekStart && e.workDate <= weekEnd);
  const days = [...eachDay(weekStart, weekEnd)].map((date) => {
    const es = mine.filter((e) => e.workDate === date).sort((a, b) => a.id.localeCompare(b.id));
    return { date, minutes: es.reduce((s, e) => s + e.minutes, 0), entries: es };
  });
  const byStatus: Record<TimeStatus, number> = { draft: 0, submitted: 0, approved: 0, rejected: 0 };
  for (const e of mine) byStatus[e.status] += e.minutes;
  const draftCount = mine.filter((e) => e.status === 'draft' || e.status === 'rejected').length;
  return {
    weekStart, weekEnd, days, totalMinutes: mine.reduce((s, e) => s + e.minutes, 0),
    billableMinutes: mine.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0), draftCount, submittable: draftCount > 0, byStatus,
  };
}

/** 90 → "1h 30m"; 45 → "45m"; negative (reversals) keep the sign. */
export function fmtMinutes(m: number): string {
  const sign = m < 0 ? '-' : ''; const a = Math.abs(m); const h = Math.floor(a / 60); const r = a % 60;
  return sign + (h ? `${h}h${r ? ` ${r}m` : ''}` : `${r}m`);
}

/** "1:30", "1.5", "90m", "2h", "45" (minutes) → minutes; null when invalid. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}):([0-5]\d)$/.exec(s))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = /^(\d{1,2})(?:\.(\d{1,2}))?\s*h$/.exec(s)) || (m = /^(\d{1,2})\.(\d{1,2})$/.exec(s))) return Math.round((Number(m[1]) + Number(`0.${m[2] ?? '0'}`)) * 60);
  if ((m = /^(\d{1,4})\s*m?$/.exec(s))) return Number(m[1]);
  return null;
}

export type DraftForm = { workDate: string; duration: string; notes: string; billable: boolean; taskId: string | null; clientId: string | null };
export type DraftError = 'date' | 'future' | 'duration' | 'dayCap' | 'notes';

/**
 * Offline draft validation, mirroring the server's timeEntryError (no future dates, 1–1440 minutes, ≤ 24 h per day).
 * `others` = my other entries (excluding the one being edited) — used for the per-day cap.
 */
export function buildDraft(f: DraftForm, today: string, others: TimeItem[]):
  { ok: true; patch: { work_date: string; minutes: number; notes: string | null; billable: boolean; task_id: string | null; client_id: string | null; status: 'draft' } }
  | { ok: false; errors: DraftError[] } {
  const errors: DraftError[] = [];
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(f.workDate) && !Number.isNaN(Date.parse(`${f.workDate}T00:00:00Z`));
  if (!dateOk) errors.push('date'); else if (f.workDate > today) errors.push('future');
  const minutes = parseDuration(f.duration);
  if (minutes === null || minutes < 1 || minutes > 1440) errors.push('duration');
  else if (dateOk && others.filter((e) => e.workDate === f.workDate).reduce((s, e) => s + e.minutes, 0) + minutes > 1440) errors.push('dayCap');
  if (f.notes.length > 2000) errors.push('notes');
  if (errors.length) return { ok: false, errors };
  return { ok: true, patch: { work_date: f.workDate, minutes: minutes!, notes: f.notes.trim() || null, billable: f.billable, task_id: f.taskId, client_id: f.clientId, status: 'draft' } };
}

// ---------- timer ----------

export type TimerItem = { id: string; startedAt: string; notes: string; taskId: string | null; clientId: string | null; billable: boolean };
/** The running timer (stopped_at null) of the user, if any. */
export function runningTimer(rows: LocalRow[], userId: string): TimerItem | null {
  const r = rows.filter((x) => !x.deleted && x.fields.user_id === userId && !x.fields.stopped_at && x.fields.started_at)
    .sort((a, b) => String(b.fields.started_at).localeCompare(String(a.fields.started_at)))[0];
  return r ? { id: r.id, startedAt: String(r.fields.started_at), notes: String(r.fields.notes ?? ''), taskId: (r.fields.task_id as string) ?? null,
    clientId: (r.fields.client_id as string) ?? null, billable: r.fields.billable !== false } : null;
}
/** "01:02:03" elapsed since start (never negative when the device clock is behind). */
export function elapsed(startedAt: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - Date.parse(startedAt)) / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

// ---------- attendance ----------

export type AttendanceItem = {
  id: string; workDate: string | null; checkInAt: string | null; checkOutAt: string | null; deviceCheckInAt: string | null; deviceCheckOutAt: string | null;
  status: string | null; flags: string[]; inFence: boolean | null; distanceM: number | null; minutes: number | null; method: string | null;
};
export function toAttendance(r: LocalRow): AttendanceItem {
  const f = r.fields;
  const flags = Array.isArray(f.flags) ? f.flags.map(String) : typeof f.flags === 'string' && f.flags.startsWith('{') ? f.flags.slice(1, -1).split(',').filter(Boolean) : [];
  return {
    id: r.id, workDate: day(f.work_date), checkInAt: (f.check_in_at as string) ?? null, checkOutAt: (f.check_out_at as string) ?? null,
    deviceCheckInAt: (f.device_check_in_at as string) ?? null, deviceCheckOutAt: (f.device_check_out_at as string) ?? null,
    status: f.status ? String(f.status) : null, flags, inFence: typeof f.in_fence === 'boolean' ? f.in_fence : null,
    distanceM: f.distance_m == null ? null : int(f.distance_m), minutes: f.minutes == null ? null : int(f.minutes), method: f.method ? String(f.method) : null,
  };
}
/** Today's row: by server work_date, else (not yet synced) by the device check-in instant in IST. */
export function todaysAttendance(rows: LocalRow[], today: string, istOf: (iso: string) => string): AttendanceItem | null {
  const items = rows.filter((r) => !r.deleted).map(toAttendance);
  return items.find((a) => a.workDate === today) ?? items.find((a) => !a.workDate && a.deviceCheckInAt && istOf(a.deviceCheckInAt) === today) ?? null;
}

export type AttendanceView = {
  phase: 'none' | 'in' | 'out'; synced: boolean; pendingOut: boolean;
  tone: 'ok' | 'warn' | 'bad' | 'pending'; statusKey: 'none' | 'pending' | 'ok' | 'flagged' | 'needs_approval' | 'approved' | 'rejected'; flags: string[];
};
/** What the attendance card shows. Server stamps come back on sync; until then the device's claim is shown as pending. */
export function attendanceView(a: AttendanceItem | null): AttendanceView {
  if (!a) return { phase: 'none', synced: true, pendingOut: false, tone: 'pending', statusKey: 'none', flags: [] };
  const synced = !!a.checkInAt;
  const pendingOut = !!a.deviceCheckOutAt && !a.checkOutAt;
  const phase = a.checkOutAt || a.deviceCheckOutAt ? 'out' : 'in';
  if (!synced) return { phase, synced, pendingOut, tone: 'pending', statusKey: 'pending', flags: [] };
  const st = (['ok', 'flagged', 'needs_approval', 'approved', 'rejected'] as const).find((x) => x === a.status) ?? 'ok';
  const tone = st === 'ok' || st === 'approved' ? 'ok' : st === 'rejected' ? 'bad' : 'warn';
  return { phase, synced, pendingOut, tone, statusKey: st, flags: a.flags };
}

// ---------- holidays + leave ----------

export type Holiday = { date: string; name: string; optional: boolean };
export const toHolidays = (rows: LocalRow[]): Holiday[] => rows.filter((r) => !r.deleted && r.fields.on_date)
  .map((r) => ({ date: day(r.fields.on_date)!, name: String(r.fields.name ?? ''), optional: !!r.fields.optional })).sort((a, b) => a.date.localeCompare(b.date));

/** Work calendar from synced holidays (optional holidays never count) and the firm's work week (cached /hr/settings, else defaults). */
export function calendarOf(holidays: Holiday[], settings?: Partial<HrSettings> | null): WorkCalendar {
  const ww = { ...defaultHrSettings().workWeek, ...(settings?.workWeek ?? {}) };
  return { weekendDays: ww.weekendDays, excludeWeekends: ww.excludeWeekends, excludeHolidays: ww.excludeHolidays, holidays: new Set(holidays.filter((h) => !h.optional).map((h) => h.date)) };
}

export type LeaveForm = { leaveTypeId: string; from: string; to: string; startHalf: boolean; endHalf: boolean; reason: string };
export type LeavePreviewError = 'type' | 'date' | 'order' | 'halves' | 'halfNotAllowed' | 'noDays' | 'maxDays' | 'balance';
export type LeavePreview = { days: number; skipped: Array<{ date: string; why: 'weekend' | 'holiday'; name?: string }>; errors: LeavePreviewError[] };

/** Indicative day count (the server recounts): working days only, half days at the ends; checks type limits and available balance. */
export function leavePreview(f: LeaveForm, cal: WorkCalendar, holidays: Holiday[], type: LeaveTypeItem | undefined, available: number | null): LeavePreview {
  const errors: LeavePreviewError[] = [];
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!type) errors.push('type');
  if (!iso.test(f.from) || !iso.test(f.to) || Number.isNaN(Date.parse(f.from)) || Number.isNaN(Date.parse(f.to))) return { days: 0, skipped: [], errors: [...errors, 'date'] };
  if (f.to < f.from) return { days: 0, skipped: [], errors: [...errors, 'order'] };
  if (f.from === f.to && f.startHalf && f.endHalf) return { days: 0, skipped: [], errors: [...errors, 'halves'] };
  if ((f.startHalf || f.endHalf) && type && !type.allowHalfDay) errors.push('halfNotAllowed');
  const names = new Map(holidays.map((h) => [h.date, h.name]));
  const skipped: LeavePreview['skipped'] = [];
  for (const d of eachDay(f.from, f.to)) {
    if ((cal.excludeWeekends ?? true) && isWeekend(d, cal)) skipped.push({ date: d, why: 'weekend' });
    else if ((cal.excludeHolidays ?? true) && cal.holidays.has(d)) skipped.push({ date: d, why: 'holiday', name: names.get(d) });
  }
  const days = leaveDays(f, cal);
  if (days <= 0) errors.push('noDays');
  if (type?.maxDaysPerRequest != null && days > type.maxDaysPerRequest) errors.push('maxDays');
  if (type?.tracked && available !== null && days > available) errors.push('balance');
  return { days, skipped, errors };
}

export type LeaveTypeItem = { id: string; key: string; name: string; tracked: boolean; allowHalfDay: boolean; maxDaysPerRequest: number | null; active: boolean; sort: number; roles: string[] };
export const toLeaveTypes = (rows: LocalRow[]): LeaveTypeItem[] => rows.filter((r) => !r.deleted).map((r) => ({
  id: r.id, key: String(r.fields.key ?? ''), name: String(r.fields.name ?? ''), tracked: r.fields.tracked !== false, allowHalfDay: r.fields.allow_half_day !== false,
  maxDaysPerRequest: r.fields.max_days_per_request == null ? null : parseDays(r.fields.max_days_per_request), active: r.fields.active !== false, sort: int(r.fields.sort),
  roles: Array.isArray(r.fields.applies_to_roles) ? r.fields.applies_to_roles.map(String) : [],
})).filter((x) => x.active).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

export type LeaveRequestItem = {
  id: string; leaveTypeId: string; from: string; to: string; startHalf: boolean; endHalf: boolean; days: number; status: string; reason: string;
  approvedFrom: string | null; approvedTo: string | null; approvedDays: number | null; decisionNote: string | null;
};
export const toLeaveRequests = (rows: LocalRow[]): LeaveRequestItem[] => rows.filter((r) => !r.deleted).map((r) => {
  const f = r.fields;
  return { id: r.id, leaveTypeId: String(f.leave_type_id ?? ''), from: day(f.from_date) ?? '', to: day(f.to_date) ?? '', startHalf: !!f.start_half, endHalf: !!f.end_half,
    days: parseDays(f.days), status: String(f.status ?? 'pending'), reason: String(f.reason ?? ''), approvedFrom: day(f.approved_from), approvedTo: day(f.approved_to),
    approvedDays: f.approved_days == null ? null : parseDays(f.approved_days), decisionNote: f.decision_note ? String(f.decision_note) : null };
}).sort((a, b) => b.from.localeCompare(a.from));

/** Owners cancel pending, or approved leave that has not started yet (server rechecks). */
export const canCancelLeave = (r: LeaveRequestItem, today: string) => r.status === 'pending' || ((r.status === 'approved' || r.status === 'partially_approved') && (r.approvedFrom ?? r.from) > today);

export type Balance = { leaveTypeId: string; balance: number; pending: number; available: number; expiring: Array<{ days: number; expiresOn: string }> };
/** Balance per type = ledger (FIFO expiry, D92) − pending requests; mirrors GET /hr/leave/balances offline. */
export function balancesFrom(ledger: LocalRow[], requests: LeaveRequestItem[], types: LeaveTypeItem[], today: string): Balance[] {
  return types.filter((t) => t.tracked).map((t) => {
    const entries = ledger.filter((r) => !r.deleted && r.fields.leave_type_id === t.id)
      .map((r) => ({ delta: parseDays(r.fields.delta), expiresOn: day(r.fields.expires_on), on: day(r.fields.on_date) ?? '' }));
    const balance = availableBalance(entries, today);
    const pending = requests.filter((q) => q.leaveTypeId === t.id && q.status === 'pending').reduce((s, q) => s + q.days, 0);
    return { leaveTypeId: t.id, balance, pending, available: Math.round((balance - pending) * 2) / 2,
      expiring: entries.filter((e) => e.delta > 0 && e.expiresOn && e.expiresOn >= today).map((e) => ({ days: e.delta, expiresOn: e.expiresOn! })) };
  });
}

// ---------- expenses (REST-only) ----------

export type ExpenseLineForm = { categoryKey: string; spentOn: string; description: string; amount: string; receiptDocId: string | null };
export type ExpenseError = 'title' | 'noLines' | 'category' | 'date' | 'future' | 'description' | 'amount';
export function buildClaim(title: string, lines: ExpenseLineForm[], today: string):
  { ok: true; body: { title: string; lines: Array<{ categoryKey: string; spentOn: string; description: string; amountPaise: number; receiptDocId: string | null }> }; totalPaise: number }
  | { ok: false; errors: Array<{ line: number | null; error: ExpenseError }> } {
  const errors: Array<{ line: number | null; error: ExpenseError }> = [];
  if (!title.trim()) errors.push({ line: null, error: 'title' });
  if (!lines.length) errors.push({ line: null, error: 'noLines' });
  const out = lines.map((l, i) => {
    const amountPaise = rupeesInputToPaise(l.amount);
    if (!/^[a-z0-9_]{2,40}$/.test(l.categoryKey)) errors.push({ line: i, error: 'category' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.spentOn)) errors.push({ line: i, error: 'date' }); else if (l.spentOn > today) errors.push({ line: i, error: 'future' });
    if (!l.description.trim()) errors.push({ line: i, error: 'description' });
    if (amountPaise === null || amountPaise <= 0) errors.push({ line: i, error: 'amount' });
    return { categoryKey: l.categoryKey, spentOn: l.spentOn, description: l.description.trim(), amountPaise: amountPaise ?? 0, receiptDocId: l.receiptDocId };
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, body: { title: title.trim(), lines: out }, totalPaise: out.reduce((s, l) => s + l.amountPaise, 0) };
}

/** Category limit hint (server decides; warn → flagged line, block → 400). */
export function limitHint(amountPaise: number | null, cat: { limitPaise?: number | null; limitMode?: string } | undefined): 'warn' | 'block' | null {
  if (!cat || cat.limitPaise == null || amountPaise == null || amountPaise <= cat.limitPaise) return null;
  return cat.limitMode === 'block' ? 'block' : 'warn';
}
