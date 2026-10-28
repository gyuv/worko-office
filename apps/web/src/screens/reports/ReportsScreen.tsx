import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { addDaysIso } from '@worko/domain';
import { formatDate } from '@worko/i18n';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Field, Tabs } from '../../components/Dialog';
import { currentFy, todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { Money } from '../billing/shared';
import { as, type Capacity } from '../hr/api';
import { fmtMinutes, HEAT_BUCKETS, HEAT_STYLE, heatBucket, pnlTotals, weekOf, type PnlItem } from '../hr/logic';
import { LiveActivity } from '../time/TimeScreen';

type View = 'pnl' | 'capacity' | 'live';

export function ReportsScreen() {
  const t = useT();
  const can = useCan();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  const tabs: Array<[View, string]> = [
    ...(can('reports', 'view') ? [['pnl', t('p6.rep.pnl')] as [View, string]] : []),
    ...(can('time', 'view') ? [['capacity', t('p6.rep.capacity')] as [View, string], ['live', t('p6.time.tab.live')] as [View, string]] : []),
  ];
  if (!tabs.length) return <p className="card p-6 text-muted">{t('p6.noAccess')}</p>;
  const view = tabs.find(([k]) => k === params[0])?.[0] ?? tabs[0]![0];
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('nav.reports')}</h1>
      <Tabs label={t('nav.reports')} tabs={tabs} value={view} onChange={(v) => go(`reports/${v}`)} />
      {view === 'pnl' && <JobPnl />}
      {view === 'capacity' && <CapacityHeatMap />}
      {view === 'live' && <LiveActivity />}
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
              <td className="text-right tabular-nums">{fmtMinutes(x.minutes)}</td><td className="text-right"><Money p={x.revenuePaise} /></td>
              {costVisible && <><td className="text-right"><Money p={x.costPaise} /></td><td className="text-right"><Money p={x.marginPaise} /></td>
                <td className="text-right tabular-nums">{(x as PnlItem & { marginPct?: number | null }).marginPct ?? '—'}</td></>}
              <td className="text-right"><Money p={x.wipPaise} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="font-semibold"><td>{t('p6.total')}{tot.losses > 0 && <span className="ml-2 text-xs text-overdue">{t('p6.rep.losses', { count: tot.losses })}</span>}</td>
          <td className="text-right tabular-nums">{fmtMinutes(tot.minutes)}</td><td className="text-right" data-testid="pnl-revenue"><Money p={tot.revenuePaise} /></td>
          {costVisible && <><td className="text-right"><Money p={tot.costPaise} /></td><td className="text-right" data-testid="pnl-margin"><Money p={tot.marginPaise} /></td><td className="text-right tabular-nums">{tot.marginPct ?? '—'}</td></>}
          <td className="text-right"><Money p={tot.wipPaise} /></td></tr></tfoot>
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
