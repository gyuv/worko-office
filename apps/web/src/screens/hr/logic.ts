import { addDaysIso, eachDay, leaveDays, mondayOf, type WorkCalendar } from '@worko/domain';

/** Pure helpers for the Phase 6 screens (time, capacity, leave, expenses, P&L). Dates are IST ISO yyyy-mm-dd. */

export const weekDays = (weekStart: string) => Array.from({ length: 7 }, (_, k) => addDaysIso(weekStart, k));
export const weekOf = (iso: string) => mondayOf(iso);

/** 90 → "1:30"; negative minutes keep their sign. */
export function fmtMinutes(m: number): string {
  const s = m < 0 ? '-' : '';
  const a = Math.abs(m);
  return `${s}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}
/** "1:30", "1.5", "90m", "2h" → minutes; '' → 0; null when invalid. */
export function parseMinutes(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return 0;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}):([0-5]\d)$/.exec(s))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = /^(\d{1,4})m$/.exec(s))) return Number(m[1]);
  if ((m = /^(\d{1,2}(?:\.\d{1,2})?)h?$/.exec(s))) return Math.round(Number(m[1]) * 60);
  return null;
}

export type GridEntry = { id: string; taskId?: string | null; taskTitle?: string | null; clientId?: string | null; clientName?: string | null; workDate: string; minutes: number; status: string };
export type GridRow = { key: string; taskId: string | null; clientId: string | null; label: string; sub: string | null; cells: Record<string, GridEntry[]>; total: number };
export const rowKey = (taskId?: string | null, clientId?: string | null) => `${taskId ?? ''}|${clientId ?? ''}`;

/**
 * Weekly timesheet: one row per task (or client-only / internal) with per-day entries, row totals, day totals and the week
 * total. Extra rows (added but still empty) are kept so the user can type into them.
 */
export function buildGrid(entries: GridEntry[], weekStart: string, extra: Array<Pick<GridRow, 'taskId' | 'clientId' | 'label' | 'sub'>> = []) {
  const days = weekDays(weekStart);
  const rows = new Map<string, GridRow>();
  const ensure = (taskId: string | null, clientId: string | null, label: string, sub: string | null) => {
    const k = rowKey(taskId, clientId);
    if (!rows.has(k)) rows.set(k, { key: k, taskId, clientId, label, sub, cells: Object.fromEntries(days.map((d) => [d, []])), total: 0 });
    return rows.get(k)!;
  };
  for (const e of entries) {
    if (!days.includes(e.workDate)) continue;
    const r = ensure(e.taskId ?? null, e.clientId ?? null, e.taskTitle ?? e.clientName ?? '', e.taskTitle ? e.clientName ?? null : null);
    r.cells[e.workDate]!.push(e);
    r.total += e.minutes;
  }
  for (const x of extra) ensure(x.taskId, x.clientId, x.label, x.sub);
  const list = [...rows.values()];
  const dayTotals = Object.fromEntries(days.map((d) => [d, list.reduce((s, r) => s + r.cells[d]!.reduce((a, e) => a + e.minutes, 0), 0)]));
  const total = list.reduce((s, r) => s + r.total, 0);
  const draftCount = entries.filter((e) => days.includes(e.workDate) && (e.status === 'draft' || e.status === 'rejected')).length;
  return { days, rows: list, dayTotals, total, draftCount };
}
/** A cell is directly editable when it holds no entry, or exactly one draft/rejected entry. */
export const cellEditable = (cell: GridEntry[]) => cell.length === 0 || (cell.length === 1 && ['draft', 'rejected'].includes(cell[0]!.status));

// ---------- Leave ----------

export type Holiday = { date: string; name: string; branchId?: string | null; optional?: boolean };
export type WorkWeek = { weekendDays: number[]; excludeWeekends?: boolean; excludeHolidays?: boolean };
export function calendarOf(ww: WorkWeek, holidays: Holiday[], branchId: string | null = null): WorkCalendar {
  return { weekendDays: ww.weekendDays, excludeWeekends: ww.excludeWeekends, excludeHolidays: ww.excludeHolidays,
    holidays: new Set(holidays.filter((h) => !h.optional && (!h.branchId || h.branchId === branchId)).map((h) => h.date)) };
}
/** Leave days the server will count (working days only, half days at the ends) plus the skipped days for display. */
export function leavePreview(r: { from: string; to: string; startHalf?: boolean; endHalf?: boolean }, ww: WorkWeek, holidays: Holiday[], branchId: string | null = null) {
  if (!r.from || !r.to || r.from > r.to) return null;
  const cal = calendarOf(ww, holidays, branchId);
  const skipped: Array<{ date: string; why: 'weekend' | 'holiday'; name?: string }> = [];
  for (const d of eachDay(r.from, r.to)) {
    const h = holidays.find((x) => x.date === d && cal.holidays.has(d));
    if (h && cal.excludeHolidays !== false) skipped.push({ date: d, why: 'holiday', name: h.name });
    else if (cal.excludeWeekends !== false && cal.weekendDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) skipped.push({ date: d, why: 'weekend' });
  }
  try { return { days: leaveDays(r, cal), skipped }; } catch { return null; }
}

// ---------- Capacity heat map ----------

export type HeatBucket = 'none' | 'low' | 'ok' | 'full' | 'over' | 'critical';
export const HEAT_BUCKETS: HeatBucket[] = ['none', 'low', 'ok', 'full', 'over', 'critical'];
/** Utilisation % → colour bucket: <50 low, 50–<85 ok, 85–100 full, >100–120 over, >120 critical; null (no capacity) → none. */
export function heatBucket(pct: number | null | undefined): HeatBucket {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return 'none';
  if (pct < 50) return 'low';
  if (pct < 85) return 'ok';
  if (pct <= 100) return 'full';
  if (pct <= 120) return 'over';
  return 'critical';
}
/** Token-driven colours (CSS variables from @worko/ui-tokens), mixed for a soft cell background. */
export const HEAT_STYLE: Record<HeatBucket, string> = {
  none: 'var(--w-surface-alt)',
  low: 'color-mix(in srgb, var(--w-status-waiting-client) 22%, transparent)',
  ok: 'color-mix(in srgb, var(--w-status-done) 25%, transparent)',
  full: 'color-mix(in srgb, var(--w-status-done) 50%, transparent)',
  over: 'color-mix(in srgb, var(--w-status-due-soon) 45%, transparent)',
  critical: 'color-mix(in srgb, var(--w-status-overdue) 50%, transparent)',
};

// ---------- Job P&L ----------

/** revenue/WIP/margin/loss are null without fee visibility (`feesVisible: false`), cost/margin without cost visibility. */
export type PnlItem = { key: string; label: string; revenuePaise: number | null; costPaise: number | null; marginPaise: number | null; wipPaise: number | null; minutes: number; loss: boolean | null };
/** Column totals of the visible rows; cost/margin stay null when the API hides cost. */
export function pnlTotals(items: PnlItem[]) {
  const costVisible = items.length > 0 && items.every((x) => x.costPaise !== null);
  const feesVisible = items.every((x) => x.revenuePaise !== null);
  const revenuePaise = feesVisible ? items.reduce((s, x) => s + (x.revenuePaise ?? 0), 0) : null;
  const costPaise = costVisible ? items.reduce((s, x) => s + (x.costPaise ?? 0), 0) : null;
  const marginPaise = costPaise === null || revenuePaise === null ? null : revenuePaise - costPaise;
  return { revenuePaise, costPaise, marginPaise, marginPct: marginPaise === null || !revenuePaise ? null : Math.round((marginPaise * 10_000) / revenuePaise) / 100,
    wipPaise: feesVisible ? items.reduce((s, x) => s + (x.wipPaise ?? 0), 0) : null, minutes: items.reduce((s, x) => s + x.minutes, 0), losses: items.filter((x) => x.loss).length };
}

// ---------- Expenses ----------

export type ClaimLine = { id: string; amountPaise: number };
/** Per-line approved amounts (missing → full claim) clamped to 0…claimed; total and whether it is a partial approval. */
export function approvalSums(lines: ClaimLine[], approved: Record<string, number | null>) {
  let claimed = 0; let total = 0; const invalid: string[] = [];
  const out = lines.map((l) => {
    claimed += l.amountPaise;
    const v = approved[l.id];
    const a = v === undefined ? l.amountPaise : v;
    if (a === null || a < 0 || a > l.amountPaise) { invalid.push(l.id); return { id: l.id, approvedPaise: 0 }; }
    total += a;
    return { id: l.id, approvedPaise: a };
  });
  return { lines: out, claimedPaise: claimed, approvedPaise: total, partial: total < claimed, invalid };
}
/** Client-side policy hint mirroring the server (warn → flagged line, block → refused). */
export function policyWarning(amountPaise: number | null, cat: { limitPaise: number | null; limitMode: string } | undefined): 'warn' | 'block' | null {
  if (!cat || cat.limitPaise === null || amountPaise === null || amountPaise <= cat.limitPaise) return null;
  return cat.limitMode === 'block' ? 'block' : 'warn';
}

// ---------- Months ----------
export const monthOf = (iso: string) => iso.slice(0, 7);
export function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
export const shiftMonth = (month: string, k: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return d.toISOString().slice(0, 7);
};
