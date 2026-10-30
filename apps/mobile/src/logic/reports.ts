import { formatINR, parseFy, type ReportDefinition, type ReportFilter } from '@worko/domain';
import { aiFeatureVisible, type AiAvailability } from './automation';
import { hasGrant, parsePaise } from './billing';

/**
 * Phase 11 on Android (D160–D170): dashboards, catalogue reports, scheduled-report links and NL "Ask". REST-only (D170);
 * the phone caches the last default-dashboard response per user for offline KPIs. Pure helpers — no React Native here.
 */

type Grant = { module: string; action: string; scope: string };
type Obj = Record<string, unknown>;

// ---------- Values ----------
const IST = 330 * 60_000;
/** Today's IST calendar date (yyyy-mm-dd), independent of the device zone. */
export const istToday = (now: number) => new Date(now + IST).toISOString().slice(0, 10);
/** IST wall clock "dd-mm-yyyy HH:MM". */
export function istStamp(ms: number): string {
  const s = new Date(ms + IST).toISOString();
  return `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)} ${s.slice(11, 16)}`;
}

export function formatMinutes(min: number): string {
  const m = Math.round(min); const sign = m < 0 ? '-' : ''; const a = Math.abs(m);
  return `${sign}${Math.floor(a / 60)}h ${String(a % 60).padStart(2, '0')}m`;
}

/** One value for people: paise strings/ints → ₹ (integers only), minutes → h m, numbers grouped en-IN; null → "—". */
export function formatValue(v: unknown, type: string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'paise') return formatINR(parsePaise(v));
  if (type === 'minutes') { const n = Number(v); return Number.isFinite(n) ? formatMinutes(n) : String(v); }
  if (type === 'int' || type === 'number') { const n = Number(v); return Number.isFinite(n) ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n) : String(v); }
  if (type === 'bool') return v === true ? '✓' : '✗';
  if (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return `${v.slice(8, 10)}-${v.slice(5, 7)}-${v.slice(0, 4)}`;
  if (type === 'datetime' && typeof v === 'string') { const ms = Date.parse(v); return Number.isFinite(ms) ? istStamp(ms) : v; }
  if (type === 'enum' && typeof v === 'string') return v.replace(/_/g, ' ');
  return String(v);
}
/** Type of an aggregate alias such as sum_amount_paise / count, given the result columns. */
export function aliasType(alias: string, columns: Array<{ key: string; type: string }>): string {
  if (alias === 'count' || alias.startsWith('count_')) return 'int';
  return columns.find((c) => alias.endsWith(`_${c.key}`))?.type ?? 'number';
}

// ---------- Dashboard data ----------
export type Widget =
  | { id: string; kind: 'kpi'; title: string; error?: undefined; value: unknown; valueKey: string; type: string | null; hiddenColumns: string[]; asOf: string; explanation: string }
  | { id: string; kind: 'chart'; title: string; error?: undefined; chart: string; groups: Group[]; hiddenColumns: string[]; asOf: string; explanation: string }
  | { id: string; kind: 'table'; title: string; error?: undefined; columns: Col[]; rows: Row[]; rowCount: number; hiddenColumns: string[]; asOf: string; explanation: string }
  | { id: string; kind: 'kpi' | 'chart' | 'table'; title: string; error: string };
export type Col = { key: string; label: string; type: string };
export type Row = { values: Obj; refs: Obj };
export type Group = { key: Obj; label: string; values: Record<string, unknown>; children?: Group[] };
export type DashboardData = { dashboard: { id: string | null; name: string | null; origin: string; widgets: Array<{ id: string; catalogueKey?: string; reportId?: string; params?: Obj }> }; widgets: Widget[] };

export function toDashboardData(r: unknown): DashboardData {
  const o = (r ?? {}) as Obj; const d = (o.dashboard ?? {}) as Obj;
  return { dashboard: { id: (d.id as string) ?? null, name: (d.name as string) ?? null, origin: String(d.origin ?? 'none'), widgets: Array.isArray(d.widgets) ? (d.widgets as DashboardData['dashboard']['widgets']) : [] },
    widgets: Array.isArray(o.widgets) ? (o.widgets as Widget[]) : [] };
}
/** Source (catalogue or saved report + params) behind a widget, to open it as a full report. */
export function widgetSource(d: DashboardData, widgetId: string): RunSource | null {
  const w = d.dashboard.widgets.find((x) => x.id === widgetId);
  if (!w) return null;
  if (w.catalogueKey) return { catalogueKey: w.catalogueKey, params: w.params };
  if (w.reportId) return { reportId: w.reportId, params: w.params };
  return null;
}

// ---------- Offline cache (per tenant × user; wiped on logout / remote wipe) ----------
export const DASH_CACHE_VERSION = 1;
export const DASH_STALE_AFTER_MS = 12 * 3600_000;
export type DashCache = { v: number; owner: string; savedAt: number; data: DashboardData };
export const cacheOwner = (tenantId: string, userId: string) => `${tenantId}:${userId}`;
export const cacheFileName = (owner: string) => `dashboard-${owner.replace(/[^\w-]+/g, '_')}.json`;
export const makeDashCache = (owner: string, data: DashboardData, now: number): DashCache => ({ v: DASH_CACHE_VERSION, owner, savedAt: now, data });
/** Usable only for the same tenant + user and the current format. */
export function readDashCache(raw: string | null, owner: string): DashCache | null {
  if (!raw || !owner) return null;
  try {
    const e = JSON.parse(raw) as DashCache;
    return e?.v === DASH_CACHE_VERSION && e.owner === owner && typeof e.savedAt === 'number' && e.data ? e : null;
  } catch { return null; }
}
/** Live wins. Offline or on error the saved copy shows with its "as of" time; banner whenever the copy is shown. */
export function dashView(live: DashboardData | undefined, cached: DashCache | null, now: number): { data: DashboardData | undefined; fromCache: boolean; savedAt: number | null; stale: boolean } {
  if (live) return { data: live, fromCache: false, savedAt: null, stale: false };
  if (cached) return { data: cached.data, fromCache: true, savedAt: cached.savedAt, stale: now - cached.savedAt > DASH_STALE_AFTER_MS };
  return { data: undefined, fromCache: false, savedAt: null, stale: false };
}

// ---------- KPI tiles ----------
export type KpiTile = { id: string; title: string; text: string; note: 'hidden' | 'error' | null; error: string | null };
export function kpiTile(w: Widget): KpiTile {
  if (w.error) return { id: w.id, title: w.title, text: '—', note: 'error', error: w.error };
  if (w.kind !== 'kpi') return { id: w.id, title: w.title, text: '—', note: null, error: null };
  const k = w as Extract<Widget, { kind: 'kpi'; error?: undefined }>;
  const hidden = k.value === null && k.hiddenColumns.length > 0;
  return { id: k.id, title: k.title, text: hidden ? '—' : formatValue(k.value ?? (k.type === 'int' ? 0 : null), k.type), note: hidden ? 'hidden' : null, error: null };
}

// ---------- Chart shaping (single series: bars of one aggregate) ----------
export type Bar = { label: string; value: number; text: string; frac: number; key: Obj | null };
/** Top `max` groups by the chosen value, the rest folded into one "Other" bar (not drillable). Fractions of the largest value; negatives clamp to 0. */
export function chartBars(groups: Group[], valueKey: string, type: string, max = 8, otherLabel = 'Other'): Bar[] {
  const num = (g: Group) => { const v = g.values[valueKey]; return type === 'paise' ? parsePaise(v) : Number(v) || 0; };
  const all = groups.map((g) => ({ label: g.label, value: num(g), key: g.key }));
  let bars = all.slice(0, max);
  if (all.length > max) bars = [...all.slice(0, max - 1), { label: otherLabel, value: all.slice(max - 1).reduce((n, b) => n + b.value, 0), key: null as unknown as Obj }];
  const top = Math.max(0, ...bars.map((b) => b.value));
  return bars.map((b) => ({ label: b.label, value: b.value, text: formatValue(b.value, type), frac: top > 0 ? Math.max(0, b.value) / top : 0, key: b.key ?? null }));
}
/** First aggregate alias present in the groups (the chart's measure). */
export function chartValueKey(groups: Group[], preferred?: string): string | null {
  const keys = Object.keys(groups[0]?.values ?? {});
  return preferred && keys.includes(preferred) ? preferred : keys[0] ?? null;
}

// ---------- Run requests ----------
export type RunSource = { catalogueKey?: string; reportId?: string; definition?: ReportDefinition; params?: Obj };
export function runBody(src: RunSource, opts: { drill?: Obj; page?: number; pageSize?: number } = {}): Obj {
  const b: Obj = {};
  if (src.definition) b.definition = src.definition; else if (src.reportId) b.reportId = src.reportId; else if (src.catalogueKey) b.catalogueKey = src.catalogueKey;
  if (src.params && Object.keys(src.params).length) b.params = src.params;
  if (opts.drill && Object.keys(opts.drill).length) b.drill = opts.drill;
  if (opts.page) b.page = opts.page;
  if (opts.pageSize) b.pageSize = opts.pageSize;
  return b;
}
/** Drill-down = the group's key (all levels) sent as `drill`; null keys stay null (server: is_null) — totals equal the group by construction (D163). */
export const drillKey = (g: Pick<Group, 'key'>): Obj => ({ ...g.key });

// ---------- FY picker (IST) ----------
export function currentFy(today: string): string {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const s = m >= 4 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}
/** Current FY first, then the previous `count - 1`. */
export function fyOptions(today: string, count = 4): string[] {
  const start = Number(currentFy(today).slice(0, 4));
  return Array.from({ length: count }, (_, i) => `${start - i}-${String((start - i + 1) % 100).padStart(2, '0')}`);
}
/** "FY 25-26" for a chip. */
export const fyLabel = (fy: string) => `FY ${fy.slice(2, 4)}-${fy.slice(5, 7)}`;
/** The date column a definition already filters by FY/period (the FY picker's target), if any. */
export function fyColumn(def: ReportDefinition): string | null {
  return def.filters.find((f) => f.op === 'fy' || f.op === 'period')?.column ?? null;
}
/** Replace that column's fy/period filter with `fy` (validated); returns the definition unchanged when there is no FY column or the label is bad. */
export function withFy(def: ReportDefinition, fy: string): ReportDefinition {
  const col = fyColumn(def); const p = parseFy(fy);
  if (!col || !p) return def;
  const filters: ReportFilter[] = [...def.filters.filter((f) => !(f.column === col && (f.op === 'fy' || f.op === 'period'))), { column: col, op: 'fy', value: p.label }];
  return { ...def, filters };
}

// ---------- Entity taps ----------
export type EntityRoute = { name: 'client' | 'task' | 'invoice' | 'notice' | 'lead' | 'dsc' | 'autoRun'; id: string };
const REF_ROUTES: Array<[string, EntityRoute['name']]> = [['task', 'task'], ['invoice', 'invoice'], ['notice', 'notice'], ['lead', 'lead'], ['dsc', 'dsc'], ['automation_run', 'autoRun'], ['client', 'client']];
/** Most specific screen that exists on the phone for a row's refs (row entity before its client); null = not tappable. */
export function routeForRefs(refs: Obj | null | undefined): EntityRoute | null {
  for (const [ref, name] of REF_ROUTES) { const id = refs?.[ref]; if (typeof id === 'string' && id) return { name, id }; }
  return null;
}

// ---------- Scheduled-report links ----------
/** Token from an emailed web link (…/#/reports/download/{token}), an https …/reports/downloads/{token} link, a worko://reports/downloads/{token} deep link or a bare token. */
export function downloadToken(input: string | null | undefined): string | null {
  const s = (input ?? '').trim();
  const m = /(?:^|\/)reports\/downloads?\/([A-Za-z0-9_-]{20,128})(?:[?#].*)?$/.exec(s) ?? /^([A-Za-z0-9_-]{40,128})$/.exec(s);
  return m ? m[1]! : null;
}
/** `report.ready` notification → export id (entity_id) for `GET /reports/exports/{id}/download` (recipient only, re-rendered as the caller). */
export function readyExportId(n: { category?: unknown; entity_type?: unknown; entity_id?: unknown }): string | null {
  return n.category === 'report.ready' && (n.entity_type == null || n.entity_type === 'report_export') && typeof n.entity_id === 'string' && n.entity_id ? n.entity_id : null;
}
export const exportDownloadPath = (id: string) => `/reports/exports/${encodeURIComponent(id)}/download`;
export const tokenDownloadPath = (token: string) => `/reports/downloads/${encodeURIComponent(token)}`;

// ---------- Job P&L (fees may be hidden: null + feesVisible false) ----------
export function pnlMoney(v: unknown, feesVisible: boolean | undefined): { text: string; hidden: boolean } {
  if (feesVisible === false || v === null || v === undefined) return { text: '—', hidden: feesVisible === false };
  return { text: formatValue(v, 'paise'), hidden: false };
}
export const safeFileName = (name: string) => name.replace(/[^\w.-]+/g, '_').slice(0, 100) || 'report';

// ---------- Ask (NL query) ----------
/** Only when the nl_query gate is ok (no budget exhausted) and the user has ai:create + reports:view. */
export function askVisible(av: AiAvailability | null | undefined, grants: Grant[] | undefined): boolean {
  return hasGrant(grants, 'reports', 'view') && aiFeatureVisible(av, 'nl_query', grants);
}
export const ASK_EXAMPLE = 'unbilled GST work FY 25-26 by user';
export const askBody = (q: string) => ({ question: q.trim().slice(0, 500), run: true });
export const defaultSaveName = (q: string) => q.trim().replace(/\s+/g, ' ').slice(0, 80) || 'AI report';

// ---------- Errors ----------
const ERRS = ['column_hidden', 'dataset_forbidden', 'too_many_rows', 'report_timeout', 'invalid_definition', 'link_expired', 'invalid_model_output', 'not_found', 'forbidden',
  'no_ai_mode', 'ai_disabled', 'feature_disabled', 'ai_cap', 'export_forbidden', 'budget_exceeded', 'source_gone'] as const;
export type ReportErr = (typeof ERRS)[number];
/** Known codes get a plain sentence; 404/410/403 without a code map by status; else null (show the service message). */
export function reportError(e: { code?: string; status?: number } | null | undefined): ReportErr | null {
  if (!e) return null;
  if ((ERRS as readonly string[]).includes(String(e.code))) return e.code as ReportErr;
  return e.status === 404 ? 'not_found' : e.status === 410 ? 'link_expired' : e.status === 403 ? 'forbidden' : null;
}
