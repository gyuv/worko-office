import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dashboardWidgetsSchema, type DashboardWidget } from '@worko/domain';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useMe } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { as, asFull, body, useCatalogue, useSaved, type Dashboard, type DashboardData, type WidgetData } from './api';
import { Chart } from './Chart';
import { cellRef, drillStep, formatCell, hiddenLabels, refHref, widgetChartData, widgetSourceRoute, type Crumb } from './logic';
import { ReportResult, useReportError } from './ResultView';
import { datasetMeta } from '@worko/domain';

/** Firm-wide reports:approve (role-default dashboards, firm sharing) — UI hint; the server re-checks. */
export function useFirmPublisher() {
  const me = useMe().data;
  return !!me?.grants.some((g) => g.module === 'reports' && g.action === 'approve' && g.scope === 'all');
}

/** Home dashboard: the viewer's default (personal → role default → built-in role template), every widget run as the viewer. */
export function DashboardView() {
  const t = useT();
  const err = useReportError();
  const [editing, setEditing] = useState(false);
  const [drill, setDrill] = useState<{ w: WidgetData; source: DashboardWidget; trail: Crumb[]; drill: Record<string, string | number | boolean | null> | null } | null>(null);
  const q = useQuery({ queryKey: ['reports', 'dashboard', 'default'], retry: false, queryFn: () => as<DashboardData>(api.GET('/reports/dashboards/default/data')) });
  const d = q.data;
  if (q.isError) return <p role="alert" className="card p-4 text-overdue">{err(q.error)}</p>;
  if (!d) return <p className="text-muted">{t('common.loading')}</p>;
  const byId = new Map(d.dashboard.widgets.map((w) => [w.id, w]));
  return (
    <section className="space-y-3" aria-label={t('p11.dash.title')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold" data-testid="dashboard-name">{d.dashboard.name ?? t('p11.dash.title')}
          <span className="ml-2 text-xs font-normal text-muted">{t(`p11.dash.origin.${d.dashboard.origin ?? 'none'}` as never)}</span></h2>
        <button type="button" className="btn" onClick={() => setEditing(true)}><Pencil size={12} aria-hidden />{t('p11.dash.edit')}</button>
      </div>
      {!d.widgets.length && <p className="card p-4 text-muted">{t('p11.dash.empty')}</p>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {d.widgets.map((w) => <Widget key={w.id} w={w} src={byId.get(w.id)} onDrill={(trail, dr) => byId.get(w.id) && setDrill({ w, source: byId.get(w.id)!, trail, drill: dr })} />)}
      </div>
      {drill && <Dialog wide title={drill.w.title} onClose={() => setDrill(null)}>
        <ReportResult source={drill.source.reportId ? { reportId: drill.source.reportId } : { catalogueKey: drill.source.catalogueKey! }} initialParams={drill.source.params}
          initialTrail={drill.trail} initialDrill={drill.drill} title={drill.w.title} />
      </Dialog>}
      {editing && <DashboardEditor dashboard={d.dashboard} onClose={() => setEditing(false)} />}
    </section>
  );
}

function Widget({ w, src, onDrill }: { w: WidgetData; src?: DashboardWidget; onDrill(trail: Crumb[], drill: Record<string, string | number | boolean | null> | null): void }) {
  const t = useT();
  const go = useRoute((s) => s.go);
  const open = () => { const r = src && widgetSourceRoute(src); if (r) go(r as never); };
  const span = w.kind === 'table' ? 'md:col-span-2' : '';
  if (w.error) return <div className={`card p-3 ${span}`} data-testid={`widget-${w.id}`}><h3 className="text-sm font-medium">{w.title}</h3><p className="text-xs text-muted">{t(`p11.err.${w.error}` as never) === `p11.err.${w.error}` ? t('p11.dash.widgetError') : t(`p11.err.${w.error}` as never)}</p></div>;
  const hidden = w.hiddenColumns?.length ? <p className="text-xs text-muted">{t('p11.hidden', { columns: hiddenLabels(w.dataset ?? '', w.hiddenColumns).join(', ') })}</p> : null;
  if (w.kind === 'kpi') return (
    <button type="button" className={`card p-3 text-left hover:bg-surface-alt ${span}`} data-testid={`widget-${w.id}`} onClick={() => onDrill([], null)}>
      <div className="text-xs text-muted">{w.title}</div>
      <div className="text-2xl font-semibold tabular-nums" data-testid="kpi-value">{formatCell(w.value ?? null, (w.type ?? 'number'))}</div>
      {hidden}
    </button>
  );
  if (w.kind === 'chart') {
    const cd = widgetChartData(w);
    return (
      <div className={`card space-y-2 p-3 ${span}`} data-testid={`widget-${w.id}`}>
        <div className="flex items-center justify-between"><h3 className="text-sm font-medium">{w.title}</h3><button type="button" className="text-xs underline" onClick={open}>{t('p11.dash.open')}</button></div>
        {hidden}
        {cd ? <Chart data={cd} label={w.title} onSelect={(g) => { const s = drillStep(g); onDrill([s.crumb], s.kind === 'rows' ? s.drill : null); }} /> : <p className="text-xs text-muted">{t('p11.empty')}</p>}
      </div>
    );
  }
  const meta = datasetMeta(w.dataset ?? '');
  return (
    <div className={`card space-y-2 p-3 ${span}`} data-testid={`widget-${w.id}`}>
      <div className="flex items-center justify-between"><h3 className="text-sm font-medium">{w.title}</h3><button type="button" className="text-xs underline" onClick={() => onDrill([], null)}>{t('p11.dash.open')}</button></div>
      {hidden}
      <div className="overflow-auto"><table className="table w-full text-sm"><thead><tr>{(w.columns ?? []).map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>{!(w.rows ?? []).length && <tr><td className="text-muted">{t('p11.empty')}</td></tr>}
          {(w.rows ?? []).map((row, i) => <tr key={i}>{(w.columns ?? []).map((c) => { const ref = cellRef(c.key, row, meta); const href = ref && refHref(ref.type, ref.id); const v = formatCell(row.values[c.key], c.type);
            return <td key={c.key}>{href ? <a className="underline" href={href}>{v}</a> : v}</td>; })}</tr>)}</tbody></table></div>
      {(w.rowCount ?? 0) > (w.rows ?? []).length && <p className="text-xs text-muted">{t('p11.dash.more', { count: (w.rowCount ?? 0) - (w.rows ?? []).length })}</p>}
    </div>
  );
}

/** Add/remove/reorder widgets (catalogue or saved reports), save as a personal dashboard (+ set default) or as a firm role default. */
function DashboardEditor({ dashboard, onClose }: { dashboard: Dashboard; onClose(): void }) {
  const t = useT();
  const err = useReportError();
  const qc = useQueryClient();
  const me = useMe().data;
  const publisher = useFirmPublisher();
  const cat = useCatalogue().data ?? [];
  const saved = useSaved().data ?? [];
  const [name, setName] = useState(dashboard.name ?? t('p11.dash.myDashboard'));
  const [widgets, setWidgets] = useState<DashboardWidget[]>(dashboard.widgets);
  const [makeDefault, setMakeDefault] = useState(true);
  const [target, setTarget] = useState<string>(dashboard.origin === 'user' ? 'mine' : 'new');
  const [add, setAdd] = useState({ source: '', kind: 'chart' as DashboardWidget['kind'], title: '', chart: '' });
  const [error, setError] = useState<string | null>(null);
  const valid = dashboardWidgetsSchema.safeParse(widgets);
  const move = (i: number, d: number) => { const w = [...widgets]; const [x] = w.splice(i, 1); w.splice(i + d, 0, x!); setWidgets(w); };
  const addWidget = () => {
    const [kind, key] = add.source.split(':') as [string, string];
    const label = kind === 'cat' ? cat.find((c) => c.key === key)?.name : saved.find((s) => s.id === key)?.name;
    const id = `w${Date.now().toString(36)}${widgets.length}`;
    setWidgets([...widgets, { id, kind: add.kind, title: add.title.trim() || label || key, ...(kind === 'cat' ? { catalogueKey: key } : { reportId: key }),
      ...(add.kind === 'chart' && add.chart ? { chart: add.chart as 'bar' } : {}) }]);
    setAdd({ ...add, source: '', title: '' });
  };
  const save = useMutation({
    mutationFn: async () => {
      if (target.startsWith('role:')) {
        const roleKey = target.slice(5);
        const list = await as<{ items: Dashboard[] }>(api.GET('/reports/dashboards'));
        const existing = list.items.find((x) => x.roleKey === roleKey);
        if (existing?.id) await asFull(api.PUT('/reports/dashboards/{id}', { params: { path: { id: existing.id } }, body: body({ name, widgets }) }));
        else await asFull(api.POST('/reports/dashboards', { body: body({ name, widgets, roleKey }) }));
        return;
      }
      let id = target === 'mine' ? dashboard.id : null;
      if (id) await asFull(api.PUT('/reports/dashboards/{id}', { params: { path: { id } }, body: body({ name, widgets }) }));
      else id = (await asFull<Dashboard>(api.POST('/reports/dashboards', { body: body({ name, widgets }) }))).id;
      if (makeDefault && id) await asFull(api.PUT('/reports/dashboards/default', { body: body({ dashboardId: id }) }));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['reports', 'dashboard'] }); toast({ text: t('p11.dash.saved'), tone: 'ok' }); onClose(); },
    onError: (e) => setError(err(e)),
  });
  const roles = me?.roles ?? [];
  return (
    <Dialog wide title={t('p11.dash.edit')} onClose={onClose}>
      <div className="space-y-3" data-testid="dashboard-editor">
        <Field label={t('p11.f.name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <ol className="space-y-1">
          {widgets.map((w, i) => (
            <li key={w.id} className="flex items-center gap-2 rounded border border-border p-1.5" data-testid="editor-widget">
              <span className="flex-1 truncate text-sm">{w.title} <span className="text-xs text-muted">· {t(`p11.kind.${w.kind}`)}</span></span>
              <button type="button" className="btn px-1.5" aria-label={t('p11.up')} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={12} /></button>
              <button type="button" className="btn px-1.5" aria-label={t('p11.down')} disabled={i === widgets.length - 1} onClick={() => move(i, 1)}><ArrowDown size={12} /></button>
              <button type="button" className="btn btn-danger px-1.5" aria-label={t('p11.remove', { name: w.title })} onClick={() => setWidgets(widgets.filter((x) => x.id !== w.id))}><Trash2 size={12} /></button>
            </li>
          ))}
        </ol>
        <fieldset className="grid gap-2 rounded border border-border p-2 sm:grid-cols-4">
          <legend className="px-1 text-xs text-muted">{t('p11.dash.addWidget')}</legend>
          <Field label={t('p11.dash.report')}><select className="input" value={add.source} onChange={(e) => setAdd({ ...add, source: e.target.value })}>
            <option value="">—</option>
            <optgroup label={t('p11.tab.catalogue')}>{cat.map((c) => <option key={c.key} value={`cat:${c.key}`}>{c.name}</option>)}</optgroup>
            {saved.length > 0 && <optgroup label={t('p11.tab.saved')}>{saved.map((s) => <option key={s.id} value={`saved:${s.id}`}>{s.name}</option>)}</optgroup>}
          </select></Field>
          <Field label={t('p11.dash.kind')}><select className="input" value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value as DashboardWidget['kind'] })}>
            {(['kpi', 'chart', 'table'] as const).map((k) => <option key={k} value={k}>{t(`p11.kind.${k}`)}</option>)}</select></Field>
          {add.kind === 'chart' && <Field label={t('p11.b.chart')}><select className="input" value={add.chart} onChange={(e) => setAdd({ ...add, chart: e.target.value })}>
            <option value="">{t('p11.dash.chartAuto')}</option>{(['bar', 'line', 'pie'] as const).map((k) => <option key={k} value={k}>{t(`p11.chartType.${k}`)}</option>)}</select></Field>}
          <Field label={t('p11.dash.widgetTitle')}><input className="input" value={add.title} onChange={(e) => setAdd({ ...add, title: e.target.value })} /></Field>
          <div className="sm:col-span-4"><button type="button" className="btn" disabled={!add.source} onClick={addWidget}><Plus size={12} aria-hidden />{t('p11.dash.add')}</button></div>
        </fieldset>
        <Field label={t('p11.dash.saveAs')}><select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
          {dashboard.origin === 'user' && dashboard.canEdit && <option value="mine">{t('p11.dash.updateMine')}</option>}
          <option value="new">{t('p11.dash.newMine')}</option>
          {publisher && roles.map((r) => <option key={r} value={`role:${r}`}>{t('p11.dash.roleDefault', { role: r })}</option>)}
        </select></Field>
        {!target.startsWith('role:') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />{t('p11.dash.setDefault')}</label>}
        {!valid.success && <p role="alert" className="text-xs text-overdue">{valid.error.issues.map((i) => i.message).join('; ')}</p>}
        {error && <p role="alert" className="text-sm text-overdue">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={!valid.success || !name.trim() || save.isPending} onClick={() => save.mutate()}>{t('common.save')}</button></div>
      </div>
    </Dialog>
  );
}
