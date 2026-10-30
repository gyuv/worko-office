import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { datasetMeta, sortRows, type ParamSpec, type ReportGroup } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import { ArrowDown, ArrowUp, BarChart3, ChevronRight, Download, EyeOff, Table2 } from 'lucide-react';
import { useState } from 'react';
import { Field } from '../../components/Dialog';
import { saveBlob, todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { exportReport, runReport, type Source } from './api';
import { Chart } from './Chart';
import {
  aliasLabel, aliasType, cellRef, chartData, drillStep, filterRange, fmtIstDate, formatCell, fyOptions, groupsAt, hiddenLabels, refHref, reportError,
  type Crumb, type RunResult,
} from './logic';

/** Error → plain sentence (column_hidden names the columns; validation issues are listed). */
export function useReportError() {
  const t = useT();
  return (e: unknown, datasetKey?: string) => {
    const r = reportError(e);
    if (r.code === 'column_hidden') return t('p11.err.column_hidden', { columns: hiddenLabels(datasetKey ?? '', r.columns).join(', ') });
    if (r.code) { const k = `p11.err.${r.code}` as MessageKey; const s = t(k); if (s !== k) return r.issues.length ? `${s}: ${r.issues.join('; ')}` : s; }
    if (r.status === 403) return t('p11.err.forbidden');
    return r.message || t('common.error');
  };
}

/** Dataset parameters (IST dates/months, ints, enums) with an FY shortcut for from/to pairs. */
export function ParamsBar({ specs, values, onChange }: { specs: ParamSpec[]; values: Record<string, string | number>; onChange(v: Record<string, string | number>): void }) {
  const t = useT();
  if (!specs.length) return null;
  const today = todayIst();
  const hasRange = specs.some((p) => p.key === 'from' && p.type === 'date') && specs.some((p) => p.key === 'to' && p.type === 'date');
  const set = (k: string, v: string | number) => onChange({ ...values, [k]: v });
  return (
    <div className="card flex flex-wrap items-end gap-2 p-3" data-testid="report-params">
      {hasRange && <Field label={t('p11.param.fy')}><select className="input" value="" onChange={(e) => { const r = filterRange('fy', e.target.value, today); if (r) onChange({ ...values, from: r.from, to: r.to > today ? today : r.to }); }}>
        <option value="">{t('p11.param.pickFy')}</option>{fyOptions(today).map((f) => <option key={f} value={f}>FY {f}</option>)}</select></Field>}
      {specs.map((p) => {
        const v = values[p.key] ?? '';
        return (
          <Field key={p.key} label={p.description}>
            {p.type === 'enum' ? <select className="input" value={String(v)} onChange={(e) => set(p.key, e.target.value)}>{(p.values ?? []).map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}</select>
              : p.type === 'int' ? <input className="input w-24" type="number" min={p.min} max={p.max} value={String(v)} onChange={(e) => set(p.key, Number(e.target.value))} />
                : <input className="input" type={p.type === 'month' ? 'month' : 'date'} value={String(v)} onChange={(e) => e.target.value && set(p.key, e.target.value)} />}
          </Field>
        );
      })}
    </div>
  );
}

export function HiddenNotice({ dataset, hidden }: { dataset: string; hidden: string[] }) {
  const t = useT();
  if (!hidden.length) return null;
  return <p className="flex items-center gap-1.5 text-xs text-muted" data-testid="hidden-notice"><EyeOff size={12} aria-hidden />{t('p11.hidden', { columns: hiddenLabels(dataset, hidden).join(', ') })}</p>;
}

/** CSV/XLSX/PDF of the whole run (reports:export; sensitive columns also need the source module's export — server says 403 export_forbidden). */
export function ExportButtons({ source, params }: { source: Source; params?: Record<string, string | number> }) {
  const can = useCan();
  const err = useReportError();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!can('reports', 'export')) return null;
  const go = async (format: 'csv' | 'xlsx' | 'pdf') => {
    setBusy(format); setError(null);
    try { const f = await exportReport({ ...source, params, format }); saveBlob(f.blob, f.filename ?? `report.${format}`); } catch (e) { setError(err(e)); } finally { setBusy(null); }
  };
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="export-buttons">
      {(['csv', 'xlsx', 'pdf'] as const).map((f) => <button key={f} type="button" className="btn" disabled={!!busy} onClick={() => void go(f)}><Download size={12} aria-hidden />{f.toUpperCase()}</button>)}
      {error && <span role="alert" className="text-xs text-overdue">{error}</span>}
    </div>
  );
}

/** Runs a source as the viewer and shows totals, chart/table toggle, grouped table with drill-down + breadcrumbs, and rows with entity links. */
export function ReportResult({ source, initialParams, showParams = true, title, initialTrail = [], initialDrill = null }: { source: Source; initialParams?: Record<string, string | number>; showParams?: boolean; title?: string;
  initialTrail?: Crumb[]; initialDrill?: Record<string, string | number | boolean | null> | null }) {
  const t = useT();
  const err = useReportError();
  const [params, setParams] = useState<Record<string, string | number> | undefined>(initialParams);
  const [trail, setTrail] = useState<Crumb[]>(initialTrail);
  const [drill, setDrill] = useState<Record<string, string | number | boolean | null> | null>(initialDrill);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['reports', 'run', source, params ?? null, drill, page], placeholderData: keepPreviousData, retry: false,
    queryFn: () => runReport({ ...source, ...(params ? { params } : {}), ...(drill ? { drill } : {}), page, pageSize: 100 }) });
  const r = q.data;
  const dsKey = r?.dataset.key ?? source.definition?.dataset ?? '';
  const meta = datasetMeta(dsKey);
  const select = (g: ReportGroup) => {
    const s = drillStep(g);
    setTrail([...trail, s.crumb]); setPage(1);
    if (s.kind === 'rows') setDrill(s.drill);
  };
  const crumbTo = (n: number) => { setTrail(trail.slice(0, n)); setDrill(null); setPage(1); };
  const grouped = !!r && !drill && r.groups.length > 0;
  const groups = r && grouped ? groupsAt(r.groups, trail) : [];
  const cd = r && grouped && trail.length === 0 ? chartData(r) : null;
  return (
    <div className="space-y-2" data-testid="report-result">
      {showParams && meta?.params?.length ? <ParamsBar specs={meta.params} values={params ?? r?.params ?? {}} onChange={(v) => { setParams(v); setTrail([]); setDrill(null); setPage(1); }} /> : null}
      {q.isError && <p role="alert" className="card p-3 text-overdue" data-testid="report-error">{err(q.error, dsKey)}</p>}
      {!r && q.isLoading && <p className="text-muted">{t('common.loading')}</p>}
      {r && <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted" data-testid="report-explanation">{r.explanation} · {t('p11.asOf', { date: fmtIstDate(r.asOf) })}</p>
          <div className="flex flex-wrap items-center gap-2">
            {cd && <div className="flex" role="group" aria-label={t('p11.view')}>
              <button type="button" className={`btn rounded-r-none ${view === 'chart' ? 'bg-surface-alt' : ''}`} aria-pressed={view === 'chart'} onClick={() => setView('chart')}><BarChart3 size={12} aria-hidden />{t('p11.chart')}</button>
              <button type="button" className={`btn rounded-l-none ${view === 'table' ? 'bg-surface-alt' : ''}`} aria-pressed={view === 'table'} onClick={() => setView('table')}><Table2 size={12} aria-hidden />{t('p11.table')}</button></div>}
            <ExportButtons source={source} params={params} />
          </div>
        </div>
        <HiddenNotice dataset={dsKey} hidden={r.hiddenColumns} />
        <Totals r={r} />
        {(trail.length > 0) && <nav aria-label={t('p11.breadcrumbs')} className="flex flex-wrap items-center gap-1 text-sm" data-testid="breadcrumbs">
          <button type="button" className="underline" onClick={() => crumbTo(0)}>{title ?? r.name ?? t('p11.all')}</button>
          {trail.map((c, i) => <span key={i} className="flex items-center gap-1"><ChevronRight size={12} aria-hidden />
            {i === trail.length - 1 ? <span aria-current="page">{c.label}</span> : <button type="button" className="underline" onClick={() => crumbTo(i + 1)}>{c.label}</button>}</span>)}
        </nav>}
        {cd && view === 'chart' && <div className="card p-3"><Chart data={cd} onSelect={select} label={`${cd.yLabel} — ${cd.xLabel}`} /></div>}
        {grouped ? ((view === 'table' || !cd || trail.length > 0) && <GroupTable r={r} groups={groups} onSelect={select} />) : <RowsTable r={r} page={page} onPage={setPage} />}
        {r.groupsTruncated && <p className="text-xs text-muted">{t('p11.groupsTruncated')}</p>}
      </>}
    </div>
  );
}

function Totals({ r }: { r: RunResult }) {
  const aggs = r.definition.aggregates;
  if (!aggs.length) return <p className="text-sm text-muted" data-testid="report-count">{r.rowCount} rows</p>;
  return (
    <dl className="flex flex-wrap gap-2" data-testid="report-totals">
      {aggs.map((a) => <div key={a.as} className="card px-3 py-2"><dt className="text-xs text-muted">{aliasLabel(r, a.as)}</dt>
        <dd className="text-lg font-semibold tabular-nums" data-testid={`total-${a.as}`}>{formatCell(r.totals[a.as], aliasType(r, a.as))}</dd></div>)}
    </dl>
  );
}

type SortState = { by: string; dir: 'asc' | 'desc' } | null;
function SortTh({ k, label, sort, onSort, right }: { k: string; label: string; sort: SortState; onSort(s: SortState): void; right?: boolean }) {
  const active = sort?.by === k;
  return (
    <th className={right ? 'text-right' : ''} aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-0.5 uppercase" onClick={() => onSort(active && sort!.dir === 'asc' ? { by: k, dir: 'desc' } : active ? null : { by: k, dir: 'asc' })}>
        {label}{active && (sort!.dir === 'asc' ? <ArrowUp size={10} aria-hidden /> : <ArrowDown size={10} aria-hidden />)}</button>
    </th>
  );
}
const numeric = (type: string) => ['int', 'paise', 'minutes', 'number'].includes(type);

function GroupTable({ r, groups, onSelect }: { r: RunResult; groups: ReportGroup[]; onSelect(g: ReportGroup): void }) {
  const t = useT();
  const [sort, setSort] = useState<SortState>(null);
  const meta = datasetMeta(r.dataset.key);
  const level = Object.keys(groups[0]?.key ?? {}).length - 1;
  const gk = r.definition.groupBy[Math.max(0, level)] ?? '';
  const aggs = r.definition.aggregates;
  const sorted = sort ? sortRows(groups, [sort], (g, k) => (k === gk ? g.label : g.values[k])) : groups;
  return (
    <div className="card overflow-auto"><table className="table w-full" aria-label={t('p11.groups')} data-testid="group-table">
      <thead><tr><SortTh k={gk} label={(meta && meta.columns.find((c) => c.key === gk)?.label) ?? gk} sort={sort} onSort={setSort} />
        {aggs.map((a) => <SortTh key={a.as} k={a.as} label={aliasLabel(r, a.as)} sort={sort} onSort={setSort} right />)}</tr></thead>
      <tbody>
        {!sorted.length && <tr><td colSpan={aggs.length + 1} className="text-muted">{t('p11.empty')}</td></tr>}
        {sorted.map((g) => (
          <tr key={JSON.stringify(g.key)}>
            <td><button type="button" className="underline" onClick={() => onSelect(g)} title={t('p11.drill')}>{g.label}</button></td>
            {aggs.map((a) => <td key={a.as} className="text-right tabular-nums">{formatCell(g.values[a.as], aliasType(r, a.as))}</td>)}
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

function RowsTable({ r, page, onPage }: { r: RunResult; page: number; onPage(p: number): void }) {
  const t = useT();
  const [sort, setSort] = useState<SortState>(null);
  const meta = datasetMeta(r.dataset.key);
  const rows = sort ? sortRows(r.rows, [sort], (x, k) => x.values[k]) : r.rows;
  const pages = Math.max(1, Math.ceil(r.rowCount / r.pageSize));
  return (
    <div className="space-y-1">
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p11.rows')} data-testid="rows-table">
        <thead><tr>{r.columns.map((c) => <SortTh key={c.key} k={c.key} label={c.label} sort={sort} onSort={setSort} right={numeric(c.type)} />)}</tr></thead>
        <tbody>
          {!rows.length && <tr><td colSpan={r.columns.length || 1} className="text-muted">{t('p11.empty')}</td></tr>}
          {rows.map((row, i) => (
            <tr key={i}>{r.columns.map((c) => {
              const ref = cellRef(c.key, row, meta);
              const href = ref && refHref(ref.type, ref.id);
              const text = formatCell(row.values[c.key], c.type);
              return <td key={c.key} className={numeric(c.type) ? 'text-right tabular-nums' : ''}>{href ? <a className="underline" href={href}>{text}</a> : text}</td>;
            })}</tr>
          ))}
        </tbody>
      </table></div>
      {pages > 1 && <div className="flex items-center gap-2 text-sm">
        <button type="button" className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>{t('p6.prev')}</button>
        <span className="text-muted">{t('p11.page', { page, pages, rows: r.rowCount })}</span>
        <button type="button" className="btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>{t('p6.next')}</button></div>}
    </div>
  );
}
