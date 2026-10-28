import type { LocalRow } from '@worko/sync';
import { describe, expect, it } from 'vitest';
import {
  attendanceView, balancesFrom, buildClaim, buildDraft, calendarOf, canCancelLeave, elapsed, fmtMinutes, groupWeek, leavePreview, limitHint, parseDays,
  parseDuration, runningTimer, toAttendance, todaysAttendance, toHolidays, toLeaveRequests, toLeaveTypes, toTimeItem, type DraftForm,
} from './hr';
import { todayIST } from './registers';

const ME = '00000000-0000-4000-8000-000000000001';
const row = (table: string, id: string, fields: Record<string, unknown>, deleted = false): LocalRow => ({ table, id, version: 1, deleted, fields });
const te = (id: string, f: Record<string, unknown>) => toTimeItem(row('time_entry', id, { user_id: ME, status: 'draft', billable: true, ...f }));
const istOf = (iso: string) => todayIST(new Date(iso));

describe('week grouping and totals', () => {
  const es = [
    te('a', { work_date: '2026-10-26', minutes: 90 }), te('b', { work_date: '2026-10-26', minutes: 30, billable: false }),
    te('c', { work_date: '2026-11-01', minutes: '60', status: 'approved' }), te('d', { work_date: '2026-10-25', minutes: 600 }),
    te('e', { work_date: '2026-10-28', minutes: 45, user_id: 'other' }), te('f', { work_date: '2026-10-29', minutes: 15, status: 'rejected' }),
  ];
  it('Mon–Sun, own only, totals and draft count', () => {
    const w = groupWeek(es, '2026-10-28', ME);
    expect(w.weekStart).toBe('2026-10-26'); expect(w.weekEnd).toBe('2026-11-01');
    expect(w.days).toHaveLength(7);
    expect(w.days[0]!.minutes).toBe(120);
    expect(w.totalMinutes).toBe(195); expect(w.billableMinutes).toBe(165);
    expect(w.byStatus).toEqual({ draft: 120, submitted: 0, approved: 60, rejected: 15 });
    expect(w.draftCount).toBe(3); expect(w.submittable).toBe(true);
  });
  it('formats durations', () => {
    expect(fmtMinutes(90)).toBe('1h 30m'); expect(fmtMinutes(45)).toBe('45m'); expect(fmtMinutes(120)).toBe('2h'); expect(fmtMinutes(-30)).toBe('-30m');
    expect(parseDuration('1:30')).toBe(90); expect(parseDuration('1.5')).toBe(90); expect(parseDuration('2h')).toBe(120); expect(parseDuration('45')).toBe(45);
    expect(parseDuration('45m')).toBe(45); expect(parseDuration('abc')).toBeNull(); expect(parseDuration('1:75')).toBeNull();
  });
});

describe('offline draft validation', () => {
  const base: DraftForm = { workDate: '2026-10-28', duration: '1:00', notes: ' GST recon ', billable: true, taskId: null, clientId: null };
  it('builds a draft patch', () => {
    const r = buildDraft(base, '2026-10-28', []);
    expect(r).toEqual({ ok: true, patch: { work_date: '2026-10-28', minutes: 60, notes: 'GST recon', billable: true, task_id: null, client_id: null, status: 'draft' } });
  });
  it('refuses future dates, bad durations and > 24 h per day', () => {
    expect(buildDraft({ ...base, workDate: '2026-10-29' }, '2026-10-28', [])).toEqual({ ok: false, errors: ['future'] });
    expect(buildDraft({ ...base, workDate: '28-10-2026' }, '2026-10-28', [])).toEqual({ ok: false, errors: ['date'] });
    expect(buildDraft({ ...base, duration: '0' }, '2026-10-28', [])).toEqual({ ok: false, errors: ['duration'] });
    expect(buildDraft({ ...base, duration: '2h' }, '2026-10-28', [te('x', { work_date: '2026-10-28', minutes: 1400 })])).toEqual({ ok: false, errors: ['dayCap'] });
  });
});

describe('timer', () => {
  it('finds the running one and formats elapsed', () => {
    const rows = [row('time_timer', 'old', { user_id: ME, started_at: '2026-10-27T03:00:00Z', stopped_at: '2026-10-27T05:00:00Z' }),
      row('time_timer', 'run', { user_id: ME, started_at: '2026-10-28T03:00:00Z', stopped_at: null, notes: 'Audit' })];
    expect(runningTimer(rows, ME)?.id).toBe('run');
    expect(runningTimer(rows, 'x')).toBeNull();
    expect(elapsed('2026-10-28T03:00:00Z', Date.parse('2026-10-28T04:02:03Z'))).toBe('01:02:03');
    expect(elapsed('2026-10-28T03:00:00Z', Date.parse('2026-10-28T02:00:00Z'))).toBe('00:00:00');
  });
});

describe('attendance status display', () => {
  it('none → pending local → server flags', () => {
    expect(attendanceView(null)).toMatchObject({ phase: 'none', statusKey: 'none' });
    const local = row('attendance', 'a', { device_check_in_at: '2026-10-28T03:30:00Z' });
    const today = todaysAttendance([local], '2026-10-28', istOf);
    expect(today?.id).toBe('a');
    expect(attendanceView(today)).toMatchObject({ phase: 'in', synced: false, statusKey: 'pending', tone: 'pending' });
    const synced = toAttendance(row('attendance', 'a', { work_date: '2026-10-28', check_in_at: '2026-10-28T03:31:00Z', device_check_in_at: '2026-10-28T03:30:00Z',
      status: 'flagged', flags: '{outside_fence,clock_skew}', in_fence: false, distance_m: '420', device_check_out_at: '2026-10-28T12:00:00Z' }));
    expect(synced.flags).toEqual(['outside_fence', 'clock_skew']); expect(synced.distanceM).toBe(420);
    expect(attendanceView(synced)).toMatchObject({ phase: 'out', pendingOut: true, statusKey: 'flagged', tone: 'warn' });
    expect(attendanceView({ ...synced, status: 'rejected' }).tone).toBe('bad');
    expect(attendanceView({ ...synced, status: 'ok', checkOutAt: '2026-10-28T12:01:00Z' })).toMatchObject({ tone: 'ok', pendingOut: false });
  });
  it('ignores other days', () => {
    expect(todaysAttendance([row('attendance', 'y', { work_date: '2026-10-27', check_in_at: '2026-10-27T03:00:00Z' })], '2026-10-28', istOf)).toBeNull();
  });
});

describe('leave', () => {
  const holidays = toHolidays([row('holiday', 'h1', { on_date: '2026-11-09', name: 'Diwali' }), row('holiday', 'h2', { on_date: '2026-11-11', name: 'Optional', optional: true })]);
  const types = toLeaveTypes([row('leave_type', 'cl', { key: 'cl', name: 'Casual', tracked: true, allow_half_day: true, max_days_per_request: '3', sort: 1 }),
    row('leave_type', 'lwp', { key: 'lwp', name: 'Unpaid', tracked: false, allow_half_day: false, sort: 2 }), row('leave_type', 'old', { key: 'o', name: 'Old', active: false })]);
  it('previews days excluding weekends and holidays (Sun-only weekend by default)', () => {
    const cal = calendarOf(holidays);
    // Sat 7 Nov → Wed 11 Nov: Sun 8 skipped, Mon 9 holiday, 11 optional counts.
    const p = leavePreview({ leaveTypeId: 'cl', from: '2026-11-07', to: '2026-11-11', startHalf: true, endHalf: false, reason: '' }, cal, holidays, types[0], 10);
    expect(p.days).toBe(2.5);
    expect(p.skipped).toEqual([{ date: '2026-11-08', why: 'weekend' }, { date: '2026-11-09', why: 'holiday', name: 'Diwali' }]);
    expect(p.errors).toEqual([]);
    const sat = calendarOf(holidays, { workWeek: { weekendDays: [0, 6], excludeWeekends: true, excludeHolidays: true } });
    expect(leavePreview({ leaveTypeId: 'cl', from: '2026-11-07', to: '2026-11-09', startHalf: false, endHalf: false, reason: '' }, sat, holidays, types[0], 10))
      .toMatchObject({ days: 0, errors: ['noDays'] });
  });
  it('flags limits, balance, half days and bad ranges', () => {
    const cal = calendarOf(holidays);
    const f = { leaveTypeId: 'cl', from: '2026-11-02', to: '2026-11-06', startHalf: false, endHalf: false, reason: '' };
    expect(leavePreview(f, cal, holidays, types[0], 2).errors).toEqual(['maxDays', 'balance']);
    expect(leavePreview({ ...f, endHalf: true }, cal, holidays, types[1], null).errors).toEqual(['halfNotAllowed']);
    expect(leavePreview({ ...f, to: '2026-11-01' }, cal, holidays, types[0], 5).errors).toEqual(['order']);
    expect(leavePreview({ ...f, to: f.from, startHalf: true, endHalf: true }, cal, holidays, types[0], 5).errors).toEqual(['halves']);
    expect(leavePreview(f, cal, holidays, undefined, null).errors).toContain('type');
  });
  it('balances from the ledger minus pending (strings, expiry FIFO)', () => {
    const ledger = [row('leave_ledger', 'l1', { leave_type_id: 'cl', delta: '12', on_date: '2026-04-01' }), row('leave_ledger', 'l2', { leave_type_id: 'cl', delta: '-1.5', on_date: '2026-06-01' }),
      row('leave_ledger', 'l3', { leave_type_id: 'cl', delta: '1', on_date: '2026-09-01', expires_on: '2026-10-01' }),
      row('leave_ledger', 'l4', { leave_type_id: 'cl', delta: '1', on_date: '2026-10-01', expires_on: '2026-12-31' })];
    const reqs = toLeaveRequests([row('leave_request', 'r1', { leave_type_id: 'cl', from_date: '2026-11-02', to_date: '2026-11-03', days: '2', status: 'pending' }),
      row('leave_request', 'r2', { leave_type_id: 'cl', from_date: '2026-06-01', to_date: '2026-06-02', days: '1.5', status: 'approved' })]);
    const [cl] = balancesFrom(ledger, reqs, types, '2026-10-28');
    // credits 14, debit 1.5 consumes the earliest-expiring (l3 1, then l4 0.5) → live = 12 + 0.5
    expect(cl).toMatchObject({ leaveTypeId: 'cl', balance: 12.5, pending: 2, available: 10.5, expiring: [{ days: 1, expiresOn: '2026-12-31' }] });
    expect(balancesFrom(ledger, reqs, types, '2026-10-28')).toHaveLength(1); // untracked types excluded
    expect(canCancelLeave(reqs[0]!, '2026-10-28')).toBe(true);
    expect(canCancelLeave(reqs[1]!, '2026-10-28')).toBe(false);
    expect(parseDays('0.5')).toBe(0.5); expect(parseDays('x')).toBe(0);
  });
});

describe('expense claim', () => {
  it('validates lines into paise', () => {
    const r = buildClaim(' Travel ', [{ categoryKey: 'travel', spentOn: '2026-10-27', description: 'Cab', amount: '1,180.50', receiptDocId: 'd1' }], '2026-10-28');
    expect(r).toEqual({ ok: true, totalPaise: 118050, body: { title: 'Travel', lines: [{ categoryKey: 'travel', spentOn: '2026-10-27', description: 'Cab', amountPaise: 118050, receiptDocId: 'd1' }] } });
    const bad = buildClaim('', [{ categoryKey: '', spentOn: '2026-10-29', description: '', amount: '1.234', receiptDocId: null }], '2026-10-28');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.error)).toEqual(['title', 'category', 'future', 'description', 'amount']);
    expect(limitHint(60000, { limitPaise: 50000, limitMode: 'warn' })).toBe('warn');
    expect(limitHint(60000, { limitPaise: 50000, limitMode: 'block' })).toBe('block');
    expect(limitHint(40000, { limitPaise: 50000 })).toBeNull();
  });
});
