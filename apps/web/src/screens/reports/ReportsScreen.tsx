import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { addDaysIso } from '@worko/domain';
import { formatDate } from '@worko/i18n';
import { AlertTriangle, Pencil, Search } from 'lucide-react';
import { useState } from 'react';
import { Field, Tabs } from '../../components/Dialog';
import { currentFy, todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { isUuid, useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { Money } from '../billing/shared';
import { as, type Capacity } from '../hr/api';
import { fmtMinutes, HEAT_BUCKETS, HEAT_STYLE, heatBucket, pnlTotals, weekOf, type PnlItem } from '../hr/logic';
import { LiveActivity } from '../time/TimeScreen';
import { asFull, useCatalogue, useSaved, type SavedReport } from './api';
import { AskView, useAskAvailable } from './Ask';
import { BuilderLoader, ReportBuilder } from './Builder';
import { groupCatalogue } from './logic';
import { ReportResult, useReportError } from './ResultView';
import { DownloadPage, SchedulesView } from './Schedules';

type View = 'catalogue' | 'saved' | 'builder' | 'schedules' | 'ask' | 'pnl' | 'capacity' | 'live';

export function ReportsScreen() {
  const t = useT();
  const can = useCan();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  const ask = useAskAvailable();
  const rv = can('reports', 'view');
  if (params[0] === 'download' && params[1]) return <DownloadPage token={params[1]} />;
  const tabs: Array<[View, string]> = [
    ...(rv ? [['catalogue', t('p11.tab.catalogue')], ['saved', t('p11.tab.saved')], ['builder', t('p11.tab.builder')], ['schedules', t('p11.tab.schedules')]] as Array<[View, string]> : []),
    ...(rv && ask ? [['ask', t('p11.tab.ask')] as [View, string]] : []),
    ...(rv && can('billing', 'view') ? [['pnl', t('p6.rep.pnl')] as [View, string]] : []),
    ...(can('time', 'view') ? [['capacity', t('p6.rep.capacity')] as [View, string], ['live', t('p6.time.tab.live')] as [View, string]] : []),
  ];
  if (!tabs.length) return <p className="card p-6 text-muted">{t('p6.noAccess')}</p>;
  const sub = params[0] === 'run' ? 'catalogue' : params[0];
  const view = tabs.find(([k]) => k === sub)?.[0] ?? tabs[0]![0];
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('nav.reports')}</h1>
      <Tabs label={t('nav.reports')} tabs={tabs} value={view} onChange={(v) => go(`reports/${v}`)} />
      {view === 'catalogue' && (params[0] === 'run' && params[1] ? <CatalogueReportPage key={params[1]} reportKey={params[1]} /> : <CatalogueView />)}
      {view === 'saved' && (isUuid(params[1]) ? <SavedReportPage key={params[1]} id={params[1]} /> : <SavedList />)}
      {view === 'builder' && (isUuid(params[1]) ? <BuilderLoader id={params[1]} /> : <ReportBuilder />)}
      {view === 'schedules' && <SchedulesView />}
      {view === 'ask' && <AskView />}
      {view === 'pnl' && <JobPnl />}
      {view === 'capacity' && <CapacityHeatMap />}
      {view === 'live' && <LiveActivity />}
    </div>
  );
}

/** Built-in reports grouped by area, with search. */
function CatalogueView() {
  const t = useT();
  const err = useReportError();
  const q = useCatalogue();
  const [search, setSearch] = useState('');
  const groups = groupCatalogue(q.data ?? [], search);
  return (
    <div className="space-y-3" data-testid="catalogue">
      <label className="relative block max-w-md"><Search size={14} className="absolute left-2 top-2.5 text-muted" aria-hidden />
        <input className="input pl-7" type="search" aria-label={t('common.search')} placeholder={t('p11.cat.search')} value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      {q.isError && <p role="alert" className="text-overdue">{err(q.error)}</p>}
      {q.data && !groups.length && <p className="text-muted">{t('p11.cat.none')}</p>}
      {groups.map((g) => (
        <section key={g.area} aria-labelledby={`area-${g.area}`} className="space-y-1">
          <h2 id={`area-${g.area}`} className="text-sm font-semibold uppercase tracking-wide text-muted">{t(`p11.area.${g.area}` as never) === `p11.area.${g.area}` ? g.area : t(`p11.area.${g.area}` as never)}</h2>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{g.items.map((r) => (
            <li key={r.key}><a className="card block h-full p-3 hover:bg-surface-alt" href={`#/reports/run/${r.key}`}>
              <div className="font-medium">{r.name}</div><div className="text-xs text-muted">{r.description}</div></a></li>
          ))}</ul>
        </section>
      ))}
    </div>
  );
}

function CatalogueReportPage({ reportKey }: { reportKey: string }) {
  const t = useT();
  const item = useCatalogue().data?.find((c) => c.key === reportKey);
  return (
    <div className="space-y-2">
      <a className="text-sm underline" href="#/reports/catalogue">← {t('p11.tab.catalogue')}</a>
      <h2 className="text-lg font-semibold">{item?.name ?? reportKey}</h2>
      {item && <p className="text-sm text-muted">{item.description}</p>}
      <ReportResult source={{ catalogueKey: reportKey }} title={item?.name} />
    </div>
  );
}

function SavedList() {
  const t = useT();
  const err = useReportError();
  const q = useSaved();
  return (
    <div className="space-y-2" data-testid="saved-list">
      {q.isError && <p role="alert" className="text-overdue">{err(q.error)}</p>}
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p11.tab.saved')}>
        <thead><tr><th>{t('p11.f.name')}</th><th>{t('p11.saved.owner')}</th><th>{t('p11.saved.shared')}</th><th>{t('p11.saved.version')}</th><th /></tr></thead>
        <tbody>
          {q.data && !q.data.length && <tr><td colSpan={5} className="text-muted">{t('p11.saved.empty')}</td></tr>}
          {(q.data ?? []).map((r) => (
            <tr key={r.id}><td><a className="underline" href={`#/reports/saved/${r.id}`}>{r.name}</a><div className="text-xs text-muted">{r.explanation}</div></td>
              <td>{r.ownerName ?? '—'}</td><td className="text-sm">{[r.share.firm ? t('p11.saved.firm') : null, ...(r.share.roles ?? []), (r.share.userIds ?? []).length ? t('p11.saved.users', { count: (r.share.userIds ?? []).length }) : null].filter(Boolean).join(', ') || '—'}</td>
              <td>v{r.currentVersion}</td><td className="text-right"><a className="btn" href={`#/reports/builder/${r.id}`}><Pencil size={12} aria-hidden />{t('p11.saved.edit')}</a></td></tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}

function SavedReportPage({ id }: { id: string }) {
  const t = useT();
  const err = useReportError();
  const q = useQuery({ queryKey: ['reports', 'saved', id], retry: false, queryFn: () => asFull<SavedReport>(api.GET('/reports/saved/{id}', { params: { path: { id } } })) });
  if (q.isError) return <p role="alert" className="card p-4 text-overdue">{err(q.error)}</p>;
  const r = q.data;
  return (
    <div className="space-y-2">
      <a className="text-sm underline" href="#/reports/saved">← {t('p11.tab.saved')}</a>
      <div className="flex items-center justify-between gap-2"><h2 className="text-lg font-semibold">{r?.name ?? '…'}</h2>
        {r && <a className="btn" href={`#/reports/builder/${id}`}><Pencil size={12} aria-hidden />{t('p11.saved.edit')}</a>}</div>
      {r?.description && <p className="text-sm text-muted">{r.description}</p>}
      {r && <ReportResult source={{ reportId: id }} title={r.name} />}
    </div>
  );
}

function JobPnl() {
  const t = useT();
  const fyStart = `${currentFy().slice(0, 4)}-04-01`;
  const [from, setFrom] = useState(fyStart);
  const [to, setTo] = useState(todayIst());
  const [groupBy, setGroupBy] = useState<'task' | 'client' | 'service'>('client');
  const [lossOnly, setLossOnly] = useState(false);
  const q = useQuery({ queryKey: ['reports', 'pnl', from, to, groupBy], enabled: !!from && !!to && from <= to, placeholderData: keepPreviousData,
    queryFn: () => unwrap(api.GET('/reports/job-pnl', { params: { query: { from, to, groupBy } } })) });
  const all = (q.data?.items ?? []) as PnlItem[];
  const costVisible = q.data?.costVisible === true;
  // Fee columns (revenue, WIP, margin, loss) are null for roles without fee visibility.
  const feesVisible = (q.data as { feesVisible?: boolean } | undefined)?.feesVisible !== false;
  const Fee = ({ p }: { p: number | null | undefined }) => (p === null && !feesVisible ? <span className="text-xs text-muted">{t('p11.pnl.hiddenCell')}</span> : <Money p={p} />);
  const items = lossOnly ? all.filter((x) => x.loss) : all;
  const tot = pnlTotals(items);
  return (
    <div className="space-y-2">
      <div className="card grid gap-2 p-3 sm:grid-cols-4">
        <Field label={t('p6.f.from')}><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('p6.f.to')}><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label={t('p6.rep.groupBy')}><select className="input" value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}>
          <option value="task">{t('p6.f.task')}</option><option value="client">{t('p6.f.client')}</option><option value="service">{t('p6.rep.service')}</option></select></Field>
        <label className="flex items-center gap-2 self-end"><input type="checkbox" checked={lossOnly} onChange={(e) => setLossOnly(e.target.checked)} /> {t('p6.rep.lossOnly')}</label>
      </div>
      {!costVisible && q.data && <p className="text-xs text-muted">{t('p6.rep.costHidden')}</p>}
      {!feesVisible && q.data && <p className="text-xs text-muted" data-testid="pnl-fees-hidden">{t('p11.pnl.feesHidden')}</p>}
      {q.isError && <p role="alert" className="text-overdue">{t('common.error')}</p>}
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p6.rep.pnl')}>
        <thead><tr><th>{t(groupBy === 'task' ? 'p6.f.task' : groupBy === 'client' ? 'p6.f.client' : 'p6.rep.service')}</th><th className="text-right">{t('p6.rep.hours')}</th>
          <th className="text-right">{t('p6.rep.revenue')}</th>
          {costVisible && <><th className="text-right">{t('p6.rep.cost')}</th><th className="text-right">{t('p6.rep.margin')}</th><th className="text-right">%</th></>}
          <th className="text-right">{t('p6.rep.wip')}</th></tr></thead>
        <tbody>
          {q.data && !items.length && <tr><td colSpan={7} className="text-muted">{t('p6.rep.empty')}</td></tr>}
          {items.map((x) => (
            <tr key={x.key} className={x.loss ? 'text-overdue' : ''}>
              <td>{x.loss && <AlertTriangle size={12} className="mr-1 inline" aria-label={t('p6.rep.loss')} />}{x.label || t('p6.time.internal')}</td>
              <td className="text-right tabular-nums">{fmtMinutes(x.minutes)}</td><td className="text-right"><Fee p={x.revenuePaise} /></td>
              {costVisible && <><td className="text-right"><Money p={x.costPaise} /></td><td className="text-right"><Fee p={x.marginPaise} /></td>
                <td className="text-right tabular-nums">{(x as PnlItem & { marginPct?: number | null }).marginPct ?? '—'}</td></>}
              <td className="text-right"><Fee p={x.wipPaise} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="font-semibold"><td>{t('p6.total')}{tot.losses > 0 && <span className="ml-2 text-xs text-overdue">{t('p6.rep.losses', { count: tot.losses })}</span>}</td>
          <td className="text-right tabular-nums">{fmtMinutes(tot.minutes)}</td><td className="text-right" data-testid="pnl-revenue"><Fee p={tot.revenuePaise} /></td>
          {costVisible && <><td className="text-right"><Money p={tot.costPaise} /></td><td className="text-right" data-testid="pnl-margin"><Fee p={tot.marginPaise} /></td><td className="text-right tabular-nums">{tot.marginPct ?? '—'}</td></>}
          <td className="text-right"><Fee p={tot.wipPaise} /></td></tr></tfoot>
      </table></div>
      {!!q.data?.creditNotesPaise && <p className="text-xs text-muted">{t('p6.rep.creditNotes')} <Money p={q.data.creditNotesPaise} /></p>}
    </div>
  );
}

function CapacityHeatMap() {
  const t = useT();
  const [from, setFrom] = useState(weekOf(todayIst()));
  const [weeks, setWeeks] = useState(6);
  const [metric, setMetric] = useState<'planned' | 'actual'>('planned');
  const q = useQuery({ queryKey: ['reports', 'capacity', from, weeks], placeholderData: keepPreviousData,
    queryFn: () => as<Capacity>(api.GET('/reports/capacity', { params: { query: { from, weeks } } })) });
  const d = q.data;
  return (
    <div className="space-y-2">
      <div className="card flex flex-wrap items-end gap-2 p-3">
        <Field label={t('p6.f.from')}><input type="date" className="input" value={from} onChange={(e) => e.target.value && setFrom(weekOf(e.target.value))} /></Field>
        <Field label={t('p6.rep.weeks')}><select className="input" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[4, 6, 8, 12, 26].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
        <Field label={t('p6.rep.metric')}><select className="input" value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)}>
          <option value="planned">{t('p6.rep.planned')}</option><option value="actual">{t('p6.rep.actual')}</option></select></Field>
        <button className="btn" onClick={() => setFrom(addDaysIso(from, -7 * weeks))}>{t('p6.prev')}</button>
        <button className="btn" onClick={() => setFrom(addDaysIso(from, 7 * weeks))}>{t('p6.next')}</button>
      </div>
      <ul className="flex flex-wrap gap-3 text-xs" aria-label={t('p6.rep.legend')}>
        {HEAT_BUCKETS.map((b) => <li key={b} className="flex items-center gap-1"><span className="inline-block h-3 w-5 rounded border border-border" style={{ background: HEAT_STYLE[b] }} aria-hidden />{t(`p6.heat.${b}`)}</li>)}
      </ul>
      {d && <div className="card overflow-auto"><table className="table w-full" aria-label={t('p6.rep.capacity')}>
        <thead><tr><th>{t('p6.f.person')}</th>{d.weeks.map((w) => <th key={w} className="text-center">{formatDate(w).replace(/\s\d{4}$/, '')}</th>)}</tr></thead>
        <tbody>{d.users.map((u) => (
          <tr key={u.userId}><td>{u.name}<span className="block text-xs text-muted">{t('p6.rep.perWeek', { time: fmtMinutes(u.weeklyCapacityMinutes) })}</span></td>
            {u.weeks.map((c) => {
              const pct = metric === 'planned' ? c.plannedPct : c.actualPct;
              const b = heatBucket(pct);
              const mins = metric === 'planned' ? c.plannedMinutes : c.actualMinutes;
              return (
                <td key={c.weekStart} className="text-center tabular-nums" data-bucket={b} style={{ background: HEAT_STYLE[b] }}
                  title={t('p6.rep.cellTitle', { used: fmtMinutes(mins), cap: fmtMinutes(c.capacityMinutes), leave: c.leaveDays, holidays: c.holidays })}>
                  {pct === null ? '—' : `${Math.round(pct)}%`}
                </td>
              );
            })}
          </tr>
        ))}</tbody>
      </table></div>}
    </div>
  );
}
