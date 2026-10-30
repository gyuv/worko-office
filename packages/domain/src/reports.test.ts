import { describe, expect, it } from 'vitest';
import {
  aggregate, compileFilters, DATASETS, datasetMeta, drillDefinition, explainDefinition, groupRows, hiddenColumns, matchesFilters, nextScheduleRun, parseFy, periodRange,
  REPORT_CATALOGUE, reportDefinitionSchema, resolveParams, ROLE_DASHBOARD_TEMPLATES, schedulePeriodKey, sortRows, validateDefinition, dashboardWidgetsSchema,
  type ValidDefinition,
} from './index.js';

const TODAY = '2026-10-30';
const ok = (raw: unknown) => { const r = validateDefinition(raw, TODAY); if (!r.ok) throw new Error(r.issues.join('; ')); return r; };

describe('FY and periods (IST)', () => {
  it('parses FY labels in every common spelling', () => {
    for (const s of ['2025-26', 'FY 25-26', 'FY2025-26', '25-26', 'fy 2025-2026', '2025']) expect(parseFy(s)).toMatchObject({ from: '2025-04-01', to: '2026-03-31', label: '2025-26' });
    expect(parseFy('2025-27')).toBeNull();
    expect(parseFy('next year')).toBeNull();
  });
  it('resolves named periods against an injected today', () => {
    expect(periodRange('this_fy', TODAY)).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(periodRange('this_fy', '2026-02-10')).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(periodRange('last_fy', TODAY)).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(periodRange('this_month', TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodRange('last_month', '2026-03-15')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('this_quarter', TODAY)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(periodRange('last_quarter', '2026-01-05')).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(periodRange('this_week', TODAY)).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(periodRange('next_90_days', TODAY)).toEqual({ from: TODAY, to: '2027-01-28' });
    expect(periodRange('month:2026-02', TODAY)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('fy:25-26', TODAY)).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(periodRange('forever', TODAY)).toBeNull();
  });
  it('dataset parameters default in IST and are type-checked', () => {
    const pnl = datasetMeta('job_pnl')!;
    expect(resolveParams(pnl, {}, TODAY)).toEqual({ params: { from: '2026-04-01', to: TODAY, groupBy: 'client' }, issues: [] });
    expect(resolveParams(pnl, { groupBy: 'nope', evil: 'x' }, TODAY).issues).toEqual(['Unknown parameter evil', 'Invalid parameter groupBy']);
    expect(resolveParams(datasetMeta('capacity')!, { weeks: 99 }, TODAY).issues).toEqual(['Invalid parameter weeks']);
  });
});

describe('definition validation', () => {
  it('every catalogue report and role dashboard is valid', () => {
    for (const r of REPORT_CATALOGUE) expect(validateDefinition(r.definition, TODAY).ok, r.key).toBe(true);
    for (const [role, d] of Object.entries(ROLE_DASHBOARD_TEMPLATES)) {
      expect(dashboardWidgetsSchema.safeParse(d.widgets).success, role).toBe(true);
      for (const w of d.widgets) expect(REPORT_CATALOGUE.some((r) => r.key === w.catalogueKey), w.id).toBe(true);
    }
    expect(new Set(DATASETS.map((d) => d.key)).size).toBe(DATASETS.length);
  });
  it('rejects unknown datasets/columns, raw SQL and wrong ops/values', () => {
    const bad = (raw: unknown) => { const r = validateDefinition(raw, TODAY); expect(r.ok).toBe(false); return r.ok ? [] : r.issues; };
    expect(bad({ dataset: 'pg_shadow' })).toEqual(['Unknown dataset pg_shadow']);
    expect(bad({ dataset: 'tasks; DROP TABLE task' })[0]).toMatch(/dataset/);
    expect(bad({ dataset: 'tasks', columns: ['title', 'password_hash'] })[0]).toMatch(/columns/);
    expect(bad({ dataset: 'tasks', columns: ['(SELECT 1)'] })[0]).toMatch(/Unknown column/);
    expect(bad({ dataset: 'tasks', sql: 'SELECT 1' })[0]).toMatch(/Unrecognized key/);
    expect(bad({ dataset: 'tasks', filters: [{ column: 'title', op: 'gt', value: 'a' }] })[0]).toMatch(/gt not allowed/);
    expect(bad({ dataset: 'tasks', filters: [{ column: 'status', op: 'eq', value: 'nope' }] })[0]).toMatch(/invalid value/);
    expect(bad({ dataset: 'tasks', filters: [{ column: 'statutoryDue', op: 'fy', value: 'someday' }] })[0]).toMatch(/invalid fy/);
    expect(bad({ dataset: 'tasks', aggregates: [{ fn: 'sum', column: 'title' }] })[0]).toMatch(/numeric/);
    expect(bad({ dataset: 'tasks', groupBy: ['a', 'b', 'c'] })[0]).toMatch(/groupBy/);
    expect(bad({ dataset: 'tasks', sort: [{ by: 'nope' }] })[0]).toMatch(/sort/);
  });
  it('resolves FY/period filters, defaults count when grouping, keeps filter values as data', () => {
    const r = ok({ dataset: 'unbilled', filters: [{ column: 'completedOn', op: 'fy', value: 'FY 25-26' }, { column: 'clientName', op: 'contains', value: "x'; DROP TABLE client;--" }], groupBy: ['assigneeName'] });
    expect(r.def.resolved[0]).toEqual({ column: 'completedOn', op: 'between', value: ['2025-04-01', '2026-03-31'] });
    expect(r.def.aggregates).toEqual([{ fn: 'count', as: 'count' }]);
    const values: unknown[] = [];
    const sql = compileFilters(r.def.resolved, (k) => ({ completedOn: { expr: 'x.done_on', type: 'date' as const }, clientName: { expr: 'c.name', type: 'text' as const } })[k], (v) => { values.push(v); return `$${values.length}`; });
    expect(sql).toEqual(['(x.done_on) BETWEEN $1::date AND $2::date', 'strpos(lower((c.name)), lower($3::text)) > 0']);
    expect(values).toEqual(['2025-04-01', '2026-03-31', "x'; DROP TABLE client;--"]);
    expect(sql.join(' ')).not.toContain('DROP');
  });
  it('compiles every op with typed casts; datetimes compare on the IST date', () => {
    const vals: unknown[] = [];
    const col = (k: string) => ({ at: { expr: 't.completed_at', type: 'datetime' as const }, n: { expr: 'x.amount', type: 'paise' as const }, s: { expr: 'x.status', type: 'enum' as const }, id: { expr: 'x.id', type: 'id' as const } })[k];
    const sql = compileFilters([{ column: 'at', op: 'gte', value: '2026-04-01' }, { column: 'n', op: 'between', value: [1, 5] }, { column: 's', op: 'nin', value: ['a'] }, { column: 'id', op: 'is_null' }, { column: 'zz', op: 'eq', value: 1 }], col, (v) => { vals.push(v); return `$${vals.length}`; });
    expect(sql).toEqual([`((t.completed_at) AT TIME ZONE 'Asia/Kolkata')::date >= $1::date`, '(x.amount) BETWEEN $2::bigint AND $3::bigint', '((x.status) IS NULL OR NOT ((x.status) = ANY($4::text[])))', '(x.id)::text IS NULL']);
  });
});

describe('aggregation on paise, grouping, drill-down', () => {
  const meta = datasetMeta('unbilled')!;
  const rows = [
    { assigneeName: 'Asha', clientName: 'A', suggestedPaise: 150_001, completedOn: '2025-05-01' },
    { assigneeName: 'Asha', clientName: 'B', suggestedPaise: 99_999, completedOn: '2025-06-01' },
    { assigneeName: 'Ravi', clientName: 'A', suggestedPaise: null, completedOn: '2026-01-10' },
    { assigneeName: null, clientName: 'C', suggestedPaise: 1, completedOn: '2026-03-31' },
  ];
  it('sums stay integer paise; avg rounds to an integer; count(column) skips nulls', () => {
    const v = aggregate(rows, [{ fn: 'sum', column: 'suggestedPaise', as: 's' }, { fn: 'avg', column: 'suggestedPaise', as: 'a' }, { fn: 'count', column: 'suggestedPaise', as: 'n' }, { fn: 'count', as: 'c' }, { fn: 'max', column: 'completedOn', as: 'm' }], meta);
    expect(v).toEqual({ s: 250_001, a: 83_334, n: 3, c: 4, m: '2026-03-31' });
    expect(Number.isInteger(v.s)).toBe(true);
  });
  it('groups (2 levels, nulls last), and a drill-down on a group reproduces its value', () => {
    const r = ok({ dataset: 'unbilled', groupBy: ['assigneeName', 'clientName'], aggregates: [{ fn: 'sum', column: 'suggestedPaise' }], sort: [{ by: 'sum_suggestedPaise', dir: 'desc' }] });
    const g = groupRows(rows, r.def, meta);
    expect(g.map((x) => [x.label, x.values.sum_suggestedPaise])).toEqual([['Asha', 250_000], ['(none)', 1], ['Ravi', 0]]);
    expect(g[0]!.children!.map((x) => x.key)).toEqual([{ assigneeName: 'Asha', clientName: 'A' }, { assigneeName: 'Asha', clientName: 'B' }]);
    for (const grp of [...g, ...g.flatMap((x) => x.children ?? [])]) {
      const d = ok(drillDefinition(r.def, grp.key)).def as ValidDefinition;
      expect(d.groupBy).toEqual([]);
      const sub = rows.filter((x) => matchesFilters(x, d.resolved, meta));
      expect(aggregate(sub, d.aggregates, meta).sum_suggestedPaise).toBe(grp.values.sum_suggestedPaise);
    }
  });
  it('enum group keys sort in their declared order (ageing buckets)', () => {
    const r = ok({ dataset: 'ageing', groupBy: ['bucket'], aggregates: [{ fn: 'sum', column: 'balancePaise' }] });
    const g = groupRows([{ bucket: 'd90plus', balancePaise: 1 }, { bucket: 'notDue', balancePaise: 2 }, { bucket: 'd0_30', balancePaise: 3 }], r.def, datasetMeta('ageing')!);
    expect(g.map((x) => x.key.bucket)).toEqual(['notDue', 'd0_30', 'd90plus']);
  });
  it('in-memory filters match the SQL semantics (FY range, nin keeps nulls, datetime on IST date)', () => {
    const r = ok({ dataset: 'unbilled', filters: [{ column: 'completedOn', op: 'fy', value: '2025-26' }, { column: 'assigneeName', op: 'nin', value: ['Ravi'] }] });
    expect(rows.filter((x) => matchesFilters(x, r.def.resolved, meta)).map((x) => x.clientName)).toEqual(['A', 'B', 'C']);
    expect(validateDefinition({ dataset: 'tasks', filters: [{ column: 'completedAt', op: 'eq', value: '2026-10-30' }] }, TODAY).ok).toBe(false);
    const d = ok({ dataset: 'tasks', filters: [{ column: 'completedAt', op: 'between', value: ['2026-10-30', '2026-10-30'] }] });
    // 29 Oct 20:00 UTC = 30 Oct 01:30 IST → inside; 30 Oct 19:00 UTC = 31 Oct IST → outside.
    expect(matchesFilters({ completedAt: '2026-10-29T20:00:00.000Z' }, d.def.resolved, datasetMeta('tasks')!)).toBe(true);
    expect(matchesFilters({ completedAt: '2026-10-30T19:00:00.000Z' }, d.def.resolved, datasetMeta('tasks')!)).toBe(false);
  });
  it('sorts stably with nulls last in both directions', () => {
    const s = sortRows([{ v: 2 }, { v: null }, { v: 1 }, { v: 2 }], [{ by: 'v', dir: 'desc' }], (r, k) => (r as Record<string, unknown>)[k]);
    expect(s.map((x) => x.v)).toEqual([2, 2, 1, null]);
  });
});

describe('column access', () => {
  it('cost columns need canSeeCost; PII/fees follow hidden fields (incl. prefix.*)', () => {
    expect([...hiddenColumns(datasetMeta('time_entries')!, { canSeeCost: false, hiddenFields: [] })]).toEqual(['costPaise']);
    expect([...hiddenColumns(datasetMeta('time_entries')!, { canSeeCost: true, hiddenFields: [] })]).toEqual([]);
    expect([...hiddenColumns(datasetMeta('job_pnl')!, { canSeeCost: false, hiddenFields: [] })].sort()).toEqual(['costPaise', 'loss', 'marginPaise', 'marginPct']);
    expect([...hiddenColumns(datasetMeta('clients')!, { canSeeCost: true, hiddenFields: ['client.pan', 'client.fees'] })]).toEqual(['pan']);
    expect([...hiddenColumns(datasetMeta('unbilled')!, { canSeeCost: true, hiddenFields: ['client.*'] })]).toEqual(['suggestedPaise']);
    expect(hiddenColumns(datasetMeta('invoices')!, { canSeeCost: true, hiddenFields: ['invoice.*'] }).has('totalPaise')).toBe(true);
  });
});

describe('schedules (IST) and explanation', () => {
  it('next run is strictly after, in IST wall-clock time; period keys are per day/week/month', () => {
    const w = { frequency: 'weekly' as const, time: '08:00', weekday: 1, dayOfMonth: 1 };
    expect(nextScheduleRun(w, new Date('2026-10-30T10:00:00+05:30')).toISOString()).toBe('2026-11-02T02:30:00.000Z');
    expect(nextScheduleRun(w, new Date('2026-11-02T08:00:00+05:30')).toISOString()).toBe('2026-11-09T02:30:00.000Z');
    expect(nextScheduleRun({ ...w, frequency: 'daily' }, new Date('2026-10-30T07:59:00+05:30')).toISOString()).toBe('2026-10-30T02:30:00.000Z');
    expect(nextScheduleRun({ ...w, frequency: 'monthly', dayOfMonth: 28 }, new Date('2027-02-28T09:00:00+05:30')).toISOString()).toBe('2027-03-28T02:30:00.000Z');
    // 23:30 UTC on 1 Nov is already Monday 2 Nov in IST.
    expect(schedulePeriodKey(w, new Date('2026-11-01T23:30:00Z'))).toBe('W2026-11-02');
    expect(schedulePeriodKey({ ...w, frequency: 'daily' }, new Date('2026-11-01T23:30:00Z'))).toBe('2026-11-02');
    expect(schedulePeriodKey({ ...w, frequency: 'monthly' }, new Date('2026-11-01T23:30:00Z'))).toBe('2026-11');
  });
  it('explains a definition in words', () => {
    const d = reportDefinitionSchema.parse({ dataset: 'unbilled', filters: [{ column: 'serviceCategory', op: 'eq', value: 'GST' }, { column: 'completedOn', op: 'fy', value: '2025-26' }], groupBy: ['assigneeName'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'suggestedPaise' }] });
    expect(explainDefinition(d)).toBe('Unbilled work, where Service category is GST and Completed on is in FY 2025-26, grouped by Assignee (user), showing count, sum of Suggested fee');
  });
});
