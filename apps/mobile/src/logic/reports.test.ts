import { formatINR, type ReportDefinition } from '@worko/domain';
import { describe, expect, it } from 'vitest';
import { exportDownloadPath, pnlMoney, readyExportId } from './reports';
import {
  aliasType, askBody, askVisible, cacheFileName, cacheOwner, chartBars, chartValueKey, currentFy, dashView, downloadToken, drillKey, formatValue, fyColumn, fyLabel, fyOptions,
  istToday, kpiTile, makeDashCache, readDashCache, reportError, routeForRefs, runBody, toDashboardData, widgetSource, withFy, type DashboardData, type Widget,
} from './reports';

const data: DashboardData = toDashboardData({
  dashboard: { id: null, name: 'Partner', origin: 'template', widgets: [{ id: 'w1', catalogueKey: 'unbilled_work', params: { fy: '2025-26' } }, { id: 'w2', reportId: 'r-1' }] },
  widgets: [{ id: 'w1', kind: 'kpi', title: 'Unbilled', value: '1234567', valueKey: 'sum_amount_paise', type: 'paise', hiddenColumns: [], asOf: '2026-10-30', explanation: '' }],
});

describe('values', () => {
  it('formats paise strings as integer rupees, minutes, numbers, IST dates', () => {
    expect(formatValue('1234567', 'paise')).toBe(formatINR(1234567));
    expect(formatValue('12.5', 'paise')).toBe(formatINR(0));
    expect(formatValue(125, 'minutes')).toBe('2h 05m');
    expect(formatValue(1234567, 'int')).toBe('12,34,567');
    expect(formatValue(null, 'paise')).toBe('—');
    expect(formatValue('2026-04-01', 'date')).toBe('01-04-2026');
    expect(formatValue('2026-10-29T20:00:00Z', 'datetime')).toBe('30-10-2026 01:30');
    expect(aliasType('sum_amount_paise', [{ key: 'amount_paise', type: 'paise' }])).toBe('paise');
    expect(aliasType('count', [])).toBe('int');
  });
  it('IST today flips at 18:30 UTC', () => {
    expect(istToday(Date.parse('2026-03-31T18:29:00Z'))).toBe('2026-03-31');
    expect(istToday(Date.parse('2026-03-31T18:30:00Z'))).toBe('2026-04-01');
  });
});

describe('KPI tiles', () => {
  it('shows value, hidden and error states plainly', () => {
    expect(kpiTile(data.widgets[0]!).text).toBe(formatINR(1234567));
    const hidden = { ...data.widgets[0]!, value: null, hiddenColumns: ['amount_paise'] } as Widget;
    expect(kpiTile(hidden)).toMatchObject({ text: '—', note: 'hidden' });
    expect(kpiTile({ id: 'x', kind: 'kpi', title: 'X', error: 'dataset_forbidden' })).toMatchObject({ note: 'error', error: 'dataset_forbidden' });
    expect(kpiTile({ ...data.widgets[0]!, value: null, type: 'int' } as Widget).text).toBe('0');
  });
  it('maps a widget to its source for the report view', () => {
    expect(widgetSource(data, 'w1')).toEqual({ catalogueKey: 'unbilled_work', params: { fy: '2025-26' } });
    expect(widgetSource(data, 'w2')).toEqual({ reportId: 'r-1', params: undefined });
    expect(widgetSource(data, 'nope')).toBeNull();
  });
});

describe('offline cache', () => {
  const owner = cacheOwner('t1', 'u1');
  it('is scoped to tenant + user and format version', () => {
    const raw = JSON.stringify(makeDashCache(owner, data, 1000));
    expect(readDashCache(raw, owner)?.data.dashboard.name).toBe('Partner');
    expect(readDashCache(raw, cacheOwner('t1', 'u2'))).toBeNull();
    expect(readDashCache(raw, cacheOwner('t2', 'u1'))).toBeNull();
    expect(readDashCache(JSON.stringify({ ...makeDashCache(owner, data, 1), v: 0 }), owner)).toBeNull();
    expect(readDashCache('garbage', owner)).toBeNull();
    expect(cacheFileName(owner)).toBe('dashboard-t1_u1.json');
  });
  it('live wins; saved copy is flagged with its time and staleness', () => {
    const c = makeDashCache(owner, data, 0);
    expect(dashView(data, c, 1)).toMatchObject({ fromCache: false });
    expect(dashView(undefined, c, 3600_000)).toMatchObject({ fromCache: true, savedAt: 0, stale: false });
    expect(dashView(undefined, c, 13 * 3600_000).stale).toBe(true);
    expect(dashView(undefined, null, 1).data).toBeUndefined();
  });
});

describe('charts', () => {
  const groups = [5, 3, 1, 2, 4].map((n, i) => ({ key: { user_id: `u${i}` }, label: `U${i}`, values: { sum_amount_paise: String(n * 100) } }));
  it('shapes top-N bars with Other (not drillable) and fractions of the max', () => {
    const bars = chartBars(groups, 'sum_amount_paise', 'paise', 3);
    expect(bars.map((b) => b.label)).toEqual(['U0', 'U1', 'Other']);
    expect(bars[2]).toMatchObject({ value: 700, key: null, frac: 1 });
    expect(bars[0]!.frac).toBeCloseTo(500 / 700);
    expect(chartBars([{ key: {}, label: 'a', values: { c: -3 } }], 'c', 'int')[0]!.frac).toBe(0);
    expect(chartValueKey(groups)).toBe('sum_amount_paise');
    expect(chartValueKey([])).toBeNull();
  });
});

describe('runs, FY and drill-down', () => {
  const def: ReportDefinition = { dataset: 'unbilled', columns: ['user_id'], filters: [{ column: 'work_date', op: 'period', value: 'this_fy' }], groupBy: ['user_id'], aggregates: [{ fn: 'sum', column: 'amount_paise' }], sort: [], params: {} } as ReportDefinition;
  it('FY picker lists current IST FY first and rewrites the FY filter', () => {
    expect(currentFy('2026-03-31')).toBe('2025-26');
    expect(currentFy('2026-04-01')).toBe('2026-27');
    expect(fyOptions('2026-10-30', 3)).toEqual(['2026-27', '2025-26', '2024-25']);
    expect(fyLabel('2025-26')).toBe('FY 25-26');
    expect(fyColumn(def)).toBe('work_date');
    expect(withFy(def, '2025-26').filters).toEqual([{ column: 'work_date', op: 'fy', value: '2025-26' }]);
    expect(withFy(def, 'bad')).toBe(def);
    expect(withFy({ ...def, filters: [] }, '2025-26').filters).toEqual([]);
  });
  it('builds one-source run bodies with drill keys (nulls kept)', () => {
    expect(runBody({ catalogueKey: 'x', params: {} })).toEqual({ catalogueKey: 'x' });
    expect(runBody({ definition: def, catalogueKey: 'x' }, { drill: drillKey({ key: { user_id: null, status: 'open' } }) })).toEqual({ definition: def, drill: { user_id: null, status: 'open' } });
  });
  it('entity taps prefer the row entity, then its client', () => {
    expect(routeForRefs({ client: 'c', task: 't' })).toEqual({ name: 'task', id: 't' });
    expect(routeForRefs({ client: 'c', user: 'u' })).toEqual({ name: 'client', id: 'c' });
    expect(routeForRefs({ user: 'u' })).toBeNull();
  });
});

describe('download links', () => {
  const tok = 'A'.repeat(43);
  it('accepts https and worko:// links or a bare token', () => {
    expect(downloadToken(`https://app.worko.in/v1/reports/downloads/${tok}`)).toBe(tok);
    expect(downloadToken(`worko://reports/downloads/${tok}?x=1`)).toBe(tok);
    expect(downloadToken(tok)).toBe(tok);
    expect(downloadToken('https://evil/x')).toBeNull();
    expect(downloadToken('')).toBeNull();
  });
});

describe('Ask visibility and errors', () => {
  const g = [{ module: 'ai', action: 'create', scope: 'all' }, { module: 'reports', action: 'view', scope: 'own' }];
  const av = { features: { nl_query: 'ok' } };
  it('needs nl_query ok + ai:create + reports:view', () => {
    expect(askVisible(av, g)).toBe(true);
    expect(askVisible({ features: { nl_query: 'feature_disabled' } }, g)).toBe(false);
    expect(askVisible({ ...av, userCapReached: true }, g)).toBe(false);
    expect(askVisible(av, g.slice(1))).toBe(false);
    expect(askVisible(av, g.slice(0, 1))).toBe(false);
    expect(askVisible(null, g)).toBe(false);
    expect(askBody('  hi ')).toEqual({ question: 'hi', run: true });
  });
  it('maps codes and statuses', () => {
    expect(reportError({ code: 'column_hidden', status: 403 })).toBe('column_hidden');
    expect(reportError({ status: 410 })).toBe('link_expired');
    expect(reportError({ status: 500 })).toBeNull();
  });
});

describe('coordinator follow-ups', () => {
  it('report.ready notices download by export id', () => {
    expect(readyExportId({ category: 'report.ready', entity_type: 'report_export', entity_id: 'e1' })).toBe('e1');
    expect(readyExportId({ category: 'report.ready', entity_type: 'task', entity_id: 'e1' })).toBeNull();
    expect(readyExportId({ category: 'task.due', entity_id: 'e1' })).toBeNull();
    expect(exportDownloadPath('e1')).toBe('/reports/exports/e1/download');
    expect(pnlMoney(null, false)).toEqual({ text: '—', hidden: true });
    expect(pnlMoney('500', true)).toEqual({ text: formatINR(500), hidden: false });
  });
  it('maps budget_exceeded / source_gone / export_forbidden', () => {
    expect(reportError({ code: 'budget_exceeded' })).toBe('budget_exceeded');
    expect(reportError({ code: 'source_gone', status: 410 })).toBe('source_gone');
    expect(reportError({ code: 'export_forbidden', status: 403 })).toBe('export_forbidden');
    expect(kpiTile({ id: 'k', kind: 'kpi', title: 'K', error: 'budget_exceeded' }).error).toBe('budget_exceeded');
  });
});
