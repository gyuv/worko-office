import { catalogueReport, reportDefinitionSchema, REPORT_CATALOGUE, validateDefinition, type ReportGroup } from '@worko/domain';
import { describe, expect, it } from 'vitest';
import {
  cellRef, chartData, drillKey, drillStep, emptyBuilder, filterRange, formatCell, fromDefinition, fyOptions, groupCatalogue, groupsAt, hiddenLabels, niceTicks, parseValue,
  periodFilter, refHref, reportError, schedulePreview, shares, toDefinition, validateBuilder, widgetChartData, type RunResult,
} from './logic';

const TODAY = '2026-10-30';

describe('builder ⇄ definition', () => {
  it('round-trips every catalogue definition through builder state', () => {
    for (const r of REPORT_CATALOGUE) {
      const back = reportDefinitionSchema.parse(toDefinition(fromDefinition(r.definition)));
      const orig = reportDefinitionSchema.parse(r.definition);
      expect(back.dataset).toBe(orig.dataset);
      expect(back.columns).toEqual(orig.columns);
      expect(back.filters).toEqual(orig.filters);
      expect(back.groupBy).toEqual(orig.groupBy);
      expect(back.aggregates).toEqual(orig.aggregates.map((a) => (a.column ? { fn: a.fn, column: a.column } : { fn: a.fn })));
      expect(back.sort).toEqual(orig.sort);
      expect(validateDefinition(back, TODAY).ok).toBe(true);
    }
  });
  it('types filter values: rupees → paise, lists, between, bool', () => {
    const s = { ...emptyBuilder('invoices'), filters: [
      { column: 'totalPaise', op: 'gte' as const, value: '1,500.50', value2: '' },
      { column: 'status', op: 'in' as const, value: 'issued, paid', value2: '' },
      { column: 'issueDate', op: 'between' as const, value: '2026-04-01', value2: '2026-09-30' },
    ] };
    const d = toDefinition(s);
    expect(d.filters).toEqual([{ column: 'totalPaise', op: 'gte', value: 150050 }, { column: 'status', op: 'in', value: ['issued', 'paid'] }, { column: 'issueDate', op: 'between', value: ['2026-04-01', '2026-09-30'] }]);
    expect(fromDefinition(d).filters[0]!.value).toBe('1500.50');
    expect(parseValue('bool', 'true')).toBe(true);
    expect(parseValue('minutes', '1:30')).toBe(90);
  });
  it('live validation reports schema issues (sum of a text column, missing dataset, KPI without aggregate)', () => {
    expect(validateBuilder(emptyBuilder(), TODAY).issues).toContain('Pick a dataset');
    const bad = { ...emptyBuilder('tasks'), aggregates: [{ fn: 'sum' as const, column: 'title' }] };
    expect(validateBuilder(bad, TODAY).issues.join()).toMatch(/sum needs a numeric column/);
    expect(validateBuilder({ ...emptyBuilder('tasks'), chart: 'kpi' }, TODAY).issues).toContain('A KPI needs an aggregate');
    const ok = { ...emptyBuilder('unbilled'), groupBy: ['assigneeName'], aggregates: [{ fn: 'sum' as const, column: 'suggestedPaise' }], chart: 'bar' as const };
    expect(validateBuilder(ok, TODAY)).toMatchObject({ ok: true, definition: { chart: { type: 'bar' } } });
  });
});

describe('FY / period pickers (IST)', () => {
  it('lists FYs around today and builds fy/period filters', () => {
    expect(fyOptions(TODAY).slice(0, 3)).toEqual(['2027-28', '2026-27', '2025-26']);
    expect(fyOptions('2026-03-31')[1]).toBe('2025-26');
    expect(periodFilter('completedOn', { kind: 'fy', fy: 'FY 25-26' })).toEqual({ column: 'completedOn', op: 'fy', value: '2025-26' });
    expect(periodFilter('receivedOn', { kind: 'month', month: '2026-09' })).toEqual({ column: 'receivedOn', op: 'period', value: 'month:2026-09' });
    expect(periodFilter('x', { kind: 'month', month: '2026-13' })).toBeNull();
    expect(filterRange('fy', '2025-26', TODAY)).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(filterRange('period', 'this_quarter', TODAY)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(filterRange('period', 'month:2026-02', TODAY)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
});

const g = (key: Record<string, unknown>, label: string, values: Record<string, number>, children?: ReportGroup[]): ReportGroup => ({ key, label, values, ...(children ? { children } : {}) });

describe('drill-down', () => {
  it('leaf group → drill body; parent → children; null keys stay null', () => {
    const leaf = g({ form: 'GSTR-1', state: 'overdue' }, 'overdue', { count: 2 });
    const parent = g({ form: 'GSTR-1' }, 'GSTR-1', { count: 5 }, [leaf]);
    expect(drillStep(parent)).toEqual({ kind: 'children', crumb: { key: { form: 'GSTR-1' }, label: 'GSTR-1' } });
    expect(drillStep(leaf)).toMatchObject({ kind: 'rows', drill: { form: 'GSTR-1', state: 'overdue' } });
    expect(drillKey({ assigneeName: null })).toEqual({ assigneeName: null });
    expect(groupsAt([parent], [{ key: { form: 'GSTR-1' }, label: 'GSTR-1' }])).toEqual([leaf]);
    expect(groupsAt([parent], [])).toEqual([parent]);
  });
});

const run = (over: Partial<RunResult> = {}): RunResult => ({
  dataset: { key: 'unbilled', label: 'Unbilled work', module: 'billing' }, explanation: '',
  definition: { ...catalogueReport('unbilled_by_client')!.definition, aggregates: [{ fn: 'count', as: 'count' }, { fn: 'sum', column: 'suggestedPaise', as: 'sum_suggestedPaise' }] },
  columns: [{ key: 'clientName', label: 'Client', type: 'text' }, { key: 'suggestedPaise', label: 'Suggested fee', type: 'paise' }], hiddenColumns: [], params: {}, asOf: TODAY,
  rows: [], rowCount: 0, page: 1, pageSize: 100, totals: { count: 3, sum_suggestedPaise: 1_250_000 }, groupsTruncated: false, chart: { type: 'bar', x: 'clientName', y: 'sum_suggestedPaise' },
  groups: [g({ clientName: 'Mehta Traders' }, 'Mehta Traders', { count: 2, sum_suggestedPaise: 1_000_000 }), g({ clientName: 'Shah Exports' }, 'Shah Exports', { count: 1, sum_suggestedPaise: 250_000 })],
  ...over,
});

describe('chart shaping', () => {
  it('uses the chart y alias over groups and keeps paise integers', () => {
    const cd = chartData(run())!;
    expect(cd).toMatchObject({ type: 'bar', yKey: 'sum_suggestedPaise', yType: 'paise', xLabel: 'Client', total: 1_250_000 });
    expect(cd.points.map((p) => p.value)).toEqual([1_000_000, 250_000]);
    expect(formatCell(cd.points[0]!.value, cd.yType)).toBe('₹10,000.00');
    expect(chartData(run(), 'table')).toBeNull();
  });
  it('falls back to rows with x/y when ungrouped; pie → shares with Other', () => {
    const cd = chartData(run({ groups: [], rows: [{ values: { clientName: 'A', suggestedPaise: 500 }, refs: {} }] }))!;
    expect(cd.points).toEqual([{ label: 'A', value: 500 }]);
    const s = shares([1, 2, 3, 4, 5, 6, 7, 8, 9].map((v) => ({ label: `c${v}`, value: v })), 3);
    expect(s.map((x) => x.label)).toEqual(['c9', 'c8', 'c7', 'Other (6)']);
    expect(s.reduce((a, x) => a + x.pct, 0)).toBeCloseTo(100, 0);
    expect(niceTicks(1_000_000)).toEqual([0, 250_000, 500_000, 750_000, 1_000_000]);
  });
  it('dashboard chart widget picks the first non-count alias and infers paise', () => {
    const cd = widgetChartData({ title: 'Ageing', chart: 'bar', groups: [g({ bucket: '0_30' }, '0_30', { sum_balancePaise: 990 })] })!;
    expect(cd).toMatchObject({ yKey: 'sum_balancePaise', yType: 'paise' });
  });
});

describe('hidden columns, links, errors', () => {
  it('names hidden columns and turns column_hidden into a reason', () => {
    expect(hiddenLabels('time_entries', ['costPaise'])).toEqual(['Cost']);
    expect(reportError({ status: 403, code: 'column_hidden', body: { columns: ['costPaise'] } })).toMatchObject({ code: 'column_hidden', columns: ['costPaise'] });
  });
  it('links entity cells', () => {
    const meta = { key: 'tasks', label: '', description: '', module: 'tasks' as const, entity: 'task' as const, columns: [{ key: 'clientId', label: '', type: 'id' as const, ref: 'client' as const }] };
    expect(cellRef('clientName', { refs: { client: 'c1' } }, meta)).toEqual({ type: 'client', id: 'c1' });
    expect(cellRef('title', { refs: { task: 't1' } }, meta)).toEqual({ type: 'task', id: 't1' });
    expect(refHref('invoice', 'i1')).toBe('#/billing/i1');
  });
  it('groups the catalogue by area with search', () => {
    const items = REPORT_CATALOGUE.map((r) => ({ ...r, dataset: r.definition.dataset }));
    const all = groupCatalogue(items, '');
    expect(all[0]!.area).toBe('billing');
    expect(groupCatalogue(items, 'dsc').flatMap((x) => x.items.map((i) => i.key))).toEqual(['dsc_expiring']);
  });
});

describe('schedule preview (IST)', () => {
  it('describes and computes the next run in IST', () => {
    const now = new Date('2026-10-30T10:00:00+05:30'); // Friday
    expect(schedulePreview({ frequency: 'weekly', time: '08:00', weekday: 1, dayOfMonth: 1 }, now)).toMatchObject({ text: 'Weekly on Monday at 08:00 IST', nextText: '02 Nov 2026, 08:00 IST' });
    expect(schedulePreview({ frequency: 'daily', time: '18:30', weekday: 1, dayOfMonth: 1 }, now).next.toISOString()).toBe('2026-10-30T13:00:00.000Z');
    expect(schedulePreview({ frequency: 'monthly', time: '07:00', weekday: 1, dayOfMonth: 1 }, now)).toMatchObject({ text: 'Monthly on day 1 at 07:00 IST', nextText: '01 Nov 2026, 07:00 IST' });
  });
});

import { pnlTotals } from '../hr/logic';
import { exportDownloadError, hasHiddenValues } from './logic';
describe('backend follow-ups', () => {
  it('maps download errors', () => {
    expect(exportDownloadError({ status: 410, code: 'link_expired' })).toBe('p11.dl.expired');
    expect(exportDownloadError({ status: 410, code: 'source_gone' })).toBe('p11.dl.sourceGone');
    expect(exportDownloadError({ status: 403, code: 'export_forbidden' })).toBe('p11.dl.forbidden');
    expect(exportDownloadError({ status: 404 })).toBe('p11.dl.notYours');
  });
  it('detects [hidden] filter values', () => {
    expect(hasHiddenValues({ filters: [{ value: ['[hidden]'] }] })).toBe(true);
    expect(hasHiddenValues({ filters: [{ value: 'x' }] })).toBe(false);
  });
  it('P&L totals stay null when fees are hidden', () => {
    const t = pnlTotals([{ key: 'a', label: 'A', revenuePaise: null, costPaise: 100, marginPaise: null, wipPaise: null, minutes: 60, loss: null }]);
    expect(t).toMatchObject({ revenuePaise: null, wipPaise: null, marginPaise: null, costPaise: 100, minutes: 60 });
  });
});
