import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHART_TYPES, PERIODS, REPORT_LIMITS, type FilterOp, type ReportDefinition } from '@worko/domain';
import { History, Lock, Plus, Share2, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { useUsers } from '../tasks/shared';
import { as, asFull, body, useDatasets, type Dataset, type SavedReport, type SavedVersion, type Share } from './api';
import { useFirmPublisher } from './Dashboard';
import {
  aggFnsFor, aggLabel, hasHiddenValues, emptyBuilder, filterRange, fmtIstDate, fmtIstDateTime, fromDefinition, fyOptions, opIsList, opNeedsValue, sortTargets, validateBuilder, type BuilderState,
} from './logic';
import { ReportResult, useReportError } from './ResultView';
import { datasetMeta } from '@worko/domain';

/** Loads a saved report into the builder (`#/reports/builder/<id>`). */
export function BuilderLoader({ id }: { id: string }) {
  const t = useT();
  const err = useReportError();
  const q = useQuery({ queryKey: ['reports', 'saved', id], retry: false, queryFn: () => asFull<SavedReport>(api.GET('/reports/saved/{id}', { params: { path: { id } } })) });
  if (q.isError) return <p role="alert" className="card p-4 text-overdue">{err(q.error)}</p>;
  if (!q.data) return <p className="text-muted">{t('common.loading')}</p>;
  return <ReportBuilder key={`${id}:${q.data.version}`} saved={q.data} />;
}

const SENS_KEY = { cost: 'p11.sens.cost', pii: 'p11.sens.pii', fees: 'p11.sens.fees', invoice: 'p11.sens.invoice' } as const;

export function ReportBuilder({ saved, initial }: { saved?: SavedReport; initial?: ReportDefinition }) {
  const t = useT();
  const can = useCan();
  const err = useReportError();
  const qc = useQueryClient();
  const go = useRoute((s) => s.go);
  const ds = useDatasets();
  const today = todayIst();
  const [s, setS] = useState<BuilderState>(() => (saved ? fromDefinition(saved.definition) : initial ? fromDefinition(initial) : emptyBuilder()));
  const [name, setName] = useState(saved?.name ?? '');
  const [description, setDescription] = useState(saved?.description ?? '');
  const [preview, setPreview] = useState<ReportDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [versions, setVersions] = useState(false);
  const dataset: Dataset | undefined = ds.data?.find((d) => d.key === s.dataset);
  const meta = datasetMeta(s.dataset);
  const v = useMemo(() => validateBuilder(s, today), [s, today]);
  // A shared report's secret filter values arrive as "[hidden]": show them, but never preview/save them back (the server applies the real values).
  const masked = hasHiddenValues(v.definition);
  const up = (p: Partial<BuilderState>) => { setS({ ...s, ...p }); setPreview(null); };
  const visibleCols = dataset?.columns ?? [];
  const usable = visibleCols.filter((c) => !c.hidden);
  const colType = (k: string) => visibleCols.find((c) => c.key === k)?.type;

  const save = useMutation({
    mutationFn: async () => {
      if (saved) return asFull<SavedReport>(api.PUT('/reports/saved/{id}', { params: { path: { id: saved.id } }, body: body({ name: name.trim(), description: description.trim() || null, definition: v.definition }) }));
      return asFull<SavedReport>(api.POST('/reports/saved', { body: body({ name: name.trim(), description: description.trim() || null, definition: v.definition }) }));
    },
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['reports', 'saved'] }); toast({ text: t('p11.b.saved'), tone: 'ok' }); if (!saved) go(`reports/builder/${r.id}`); },
    onError: (e) => setError(err(e, s.dataset)),
  });

  if (!can('reports', 'view')) return <p className="card p-6 text-muted">{t('p11.noAccess')}</p>;
  return (
    <div className="space-y-3" data-testid="report-builder">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{saved ? t('p11.b.editTitle', { name: saved.name }) : t('p11.b.newTitle')}</h2>
        {saved && <div className="flex gap-2">
          <button type="button" className="btn" onClick={() => setVersions(true)}><History size={12} aria-hidden />{t('p11.b.versions', { n: saved.currentVersion })}</button>
          {saved.canEdit && <button type="button" className="btn" onClick={() => setSharing(true)}><Share2 size={12} aria-hidden />{t('p11.b.share')}</button>}
        </div>}
      </div>

      <section className="card space-y-2 p-3" aria-labelledby="b-ds">
        <h3 id="b-ds" className="text-sm font-semibold">1. {t('p11.b.dataset')}</h3>
        <Field label={t('p11.b.dataset')}><select className="input" value={s.dataset} onChange={(e) => { setS(emptyBuilder(e.target.value)); setPreview(null); }}>
          <option value="">{t('p11.b.pickDataset')}</option>{(ds.data ?? []).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></Field>
        {dataset && <p className="text-xs text-muted">{dataset.description}</p>}
      </section>

      {dataset && <>
        <section className="card space-y-2 p-3" aria-labelledby="b-cols">
          <h3 id="b-cols" className="text-sm font-semibold">2. {t('p11.b.columns')}</h3>
          <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {visibleCols.map((c) => (
              <li key={c.key}><label className={`flex items-center gap-2 text-sm ${c.hidden ? 'text-muted' : ''}`} title={c.description ?? undefined}>
                <input type="checkbox" disabled={c.hidden} checked={s.columns.includes(c.key)} onChange={(e) => up({ columns: e.target.checked ? [...s.columns, c.key] : s.columns.filter((x) => x !== c.key) })} />
                <span>{c.label}</span><span className="rounded bg-surface-alt px-1 text-xs text-muted">{c.type}</span>
                {c.sensitivity && <span className="inline-flex items-center gap-0.5 text-xs text-muted" data-testid={`sens-${c.key}`}><Lock size={10} aria-hidden />{t(SENS_KEY[c.sensitivity as keyof typeof SENS_KEY] ?? 'p11.sens.pii')}</span>}
                {c.hidden && <span className="text-xs">({t('p11.b.hiddenForYou')})</span>}
              </label></li>
            ))}
          </ul>
          <p className="text-xs text-muted">{t('p11.b.columnsHint', { max: REPORT_LIMITS.maxColumns })}</p>
        </section>

        <section className="card space-y-2 p-3" aria-labelledby="b-f">
          <h3 id="b-f" className="text-sm font-semibold">3. {t('p11.b.filters')}</h3>
          {s.filters.map((f, i) => {
            const col = visibleCols.find((c) => c.key === f.column);
            const set = (p: Partial<typeof f>) => up({ filters: s.filters.map((x, j) => (j === i ? { ...x, ...p } : x)) });
            const range = (f.op === 'fy' || f.op === 'period') && f.value ? filterRange(f.op, f.value, today) : null;
            return (
              <div key={i} className="flex flex-wrap items-end gap-2" data-testid={`filter-${i}`}>
                <Field label={t('p11.b.column')}><select className="input" value={f.column} onChange={(e) => { const c = visibleCols.find((x) => x.key === e.target.value); set({ column: e.target.value, op: (c?.ops[0] ?? 'eq') as FilterOp, value: '', value2: '' }); }}>
                  <option value="">—</option>{visibleCols.map((c) => <option key={c.key} value={c.key}>{c.label}{c.hidden ? ` (${t('p11.b.hiddenForYou')})` : ''}</option>)}</select></Field>
                <Field label={t('p11.b.op')}><select className="input" value={f.op} onChange={(e) => set({ op: e.target.value as FilterOp, value: '', value2: '' })}>
                  {(col?.ops ?? ['eq']).map((o) => <option key={o} value={o}>{t(`p11.op.${o}`)}</option>)}</select></Field>
                {opNeedsValue(f.op) && (f.op === 'fy'
                  ? <Field label={t('p11.b.fy')}><select className="input" value={f.value} onChange={(e) => set({ value: e.target.value })}><option value="">—</option>{fyOptions(today).map((x) => <option key={x} value={x}>FY {x}</option>)}</select></Field>
                  : f.op === 'period'
                    ? <Field label={t('p11.b.period')}><select className="input" value={f.value.startsWith('month:') ? 'month' : f.value} onChange={(e) => set({ value: e.target.value === 'month' ? `month:${today.slice(0, 7)}` : e.target.value })}>
                      <option value="">—</option>{PERIODS.map((p) => <option key={p} value={p}>{t(`p11.period.${p}`)}</option>)}<option value="month">{t('p11.period.month')}</option></select></Field>
                    : col?.values && !opIsList(f.op)
                      ? <Field label={t('p11.b.value')}><select className="input" value={f.value} onChange={(e) => set({ value: e.target.value })}><option value="">—</option>{col.values.map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}</select></Field>
                      : col?.type === 'bool'
                        ? <Field label={t('p11.b.value')}><select className="input" value={f.value} onChange={(e) => set({ value: e.target.value })}><option value="">—</option><option value="true">{t('p11.yes')}</option><option value="false">{t('p11.no')}</option></select></Field>
                        : <Field label={t('p11.b.value')} hint={opIsList(f.op) ? t('p11.b.listHint') : col?.type === 'paise' ? t('p11.b.rupeesHint') : undefined}>
                          <input className="input" type={col?.type === 'date' && !opIsList(f.op) ? 'date' : 'text'} value={f.value} onChange={(e) => set({ value: e.target.value })} /></Field>)}
                {f.op === 'period' && f.value.startsWith('month:') && <Field label={t('p11.period.month')}><input className="input" type="month" value={f.value.slice(6)} onChange={(e) => e.target.value && set({ value: `month:${e.target.value}` })} /></Field>}
                {f.op === 'between' && <Field label={t('p11.b.value2')}><input className="input" type={col?.type === 'date' ? 'date' : 'text'} value={f.value2} onChange={(e) => set({ value2: e.target.value })} /></Field>}
                {range && <span className="self-center text-xs text-muted" data-testid={`range-${i}`}>{fmtIstDate(range.from)} – {fmtIstDate(range.to)}</span>}
                <button type="button" className="btn btn-danger px-1.5" aria-label={t('p11.b.removeFilter')} onClick={() => up({ filters: s.filters.filter((_, j) => j !== i) })}><Trash2 size={12} /></button>
              </div>
            );
          })}
          <button type="button" className="btn" disabled={s.filters.length >= REPORT_LIMITS.maxFilters} onClick={() => up({ filters: [...s.filters, { column: '', op: 'eq', value: '', value2: '' }] })}><Plus size={12} aria-hidden />{t('p11.b.addFilter')}</button>
        </section>

        <section className="card grid gap-2 p-3 sm:grid-cols-2" aria-labelledby="b-g">
          <h3 id="b-g" className="text-sm font-semibold sm:col-span-2">4. {t('p11.b.groupAgg')}</h3>
          {[0, 1].map((i) => (
            <Field key={i} label={t(i === 0 ? 'p11.b.groupBy' : 'p11.b.thenBy')}>
              <select className="input" value={s.groupBy[i] ?? ''} disabled={i === 1 && !s.groupBy[0]} onChange={(e) => {
                const g = [...s.groupBy]; if (e.target.value) g[i] = e.target.value; else g.splice(i);
                up({ groupBy: g.filter(Boolean).slice(0, REPORT_LIMITS.maxGroupBy) });
              }}><option value="">—</option>{usable.filter((c) => c.type !== 'id').map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
            </Field>
          ))}
          <div className="space-y-1 sm:col-span-2">
            <span className="label">{t('p11.b.aggregates')}</span>
            {s.aggregates.map((a, i) => {
              const set = (p: Partial<typeof a>) => up({ aggregates: s.aggregates.map((x, j) => (j === i ? { ...x, ...p } : x)) });
              return (
                <div key={i} className="flex flex-wrap items-end gap-2" data-testid={`agg-${i}`}>
                  <Field label={t('p11.b.aggColumn')}><select className="input" value={a.column} onChange={(e) => { const fns = aggFnsFor(colType(e.target.value)); set({ column: e.target.value, fn: fns.includes(a.fn) ? a.fn : fns[0]! }); }}>
                    <option value="">{t('p11.b.rows')}</option>{usable.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
                  <Field label={t('p11.b.fn')}><select className="input" value={a.fn} onChange={(e) => set({ fn: e.target.value as typeof a.fn })}>
                    {aggFnsFor(a.column ? colType(a.column) : undefined).map((fn) => <option key={fn} value={fn}>{t(`p11.fn.${fn}`)}</option>)}</select></Field>
                  <span className="self-center text-xs text-muted">{aggLabel(meta, a.fn, a.column || undefined)}</span>
                  <button type="button" className="btn btn-danger px-1.5" aria-label={t('p11.b.removeAgg')} onClick={() => up({ aggregates: s.aggregates.filter((_, j) => j !== i) })}><Trash2 size={12} /></button>
                </div>
              );
            })}
            <button type="button" className="btn" disabled={s.aggregates.length >= REPORT_LIMITS.maxAggregates} onClick={() => up({ aggregates: [...s.aggregates, { fn: 'count', column: '' }] })}><Plus size={12} aria-hidden />{t('p11.b.addAgg')}</button>
          </div>
        </section>

        <section className="card flex flex-wrap items-end gap-2 p-3" aria-labelledby="b-s">
          <h3 id="b-s" className="w-full text-sm font-semibold">5. {t('p11.b.sortLimit')}</h3>
          <Field label={t('p11.b.sortBy')}><select className="input" value={s.sort[0]?.by ?? ''} onChange={(e) => up({ sort: e.target.value ? [{ by: e.target.value, dir: s.sort[0]?.dir ?? 'asc' }] : [] })}>
            <option value="">—</option>{sortTargets(s, meta).filter((x) => !visibleCols.find((c) => c.key === x.key)?.hidden).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></Field>
          <Field label={t('p11.b.dir')}><select className="input" value={s.sort[0]?.dir ?? 'asc'} disabled={!s.sort[0]} onChange={(e) => up({ sort: s.sort.map((x, j) => (j === 0 ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)) })}>
            <option value="asc">{t('p11.b.asc')}</option><option value="desc">{t('p11.b.desc')}</option></select></Field>
          <Field label={t('p11.b.limit')}><input className="input w-24" inputMode="numeric" value={s.limit} onChange={(e) => up({ limit: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label={t('p11.b.chart')}><select className="input" value={s.chart} onChange={(e) => up({ chart: e.target.value as BuilderState['chart'] })}>
            {CHART_TYPES.map((c) => <option key={c} value={c}>{t(`p11.chartType.${c}`)}</option>)}</select></Field>
          {(dataset.params ?? []).map((p) => (
            <Field key={p.key} label={p.description}><input className="input" type={p.type === 'date' ? 'date' : p.type === 'month' ? 'month' : 'text'} value={s.params[p.key] ?? ''} placeholder={String(p.default)}
              onChange={(e) => up({ params: { ...s.params, [p.key]: e.target.value } })} /></Field>
          ))}
        </section>
      </>}

      <div className="card space-y-2 p-3">
        {masked && <p className="text-sm text-muted" data-testid="builder-masked">{t('p11.b.masked')}</p>}
        {v.ok ? <p className="text-sm text-done" data-testid="builder-valid">{t('p11.b.valid')}</p>
          : <ul role="alert" className="list-disc pl-5 text-sm text-overdue" data-testid="builder-issues">{v.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" className="btn" disabled={!v.ok || masked} onClick={() => setPreview(v.definition)}>{t('p11.b.preview')}</button>
          <Field label={t('p11.f.name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('p11.f.description')}><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          {(saved ? saved.canEdit && can('reports', 'edit') : can('reports', 'create')) &&
            <button type="button" className="btn btn-primary" disabled={!v.ok || masked || !name.trim() || save.isPending} onClick={() => { setError(null); save.mutate(); }}>{saved ? t('p11.b.saveVersion') : t('p11.b.save')}</button>}
        </div>
        {error && <p role="alert" className="text-sm text-overdue" data-testid="builder-error">{error}</p>}
      </div>
      {preview && <ReportResult key={JSON.stringify(preview)} source={{ definition: preview }} showParams={false} />}
      {sharing && saved && <ShareDialog report={saved} onClose={() => setSharing(false)} />}
      {versions && saved && <VersionsDialog report={saved} onRestore={(d) => { setS(fromDefinition(d)); setPreview(null); setVersions(false); }} onClose={() => setVersions(false)} />}
    </div>
  );
}

function VersionsDialog({ report, onRestore, onClose }: { report: SavedReport; onRestore(d: ReportDefinition): void; onClose(): void }) {
  const t = useT();
  const q = useQuery({ queryKey: ['reports', 'saved', report.id, 'versions'], queryFn: () => as<{ items: SavedVersion[] }>(api.GET('/reports/saved/{id}/versions', { params: { path: { id: report.id } } })).then((r) => r.items) });
  return (
    <Dialog title={t('p11.b.versionsTitle')} onClose={onClose}>
      <ul className="space-y-1" data-testid="versions">
        {(q.data ?? []).map((v) => (
          <li key={v.reportVersion} className="flex items-center justify-between gap-2 rounded border border-border p-2 text-sm">
            <span>v{v.reportVersion} · {v.name} <span className="text-xs text-muted">{fmtIstDateTime(v.changedAt)}</span></span>
            {v.reportVersion !== report.currentVersion ? <button type="button" className="btn" onClick={() => onRestore(v.definition)}>{t('p11.b.restore')}</button> : <span className="text-xs text-muted">{t('p11.b.current')}</span>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">{t('p11.b.restoreHint')}</p>
    </Dialog>
  );
}

function ShareDialog({ report, onClose }: { report: SavedReport; onClose(): void }) {
  const t = useT();
  const err = useReportError();
  const qc = useQueryClient();
  const publisher = useFirmPublisher();
  const me = useMe().data;
  const { users } = useUsers();
  const roles = useQuery({ queryKey: ['roles'], retry: false, queryFn: () => as<Array<{ key: string; name: string }>>(api.GET('/roles')) });
  const roleList = roles.data ?? (me?.roles ?? []).map((k) => ({ key: k, name: k }));
  const [share, setShare] = useState<Required<Share>>({ firm: !!report.share.firm, roles: report.share.roles ?? [], userIds: report.share.userIds ?? [] });
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => asFull(api.PUT('/reports/saved/{id}/share', { params: { path: { id: report.id } }, body: body(share) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['reports', 'saved'] }); toast({ text: t('p11.b.shared'), tone: 'ok' }); onClose(); },
    onError: (e) => setError(err(e)),
  });
  const toggle = (list: string[], x: string) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  return (
    <Dialog title={t('p11.b.shareTitle', { name: report.name })} onClose={onClose}>
      <div className="space-y-3" data-testid="share-dialog">
        <p className="rounded bg-surface-alt p-2 text-sm" data-testid="share-note">{t('p11.b.shareNote')}</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!publisher} checked={share.firm} onChange={(e) => setShare({ ...share, firm: e.target.checked })} />{t('p11.b.shareFirm')}</label>
        <fieldset><legend className="label">{t('p11.b.shareRoles')}</legend>
          <div className="flex flex-wrap gap-2">{roleList.map((r) => <label key={r.key} className="flex items-center gap-1 text-sm"><input type="checkbox" disabled={!publisher} checked={share.roles.includes(r.key)} onChange={() => setShare({ ...share, roles: toggle(share.roles, r.key) })} />{r.name}</label>)}</div>
        </fieldset>
        {!publisher && <p className="text-xs text-muted">{t('p11.b.sharePublisher')}</p>}
        <fieldset><legend className="label">{t('p11.b.shareUsers')}</legend>
          <div className="flex max-h-40 flex-wrap gap-2 overflow-auto">{users.filter((u) => u.id !== me?.id).map((u) => <label key={u.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={share.userIds.includes(u.id)} onChange={() => setShare({ ...share, userIds: toggle(share.userIds, u.id) })} />{u.name}</label>)}</div>
        </fieldset>
        {error && <p role="alert" className="text-sm text-overdue">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>{t('p11.b.shareSave')}</button></div>
      </div>
    </Dialog>
  );
}
