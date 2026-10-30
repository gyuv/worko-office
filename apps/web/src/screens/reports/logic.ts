import {
  AGG_FNS, aggAlias, columnMeta, datasetMeta, formatCompactINR, formatINR, nextScheduleRun, NUMERIC_TYPES, opsFor, parseFy, periodRange, REPORT_LIMITS, reportDefinitionSchema,
  validateDefinition, type AggFn, type ColumnType, type DatasetMeta, type FilterOp, type ReportDefinition, type ReportFilter, type ReportGroup, type ReportSchedule,
} from '@worko/domain';
import { parseRupees } from '../billing/logic';
import { fmtMinutes } from '../hr/logic';

/**
 * Pure helpers for the Phase 11 report screens (M17/M21): builder state ⇄ definition, FY/period pickers, drill-down keys,
 * chart shaping, hidden-column notices, schedule previews, catalogue grouping and cell formatting. Money stays integer paise
 * until it is formatted here; dates are IST.
 */

// ---------- Builder state ⇄ definition ----------
export type FilterRow = { column: string; op: FilterOp; value: string; value2: string };
export type AggRow = { fn: AggFn; column: string };
export type BuilderState = {
  dataset: string; columns: string[]; filters: FilterRow[]; groupBy: string[]; aggregates: AggRow[];
  sort: Array<{ by: string; dir: 'asc' | 'desc' }>; limit: string; chart: 'table' | 'bar' | 'line' | 'pie' | 'kpi'; params: Record<string, string>;
};
export const emptyBuilder = (dataset = ''): BuilderState => ({ dataset, columns: [], filters: [], groupBy: [], aggregates: [], sort: [], limit: '', chart: 'table', params: {} });

const NO_VALUE: readonly FilterOp[] = ['is_null', 'not_null'];
const LIST: readonly FilterOp[] = ['in', 'nin'];
export const opNeedsValue = (op: FilterOp) => !NO_VALUE.includes(op);
export const opIsList = (op: FilterOp) => LIST.includes(op);

/** Text typed in a filter box → the typed definition value (paise from rupees, minutes from hours:min or minutes, bool, numbers). */
export function parseValue(type: ColumnType, raw: string): string | number | boolean | null {
  const s = raw.trim();
  if (!s) return null;
  switch (type) {
    case 'paise': return parseRupees(s);
    case 'minutes': { const m = /^(\d+):([0-5]\d)$/.exec(s); if (m) return Number(m[1]) * 60 + Number(m[2]); return /^-?\d+$/.test(s) ? Number(s) : null; }
    case 'int': return /^-?\d+$/.test(s) ? Number(s) : null;
    case 'number': { const n = Number(s.replace(/,/g, '')); return Number.isFinite(n) ? n : null; }
    case 'bool': return s === 'true' ? true : s === 'false' ? false : null;
    default: return s;
  }
}
/** Inverse of `parseValue` for editing a stored definition. */
export function formatValue(type: ColumnType, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (type === 'paise' && typeof v === 'number') { const r = v / 100; return Number.isInteger(r) ? String(r) : r.toFixed(2); }
  return String(v);
}

function filterOut(meta: DatasetMeta | undefined, f: FilterRow): ReportFilter {
  const type = (meta && columnMeta(meta, f.column)?.type) ?? 'text';
  if (!opNeedsValue(f.op)) return { column: f.column, op: f.op };
  if (f.op === 'fy' || f.op === 'period') return { column: f.column, op: f.op, value: f.value };
  if (opIsList(f.op)) {
    const vals = f.value.split(',').map((x) => parseValue(type, x)).filter((x): x is string | number => x !== null && typeof x !== 'boolean');
    return { column: f.column, op: f.op, value: vals };
  }
  if (f.op === 'between') {
    const a = parseValue(type, f.value); const b = parseValue(type, f.value2);
    return { column: f.column, op: f.op, value: [a, b].filter((x): x is string | number => x !== null && typeof x !== 'boolean') };
  }
  const v = parseValue(type, f.value);
  return { column: f.column, op: f.op, value: v ?? (type === 'paise' || NUMERIC_TYPES.includes(type) ? f.value : f.value) };
}

/** Builder → definition (pure data; the server re-validates). Empty optional parts are omitted. */
export function toDefinition(s: BuilderState): ReportDefinition {
  const meta = datasetMeta(s.dataset);
  const params: Record<string, string | number> = {};
  for (const p of meta?.params ?? []) {
    const v = s.params[p.key]; if (v === undefined || v === '') continue;
    params[p.key] = p.type === 'int' && /^\d+$/.test(v) ? Number(v) : v;
  }
  const limit = /^\d+$/.test(s.limit) ? Number(s.limit) : undefined;
  const d: ReportDefinition = {
    dataset: s.dataset, columns: s.columns, filters: s.filters.filter((f) => f.column).map((f) => filterOut(meta, f)), groupBy: s.groupBy.slice(0, REPORT_LIMITS.maxGroupBy),
    aggregates: s.aggregates.map((a) => (a.fn === 'count' && !a.column ? { fn: 'count' as const } : { fn: a.fn, column: a.column })), sort: s.sort, params,
    ...(limit ? { limit } : {}), ...(s.chart !== 'table' || s.groupBy.length ? { chart: { type: s.chart } } : {}),
  };
  return d;
}

/** Definition → builder (editing a saved, catalogue or AI-proposed report). */
export function fromDefinition(raw: ReportDefinition): BuilderState {
  const d = reportDefinitionSchema.parse(raw);
  const meta = datasetMeta(d.dataset);
  const type = (k: string) => (meta && columnMeta(meta, k)?.type) ?? 'text';
  return {
    dataset: d.dataset, columns: [...d.columns], groupBy: [...d.groupBy], sort: d.sort.map((x) => ({ by: x.by, dir: x.dir })),
    filters: d.filters.map((f) => {
      const t = type(f.column);
      if (Array.isArray(f.value)) return f.op === 'between' ? { column: f.column, op: f.op, value: formatValue(t, f.value[0]), value2: formatValue(t, f.value[1]) }
        : { column: f.column, op: f.op, value: f.value.map((x) => formatValue(t, x)).join(', '), value2: '' };
      return { column: f.column, op: f.op, value: formatValue(t, f.value), value2: '' };
    }),
    aggregates: d.aggregates.map((a) => ({ fn: a.fn, column: a.column ?? '' })), limit: d.limit ? String(d.limit) : '', chart: d.chart?.type ?? 'table',
    params: Object.fromEntries(Object.entries(d.params).map(([k, v]) => [k, String(v)])),
  };
}

/** Live validation with the shared domain schema (same rules as the server) + builder-only hints. */
export function validateBuilder(s: BuilderState, today: string): { ok: boolean; issues: string[]; definition: ReportDefinition } {
  const definition = toDefinition(s);
  if (!s.dataset) return { ok: false, issues: ['Pick a dataset'], definition };
  const issues: string[] = [];
  s.filters.forEach((f, i) => { if (!f.column) issues.push(`filters.${i}: pick a column`); });
  const v = validateDefinition(definition, today);
  if (!v.ok) issues.push(...v.issues);
  if (s.chart === 'kpi' && !definition.aggregates.length) issues.push('A KPI needs an aggregate');
  return { ok: !issues.length, issues, definition };
}

/** Aggregate functions allowed on a column type (count works on anything). */
export function aggFnsFor(type: ColumnType | undefined): AggFn[] {
  if (!type) return ['count'];
  if (NUMERIC_TYPES.includes(type)) return [...AGG_FNS];
  if (type === 'date') return ['count', 'min', 'max'];
  return ['count'];
}
/** Sort targets: dataset columns + aggregate aliases. */
export function sortTargets(s: BuilderState, meta: DatasetMeta | undefined): Array<{ key: string; label: string }> {
  if (!meta) return [];
  const aggs = s.aggregates.map((a) => ({ key: aggAlias(a.column ? { fn: a.fn, column: a.column } : { fn: a.fn }), label: aggLabel(meta, a.fn, a.column) }));
  return [...meta.columns.map((c) => ({ key: c.key, label: c.label })), ...aggs];
}
export const aggLabel = (meta: DatasetMeta | undefined, fn: AggFn, column?: string) =>
  fn === 'count' && !column ? 'Count' : `${fn[0]!.toUpperCase()}${fn.slice(1)} of ${(meta && column && columnMeta(meta, column)?.label) || column}`;
export { opsFor };

// ---------- FY / period pickers (IST) ----------
/** FY labels for the picker: next FY, this FY and the previous `back` years (Indian FY, IST today). */
export function fyOptions(today: string, back = 4): string[] {
  const y = Number(today.slice(0, 4)); const m = Number(today.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  const out: string[] = [];
  for (let s = start + 1; s >= start - back; s--) out.push(`${s}-${String((s + 1) % 100).padStart(2, '0')}`);
  return out;
}
/** A picker choice → the definition filter; `month:YYYY-MM` and named periods use op `period`, FY labels op `fy`. */
export function periodFilter(column: string, choice: { kind: 'fy'; fy: string } | { kind: 'period'; period: string } | { kind: 'month'; month: string }): ReportFilter | null {
  if (choice.kind === 'fy') { const f = parseFy(choice.fy); return f ? { column, op: 'fy', value: f.label } : null; }
  if (choice.kind === 'month') return /^\d{4}-(0[1-9]|1[0-2])$/.test(choice.month) ? { column, op: 'period', value: `month:${choice.month}` } : null;
  return { column, op: 'period', value: choice.period };
}
/** The inclusive IST date range a fy/period filter value resolves to (for the "= 1 Apr 2025 – 31 Mar 2026" preview). */
export function filterRange(op: FilterOp, value: string, today: string): { from: string; to: string } | null {
  if (op === 'fy') { const f = parseFy(value); return f && { from: f.from, to: f.to }; }
  if (op === 'period') return periodRange(value, today);
  return null;
}

// ---------- Run results ----------
export type ResultColumn = { key: string; label: string; type: ColumnType };
export type RunResult = {
  dataset: { key: string; label: string; module: string };
  definition: Omit<ReportDefinition, 'aggregates'> & { aggregates: Array<{ fn: AggFn; column?: string; as: string }> }; explanation: string;
  columns: ResultColumn[]; hiddenColumns: string[]; params: Record<string, string | number>; asOf: string;
  rows: Array<{ values: Record<string, unknown>; refs: Partial<Record<string, string>> }>; rowCount: number; page: number; pageSize: number;
  totals: Record<string, number | string | null>; groups: ReportGroup[]; groupsTruncated: boolean; chart: { type: string; x?: string; y?: string } | null;
  name?: string; reportId?: string | null; catalogueKey?: string | null;
};

/** Type of an aggregate alias in a result (sum_x keeps x's type; count → int; avg of number → number). */
export function aliasType(r: Pick<RunResult, 'definition' | 'columns'>, alias: string): ColumnType {
  const a = r.definition.aggregates.find((x) => x.as === alias);
  if (!a || a.fn === 'count') return 'int';
  const meta = datasetMeta(r.definition.dataset);
  return (meta && a.column && columnMeta(meta, a.column)?.type) || r.columns.find((c) => c.key === a.column)?.type || 'number';
}
export function aliasLabel(r: Pick<RunResult, 'definition'>, alias: string): string {
  const a = r.definition.aggregates.find((x) => x.as === alias);
  const meta = datasetMeta(r.definition.dataset);
  if (!a) return (meta && columnMeta(meta, alias)?.label) ?? alias;
  return aggLabel(meta, a.fn, a.column);
}

/** Breadcrumb trail for drill-down: each crumb is a group's FULL key (parent keys included, as the engine nests them). */
export type Crumb = { key: Record<string, unknown>; label: string };
/** Clicking a group: one with children opens them; a leaf group asks the server for its underlying rows. */
export function drillStep(g: ReportGroup): { kind: 'children'; crumb: Crumb } | { kind: 'rows'; crumb: Crumb; drill: Record<string, string | number | boolean | null> } {
  const crumb = { key: g.key, label: g.label };
  if (g.children?.length) return { kind: 'children', crumb };
  return { kind: 'rows', crumb, drill: drillKey(g.key) };
}
/** Group key → the `drill` request body (null keys stay null = "is empty"). */
export function drillKey(key: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(key)) out[k] = v === undefined ? null : (v as string | number | boolean | null);
  return out;
}
/** Groups shown at the current breadcrumb depth. */
export function groupsAt(groups: ReportGroup[], trail: Crumb[]): ReportGroup[] {
  let level = groups;
  for (const c of trail) {
    const g = level.find((x) => JSON.stringify(x.key) === JSON.stringify(c.key));
    if (!g?.children) return [];
    level = g.children;
  }
  return level;
}

/** Chart data from a run: one series (top-level groups, or rows with chart x/y), values left as integers (paise/minutes). */
export type ChartPoint = { label: string; value: number; group?: ReportGroup };
export type ChartData = { type: 'bar' | 'line' | 'pie'; xLabel: string; yKey: string; yLabel: string; yType: ColumnType; points: ChartPoint[]; total: number };
export function chartData(r: RunResult, hint?: string | null): ChartData | null {
  const type = (hint ?? r.chart?.type ?? 'bar') as string;
  if (type !== 'bar' && type !== 'line' && type !== 'pie') return null;
  const meta = datasetMeta(r.definition.dataset);
  let points: ChartPoint[] = []; let yKey = ''; let xKey = '';
  if (r.groups.length) {
    xKey = r.definition.groupBy[0] ?? '';
    const aliases = r.definition.aggregates.map((a) => a.as);
    yKey = r.chart?.y && aliases.includes(r.chart.y) ? r.chart.y : aliases.find((a) => a !== 'count') ?? aliases[0] ?? 'count';
    points = r.groups.map((g) => ({ label: g.label, value: Number(g.values[yKey] ?? 0) || 0, group: g }));
  } else {
    const isCol = (k?: string) => !!k && r.columns.some((c) => c.key === k);
    xKey = (isCol(r.chart?.x) ? r.chart!.x : r.columns.find((c) => c.type === 'text' || c.type === 'date')?.key) ?? '';
    yKey = (isCol(r.chart?.y) ? r.chart!.y : r.columns.find((c) => NUMERIC_TYPES.includes(c.type))?.key) ?? '';
    if (!xKey || !yKey) return null;
    points = r.rows.map((x) => ({ label: x.values[xKey] === null || x.values[xKey] === undefined ? '(none)' : String(x.values[xKey]), value: Number(x.values[yKey] ?? 0) || 0 }));
  }
  if (!points.length) return null;
  const yType = r.groups.length ? aliasType(r, yKey) : r.columns.find((c) => c.key === yKey)?.type ?? 'number';
  const xLabel = (meta && columnMeta(meta, xKey)?.label) ?? xKey;
  // Line charts read in x order (months/weeks); bars/shares by value is the server's sort already.
  return { type, xLabel, yKey, yLabel: aliasLabel(r, yKey), yType, points, total: points.reduce((s, p) => s + p.value, 0) };
}
/** Pie hint → share-of-total bars (one hue; no categorical palette needed): sorted desc, small slices folded into "Other" after `max`. */
export function shares(points: ChartPoint[], max = 7): Array<ChartPoint & { pct: number }> {
  const total = points.reduce((s, p) => s + Math.max(0, p.value), 0) || 1;
  const sorted = [...points].sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, max); const tail = sorted.slice(max);
  const out = head.map((p) => ({ ...p, pct: Math.round((Math.max(0, p.value) / total) * 1000) / 10 }));
  if (tail.length) { const v = tail.reduce((s, p) => s + p.value, 0); out.push({ label: `Other (${tail.length})`, value: v, pct: Math.round((Math.max(0, v) / total) * 1000) / 10 }); }
  return out;
}
/** "Nice" axis maximum and ticks (0 baseline). */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count; const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

// ---------- Formatting ----------
const istDateFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const istDateTimeFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
export const fmtIstDate = (iso: string) => istDateFmt.format(new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso));
export const fmtIstDateTime = (d: Date | string) => istDateTimeFmt.format(new Date(d));
/** One cell, by column type: paise → ₹ (Indian grouping), minutes → h:mm, dates in IST. */
export function formatCell(v: unknown, type: ColumnType): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (type) {
    case 'paise': return typeof v === 'number' ? formatINR(v) : String(v);
    case 'minutes': return typeof v === 'number' ? fmtMinutes(v) : String(v);
    case 'date': return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtIstDate(v) : String(v);
    case 'datetime': return typeof v === 'string' ? fmtIstDateTime(v) : String(v);
    case 'bool': return v === true ? 'Yes' : v === false ? 'No' : String(v);
    case 'int': case 'number': return typeof v === 'number' ? new Intl.NumberFormat('en-IN').format(v) : String(v);
    case 'enum': return String(v).replace(/_/g, ' ');
    default: return String(v);
  }
}
/** Compact axis labels (₹1.2 L, 12h). */
export function formatAxis(v: number, type: ColumnType): string {
  if (type === 'paise') return formatCompactINR(v);
  if (type === 'minutes') return `${Math.round(v / 60)}h`;
  return new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

/** Where an entity ref opens in the web app (null = no screen for it). */
export function refHref(type: string, id: string): string | null {
  switch (type) {
    case 'client': return `#/clients/${id}`;
    case 'task': return `#/tasks/${id}`;
    case 'invoice': return `#/billing/${id}`;
    case 'receipt': return '#/receipts';
    case 'notice': return `#/notices/${id}`;
    case 'lead': return `#/leads/${id}`;
    case 'proposal': return `#/leads/p/${id}`;
    case 'automation_rule': return `#/automation/rules/${id}`;
    case 'automation_run': return `#/automation/runs/${id}`;
    case 'dsc': return '#/dsc';
    case 'licence': return '#/licences';
    case 'leave_request': return '#/leave';
    case 'expense_claim': return '#/expenses';
    case 'time_entry': return '#/time';
    default: return null;
  }
}
/** The ref a cell links to: the row's own entity on its label-ish column, or a `xxxName` column next to `xxxId`. */
export function cellRef(colKey: string, row: { refs: Partial<Record<string, string>> }, meta: DatasetMeta | undefined): { type: string; id: string } | null {
  if (!meta) return null;
  const idCol = colKey.endsWith('Name') ? `${colKey.slice(0, -4)}Id` : colKey.endsWith('Title') ? `${colKey.slice(0, -5)}Id` : null;
  const ref = idCol ? columnMeta(meta, idCol)?.ref : undefined;
  if (ref && row.refs[ref]) return { type: ref, id: row.refs[ref]! };
  const own = meta.entity;
  if (own && row.refs[own] && ['title', 'name', 'number', 'label', 'holderName'].includes(colKey)) return { type: own, id: row.refs[own]! };
  return null;
}

// ---------- Hidden columns ----------
/** Labels of columns dropped for this viewer (cost/PII/fees/amounts) — the result simply lacks them. */
export function hiddenLabels(datasetKey: string, hidden: string[]): string[] {
  const meta = datasetMeta(datasetKey);
  return hidden.map((k) => (meta && columnMeta(meta, k)?.label) ?? k);
}
/** Builder: columns flagged hidden by GET /reports/datasets for this viewer. */
export function isSensitive(c: { sensitivity?: string | null }) { return !!c.sensitivity; }
/** Error body → plain reason (403 column_hidden names the columns). */
export function reportError(e: unknown): { code: string | null; columns: string[]; issues: string[]; message: string; status: number | null } {
  const x = e as { code?: string; message?: string; status?: number; body?: { columns?: string[]; issues?: unknown[]; code?: string } };
  const issues = (x.body?.issues ?? []).map((i) => (typeof i === 'string' ? i : (i as { message?: string }).message ?? '')).filter(Boolean);
  return { code: x.code ?? x.body?.code ?? null, columns: x.body?.columns ?? [], issues, message: x.message ?? '', status: x.status ?? null };
}

// ---------- Catalogue ----------
export type CatalogueItem = { key: string; name: string; description: string; dataset: string; definition: ReportDefinition; explanation: string };
/** Report "areas" by source module, in a fixed order. */
export const AREA_ORDER = ['billing', 'receipts', 'reports', 'time', 'tasks', 'compliance', 'notices', 'leads', 'hr', 'dsc', 'clients', 'automation', 'ai'] as const;
export function areaOf(datasetKey: string): string { return datasetMeta(datasetKey)?.module ?? 'other'; }
export function groupCatalogue<T extends { name: string; description: string; dataset: string }>(items: T[], q: string): Array<{ area: string; items: T[] }> {
  const s = q.trim().toLowerCase();
  const hit = items.filter((i) => !s || i.name.toLowerCase().includes(s) || i.description.toLowerCase().includes(s) || (datasetMeta(i.dataset)?.label ?? '').toLowerCase().includes(s));
  const by = new Map<string, T[]>();
  for (const i of hit) { const a = areaOf(i.dataset); by.set(a, [...(by.get(a) ?? []), i]); }
  const rank = (a: string) => { const i = (AREA_ORDER as readonly string[]).indexOf(a); return i < 0 ? 99 : i; };
  return [...by.entries()].sort(([a], [b]) => rank(a) - rank(b)).map(([area, xs]) => ({ area, items: xs }));
}

// ---------- Schedules ----------
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
/** "Weekly on Monday at 08:00 IST" + next run (IST) for the schedule editor and list. */
export function schedulePreview(s: ReportSchedule, now: Date): { text: string; next: Date; nextText: string } {
  const at = `${s.time} IST`;
  const text = s.frequency === 'daily' ? `Daily at ${at}` : s.frequency === 'weekly' ? `Weekly on ${WEEKDAYS[s.weekday - 1]} at ${at}` : `Monthly on day ${s.dayOfMonth} at ${at}`;
  const next = nextScheduleRun(s, now);
  return { text, next, nextText: `${fmtIstDateTime(next)} IST` };
}

// ---------- Dashboard widgets ----------
/** Type of an aggregate alias from its name alone (saved-report widgets): sum_xxxPaise → paise, …Minutes → minutes. */
export function aliasTypeGuess(alias: string): ColumnType {
  if (alias === 'count') return 'int';
  if (/Paise$/.test(alias)) return 'paise';
  if (/Minutes$|^(sum|avg|min|max)_minutes$/.test(alias)) return 'minutes';
  return 'number';
}
/** Chart widget → one series over its top-level groups (first non-count aggregate, else count). */
export function widgetChartData(w: { chart?: string; groups?: ReportGroup[]; title: string }): ChartData | null {
  const groups = w.groups ?? [];
  if (!groups.length) return null;
  const keys = Object.keys(groups[0]!.values);
  const yKey = keys.find((k) => k !== 'count') ?? keys[0] ?? 'count';
  const type = w.chart === 'line' || w.chart === 'pie' ? w.chart : 'bar';
  const points = groups.map((g) => ({ label: g.label, value: Number(g.values[yKey] ?? 0) || 0, group: g }));
  return { type, xLabel: '', yKey, yLabel: w.title, yType: aliasTypeGuess(yKey), points, total: points.reduce((s, p) => s + p.value, 0) };
}
/** Where a widget's full report opens. */
export function widgetSourceRoute(w: { reportId?: string; catalogueKey?: string }): string | null {
  return w.reportId ? `reports/saved/${w.reportId}` : w.catalogueKey ? `reports/run/${w.catalogueKey}` : null;
}

/** Download errors (by token or by export id) → message key: 410 link_expired / source_gone, 403 export/dataset_forbidden, 404 not yours. */
export function exportDownloadError(e: unknown): 'p11.dl.expired' | 'p11.dl.sourceGone' | 'p11.dl.forbidden' | 'p11.dl.notYours' | 'common.error' {
  const x = e as { status?: number; code?: string };
  if (x.code === 'source_gone') return 'p11.dl.sourceGone';
  if (x.status === 410) return 'p11.dl.expired';
  if (x.status === 403) return 'p11.dl.forbidden';
  if (x.status === 404) return 'p11.dl.notYours';
  return 'common.error';
}

/** Shared reports: non-owners get secret filter values (e.g. client ids outside their scope) as the literal "[hidden]" — shown as-is, never re-sent. */
export const HIDDEN_VALUE = '[hidden]';
export function hasHiddenValues(d: { filters: Array<{ value?: unknown }> }): boolean {
  return d.filters.some((f) => f.value === HIDDEN_VALUE || (Array.isArray(f.value) && f.value.includes(HIDDEN_VALUE)));
}
