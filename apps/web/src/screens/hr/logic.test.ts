import { describe, expect, it } from 'vitest';
import { approvalSums, buildGrid, cellEditable, fmtMinutes, heatBucket, leavePreview, monthRange, parseMinutes, pnlTotals, policyWarning, shiftMonth, weekOf } from './logic';

describe('durations', () => {
  it('parses and formats', () => {
    expect(parseMinutes('1:30')).toBe(90);
    expect(parseMinutes('1.5')).toBe(90);
    expect(parseMinutes('90m')).toBe(90);
    expect(parseMinutes('2h')).toBe(120);
    expect(parseMinutes('')).toBe(0);
    expect(parseMinutes('abc')).toBeNull();
    expect(fmtMinutes(605)).toBe('10:05');
    expect(fmtMinutes(-90)).toBe('-1:30');
  });
});

describe('timesheet grid', () => {
  const wk = weekOf('2026-10-28'); // Wednesday → Monday 26th
  it('groups by task/client, totals rows, days and week', () => {
    expect(wk).toBe('2026-10-26');
    const g = buildGrid([
      { id: 'a', taskId: 't1', taskTitle: 'GSTR-3B', clientId: 'c1', clientName: 'Acme', workDate: '2026-10-26', minutes: 60, status: 'draft' },
      { id: 'b', taskId: 't1', taskTitle: 'GSTR-3B', clientId: 'c1', clientName: 'Acme', workDate: '2026-10-26', minutes: 30, status: 'approved' },
      { id: 'c', taskId: 't1', taskTitle: 'GSTR-3B', clientId: 'c1', clientName: 'Acme', workDate: '2026-10-27', minutes: 45, status: 'draft' },
      { id: 'd', taskId: null, clientId: 'c2', clientName: 'Beta', workDate: '2026-10-27', minutes: 15, status: 'rejected' },
      { id: 'e', taskId: null, clientId: null, workDate: '2026-11-02', minutes: 99, status: 'draft' }, // next week: ignored
    ], wk, [{ taskId: null, clientId: 'c3', label: 'Gamma', sub: null }]);
    expect(g.rows.map((r) => r.label)).toEqual(['GSTR-3B', 'Beta', 'Gamma']);
    expect(g.rows[0]!.total).toBe(135);
    expect(g.rows[0]!.sub).toBe('Acme');
    expect(g.dayTotals['2026-10-26']).toBe(90);
    expect(g.dayTotals['2026-10-27']).toBe(60);
    expect(g.total).toBe(150);
    expect(g.draftCount).toBe(3);
    expect(cellEditable(g.rows[0]!.cells['2026-10-26']!)).toBe(false);
    expect(cellEditable(g.rows[0]!.cells['2026-10-27']!)).toBe(true);
    expect(cellEditable(g.rows[2]!.cells['2026-10-28']!)).toBe(true);
  });
});

describe('leave preview', () => {
  const ww = { weekendDays: [0], excludeWeekends: true, excludeHolidays: true };
  const hol = [{ date: '2026-11-09', name: 'Diwali' }, { date: '2026-11-10', name: 'Optional', optional: true }, { date: '2026-11-11', name: 'Branch day', branchId: 'b2' }];
  it('skips weekends and firm holidays, counts half days', () => {
    // Sat 7 → Wed 11 Nov 2026: Sun 8 off, Mon 9 holiday; optional and other-branch holidays count.
    const p = leavePreview({ from: '2026-11-07', to: '2026-11-11', startHalf: true }, ww, hol)!;
    expect(p.days).toBe(2.5);
    expect(p.skipped).toEqual([{ date: '2026-11-08', why: 'weekend' }, { date: '2026-11-09', why: 'holiday', name: 'Diwali' }]);
    expect(leavePreview({ from: '2026-11-11', to: '2026-11-11' }, ww, hol, 'b2')!.days).toBe(0);
  });
  it('rejects bad ranges', () => {
    expect(leavePreview({ from: '2026-11-12', to: '2026-11-11' }, ww, [])).toBeNull();
    expect(leavePreview({ from: '2026-11-12', to: '2026-11-12', startHalf: true, endHalf: true }, ww, [])).toBeNull();
  });
  it('counts every day when the firm does not skip weekends', () => {
    expect(leavePreview({ from: '2026-11-07', to: '2026-11-09' }, { ...ww, excludeWeekends: false, excludeHolidays: false }, hol)!.days).toBe(3);
  });
});

describe('heat map buckets', () => {
  it('maps utilisation to buckets at the edges', () => {
    expect([null, 0, 49.9, 50, 84.9, 85, 100, 100.1, 120, 120.1, 300].map(heatBucket)).toEqual(['none', 'low', 'low', 'ok', 'ok', 'full', 'full', 'over', 'over', 'critical', 'critical']);
  });
});

describe('job P&L totals', () => {
  const row = (key: string, revenuePaise: number, costPaise: number | null, wipPaise = 0, minutes = 60) =>
    ({ key, label: key, revenuePaise, costPaise, marginPaise: costPaise === null ? null : revenuePaise - costPaise, wipPaise, minutes, loss: costPaise !== null && revenuePaise < costPaise });
  it('sums revenue/cost/margin/WIP and counts losses', () => {
    const t = pnlTotals([row('a', 100000, 40000, 5000), row('b', 20000, 30000, 0, 30)]);
    expect(t).toEqual({ revenuePaise: 120000, costPaise: 70000, marginPaise: 50000, marginPct: 41.67, wipPaise: 5000, minutes: 90, losses: 1 });
  });
  it('keeps cost hidden when the API hides it', () => {
    const t = pnlTotals([row('a', 100000, null)]);
    expect(t.costPaise).toBeNull();
    expect(t.marginPaise).toBeNull();
    expect(t.marginPct).toBeNull();
  });
});

describe('expense approval sums', () => {
  const lines = [{ id: 'l1', amountPaise: 50000 }, { id: 'l2', amountPaise: 25050 }];
  it('defaults to full, sums partial approvals in paise', () => {
    expect(approvalSums(lines, {})).toMatchObject({ claimedPaise: 75050, approvedPaise: 75050, partial: false, invalid: [] });
    const s = approvalSums(lines, { l1: 30000, l2: 0 });
    expect(s).toMatchObject({ approvedPaise: 30000, partial: true, invalid: [] });
    expect(s.lines).toEqual([{ id: 'l1', approvedPaise: 30000 }, { id: 'l2', approvedPaise: 0 }]);
  });
  it('flags amounts above the claim or unparseable', () => {
    expect(approvalSums(lines, { l1: 50001, l2: null }).invalid).toEqual(['l1', 'l2']);
  });
  it('policy warnings follow the category limit', () => {
    expect(policyWarning(60000, { limitPaise: 50000, limitMode: 'warn' })).toBe('warn');
    expect(policyWarning(60000, { limitPaise: 50000, limitMode: 'block' })).toBe('block');
    expect(policyWarning(50000, { limitPaise: 50000, limitMode: 'block' })).toBeNull();
    expect(policyWarning(60000, { limitPaise: null, limitMode: 'warn' })).toBeNull();
  });
});

describe('months', () => {
  it('ranges and shifts', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });
});
