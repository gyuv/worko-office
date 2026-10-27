import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffSchedules, evalDue, holidayCalendar, loadPack, periodsForFy, schedule, shift, type ClientFacts, type Rule } from './index.js';

const pack = loadPack(JSON.parse(readFileSync(new URL('../packs/in-seed.json', import.meta.url), 'utf8')));
const rule = (id: string) => pack.rules.find((r) => r.id === id)!;
const due = (id: string, fy: number) => periodsForFy(rule(id), fy).map((p) => evalDue(rule(id).due, p));

const clients: ClientFacts[] = [
  { id: 'c1', gstRegistered: true, gstFiling: 'MONTHLY', hasTan: true, entityType: 'PRIVATE_COMPANY', taxAudit: true },
  { id: 'c2', gstRegistered: true, gstFiling: 'QRMP', entityType: 'INDIVIDUAL', taxAudit: false },
  { id: 'c3', entityType: 'LLP', taxAudit: false },
];

describe('seed pack', () => {
  it('validates and is flagged unverified', () => {
    expect(pack.rules.length).toBeGreaterThan(15);
    expect(pack.rules.every((r) => r.verified === false)).toBe(true);
  });
});

describe('due expressions (golden)', () => {
  it('GSTR-3B 20th of next month across FY', () => {
    expect(due('gst.gstr3b.monthly', 2025)).toEqual([
      '2025-05-20', '2025-06-20', '2025-07-20', '2025-08-20', '2025-09-20', '2025-10-20',
      '2025-11-20', '2025-12-20', '2026-01-20', '2026-02-20', '2026-03-20', '2026-04-20',
    ]);
  });
  it('quarterly TDS return: last day of following month, clamps for 31', () => {
    expect(due('tds.quarterly_return', 2025)).toEqual(['2025-07-31', '2025-10-31', '2026-01-31', '2026-04-30']);
  });
  it('day clamps to month length incl. leap years', () => {
    const r: Rule = { ...rule('gst.gstr3b.monthly'), due: { anchor: 'period_end', addMonths: 1, day: 31 } };
    const feb = (fy: number) => evalDue(r.due, periodsForFy(r, fy)[9]!); // Jan → due in Feb
    expect(feb(2023)).toBe('2024-02-29');
    expect(feb(2024)).toBe('2025-02-28');
  });
  it('annual anchors to FY end', () => {
    expect(due('it.itr.non_audit', 2025)).toEqual(['2026-07-31']);
    expect(due('gst.gstr9', 2025)).toEqual(['2026-12-31']);
  });
  it('advance tax quarters', () => expect(due('it.advance_tax', 2026)).toEqual(['2026-06-15', '2026-09-15', '2026-12-15', '2027-03-15']));
});

describe('schedule', () => {
  const items = schedule({ pack, clients, fy: 2025 });
  it('applies applicability predicates', () => {
    const forms = (c: string) => new Set(items.filter((i) => i.clientId === c).map((i) => i.ruleId));
    expect(forms('c1').has('gst.gstr3b.monthly')).toBe(true);
    expect(forms('c1').has('roc.aoc4')).toBe(true);
    expect(forms('c2').has('gst.gstr1.qrmp')).toBe(true);
    expect(forms('c2').has('gst.gstr3b.monthly')).toBe(false);
    expect(forms('c3').has('llp.form11')).toBe(true);
    expect(forms('c3').has('it.itr.non_audit')).toBe(true);
  });
  it('March TDS deposit override → 30 April', () => {
    const m = items.find((i) => i.clientId === 'c1' && i.ruleId === 'tds.deposit' && i.period.key === '2026-03');
    expect(m?.statutoryDue).toBe('2026-04-30');
  });
  it('FY rollover produces next-year periods', () => {
    const next = schedule({ pack, clients, fy: 2026 }).filter((i) => i.ruleId === 'gst.gstr3b.monthly');
    expect(next[0]?.period.key).toBe('2026-04');
    expect(next.at(-1)?.statutoryDue).toBe('2027-04-20');
  });
});

describe('holiday shift', () => {
  const cal = holidayCalendar(['2025-08-15']);
  it('moves forward over holidays and Sundays', () => {
    expect(shift('2025-08-15', 'next_working_day', cal)).toBe('2025-08-16');
    expect(shift('2025-08-17', 'next_working_day', cal)).toBe('2025-08-18'); // Sunday
    expect(shift('2025-08-17', 'previous_working_day', cal)).toBe('2025-08-16');
    expect(shift('2025-08-17', 'none', cal)).toBe('2025-08-17');
  });
  it('exposes both statutory and act-by dates', () => {
    const p = { ...pack, rules: pack.rules.map((r) => r.id === 'gst.gstr3b.monthly' ? { ...r, holidayShift: 'next_working_day' as const } : r) };
    const it2 = schedule({ pack: p, clients, fy: 2025, calendar: cal }).find((i) => i.ruleId === 'gst.gstr3b.monthly' && i.period.key === '2025-06');
    expect(it2?.statutoryDue).toBe('2025-07-20'); // Sunday
    expect(it2?.actBy).toBe('2025-07-21');
  });
});

describe('extensions and diff', () => {
  it('notified extension scoped by predicate shifts only matching clients', () => {
    const before = schedule({ pack, clients, fy: 2025 });
    const after = schedule({ pack, clients, fy: 2025, extensions: [{
      id: 'ext1', ruleId: 'it.itr.non_audit', periodKey: 'FY2025-26', newDueDate: '2026-09-15',
      scope: { all: [{ field: 'entityType', op: 'eq', value: 'INDIVIDUAL' }] },
    }] });
    const d = diffSchedules(before, after);
    expect(d.changes).toEqual([{ clientId: 'c2', ruleId: 'it.itr.non_audit', periodKey: 'FY2025-26', from: '2026-07-31', to: '2026-09-15' }]);
    expect(d.clientsAffected).toBe(1);
  });
  it('effective-dated rule versions: new version applies only from its date', () => {
    const v2 = { ...rule('gst.gstr3b.monthly'), effectiveFrom: '2025-10-01', due: { anchor: 'period_end' as const, addMonths: 1, day: 22 } };
    const p2 = { ...pack, version: '0.2.0', rules: [...pack.rules, v2] };
    const d = diffSchedules(schedule({ pack, clients, fy: 2025 }), schedule({ pack: p2, clients, fy: 2025 }));
    expect(d.dueDatesChanged).toBe(6); // Oct–Mar
    expect(d.changes.every((c) => c.to?.endsWith('-22'))).toBe(true);
  });
  it('rejects duplicate rule versions', () => {
    expect(() => loadPack({ ...pack, rules: [pack.rules[0], pack.rules[0]] })).toThrow(/Duplicate/);
  });
});
