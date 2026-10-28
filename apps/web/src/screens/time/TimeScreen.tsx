import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDaysIso, TIME_STATUSES } from '@worko/domain';
import { formatDate } from '@worko/i18n';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { as, type LiveItem, type TimeEntry } from '../hr/api';
import { buildGrid, cellEditable, fmtMinutes, parseMinutes, weekOf, type GridRow } from '../hr/logic';
import { PersonSelect } from '../tasks/shared';
import { invalidateTime, LogTimeDialog, StatusPill, TaskSelect, useP6Error } from './shared';

type View = 'week' | 'entries' | 'approvals' | 'live';
const VIEWS: View[] = ['week', 'entries', 'approvals', 'live'];

export function TimeScreen() {
  const t = useT();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  const can = useCan();
  const view = (VIEWS as string[]).includes(params[0] ?? '') ? (params[0] as View) : 'week';
  const [logging, setLogging] = useState(false);
  if (!can('time', 'view')) return <p className="card p-6 text-muted">{t('p6.noAccess')}</p>;
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t('p6.nav.time')}</h1>
        <button className="btn btn-primary ml-auto" onClick={() => setLogging(true)}><Plus size={14} aria-hidden /> {t('p6.time.log')}</button>
      </header>
      <Tabs label={t('p6.nav.time')} value={view} onChange={(v) => go(`time/${v}`)}
        tabs={[['week', t('p6.time.tab.week')], ['entries', t('p6.time.tab.entries')], ['approvals', t('p6.time.tab.approvals')], ['live', t('p6.time.tab.live')]]} />
      {view === 'week' && <WeekGrid />}
      {view === 'entries' && <EntryList />}
      {view === 'approvals' && <Approvals />}
      {view === 'live' && <LiveActivity />}
      {logging && <LogTimeDialog onClose={() => setLogging(false)} />}
    </div>
  );
}

const useEntries = (query: { userId?: string; from?: string; to?: string; status?: TimeEntry['status']; limit?: number }) =>
  useQuery({ queryKey: ['time', 'entries', query], queryFn: () => unwrap(api.GET('/time/entries', { params: { query } })), placeholderData: keepPreviousData });

function WeekGrid() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const me = useMe().data;
  const [week, setWeek] = useState(weekOf(todayIst()));
  const [extra, setExtra] = useState<Array<Pick<GridRow, 'taskId' | 'clientId' | 'label' | 'sub'>>>([]);
  const [adding, setAdding] = useState(false);
  const list = useEntries({ userId: me?.id, from: week, to: addDaysIso(week, 6), limit: 1000 });
  const grid = buildGrid((list.data?.items ?? []).filter((e) => e.userId === me?.id), week, extra);
  const today = todayIst();
  const refresh = () => invalidateTime(qc);
  const cell = useMutation({
    mutationFn: async ({ row, day, minutes }: { row: GridRow; day: string; minutes: number }) => {
      const cur = row.cells[day]![0];
      if (cur && minutes === 0) return unwrap(api.DELETE('/time/entries/{id}', { params: { path: { id: cur.id } } }));
      if (cur) return unwrap(api.PATCH('/time/entries/{id}', { params: { path: { id: cur.id } }, body: { minutes, ...(cur.status === 'rejected' ? { status: 'draft' } : {}) } }));
      if (minutes > 0) return unwrap(api.POST('/time/entries', { body: { taskId: row.taskId, clientId: row.taskId ? undefined : row.clientId, workDate: day, minutes } }));
      return undefined;
    },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
    onSettled: refresh,
  });
  const submit = useMutation({
    mutationFn: () => unwrap(api.POST('/time/timesheets/submit', { body: { weekStart: week } })),
    onSuccess: (r) => toast({ text: t('p6.time.submitted', { count: r.submitted ?? 0 }), tone: 'ok' }, 4000),
    onError: (e) => toast({ text: err(e), tone: 'error' }),
    onSettled: refresh,
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" aria-label={t('p6.prevWeek')} onClick={() => setWeek(addDaysIso(week, -7))}><ChevronLeft size={14} /></button>
        <span className="font-medium">{t('p6.weekOf', { date: formatDate(week) })}</span>
        <button className="btn" aria-label={t('p6.nextWeek')} onClick={() => setWeek(addDaysIso(week, 7))}><ChevronRight size={14} /></button>
        <button className="btn" onClick={() => setAdding(true)}><Plus size={14} aria-hidden /> {t('p6.time.addRow')}</button>
        <button className="btn btn-primary ml-auto" disabled={!grid.draftCount || submit.isPending} onClick={() => submit.mutate()}>{t('p6.time.submitWeek', { count: grid.draftCount })}</button>
      </div>
      <div className="card overflow-auto">
        <table className="table w-full" aria-label={t('p6.time.tab.week')}>
          <thead><tr><th>{t('p6.f.task')}</th>{grid.days.map((d) => <th key={d} className="text-right">{formatDate(d).replace(/\s\d{4}$/, '')}</th>)}<th className="text-right">{t('p6.total')}</th></tr></thead>
          <tbody>
            {!grid.rows.length && <tr><td colSpan={9} className="text-muted">{t('p6.time.emptyWeek')}</td></tr>}
            {grid.rows.map((r) => (
              <tr key={r.key}>
                <td><div>{r.label || t('p6.time.internal')}</div>{r.sub && <div className="text-xs text-muted">{r.sub}</div>}</td>
                {grid.days.map((d) => {
                  const c = r.cells[d]!;
                  const sum = c.reduce((s, e) => s + e.minutes, 0);
                  const editable = cellEditable(c) && d <= today;
                  return (
                    <td key={d} className="text-right">
                      {editable ? (
                        <input className="input w-16 text-right tabular-nums" aria-label={t('p6.time.cellLabel', { row: r.label || t('p6.time.internal'), day: d })}
                          defaultValue={sum ? fmtMinutes(sum) : ''} key={`${d}:${sum}`}
                          onBlur={(e) => {
                            const m = parseMinutes(e.target.value);
                            if (m === null || m > 1440) { toast({ text: t('p6.time.badDuration'), tone: 'error' }); e.target.value = sum ? fmtMinutes(sum) : ''; return; }
                            if (m !== sum) cell.mutate({ row: r, day: d, minutes: m });
                          }} />
                      ) : (
                        <span className="tabular-nums" title={c.map((e) => t(`p6.status.${e.status}` as never)).join(', ')}>{sum ? fmtMinutes(sum) : ''}
                          {c.length > 0 && <span className="block text-xs text-muted">{c.length > 1 ? t('p6.time.nEntries', { count: c.length }) : t(`p6.status.${c[0]!.status}` as never)}</span>}</span>
                      )}
                    </td>
                  );
                })}
                <td className="text-right font-medium tabular-nums" data-testid={`row-total-${r.key}`}>{fmtMinutes(r.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr className="font-semibold"><td>{t('p6.total')}</td>{grid.days.map((d) => <td key={d} className="text-right tabular-nums">{fmtMinutes(grid.dayTotals[d] ?? 0)}</td>)}
            <td className="text-right tabular-nums" data-testid="week-total">{fmtMinutes(grid.total)}</td></tr></tfoot>
        </table>
      </div>
      <p className="text-xs text-muted">{t('p6.time.gridHint')}</p>
      {adding && <AddRowDialog onClose={() => setAdding(false)} onAdd={(r) => { setExtra((x) => [...x, r]); setAdding(false); }} />}
    </div>
  );
}

function AddRowDialog({ onClose, onAdd }: { onClose(): void; onAdd(r: Pick<GridRow, 'taskId' | 'clientId' | 'label' | 'sub'>): void }) {
  const t = useT();
  const [client, setClient] = useState<PickedClient | null>(null);
  const [task, setTask] = useState<{ id: string; title: string; clientId: string | null; clientName: string | null } | null>(null);
  return (
    <Dialog title={t('p6.time.addRow')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => {
        e.preventDefault();
        if (task) onAdd({ taskId: task.id, clientId: task.clientId, label: task.title, sub: task.clientName });
        else onAdd({ taskId: null, clientId: client?.id ?? null, label: client?.name ?? '', sub: null });
      }}>
        <ClientPicker label={t('p6.f.client')} value={client} onChange={(c) => { setClient(c); setTask(null); }} />
        <TaskSelect label={t('p6.f.task')} clientId={client?.id ?? null} value={task?.id ?? ''} onChange={(_, x) => setTask(x)} />
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary">{t('p6.add')}</button></div>
      </form>
    </Dialog>
  );
}

function EntryList() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const me = useMe().data;
  const [userId, setUserId] = useState<string | null>(null);
  const [from, setFrom] = useState(addDaysIso(todayIst(), -30));
  const [to, setTo] = useState(todayIst());
  const [status, setStatus] = useState('');
  const [reversing, setReversing] = useState<TimeEntry | null>(null);
  const list = useEntries({ userId: userId ?? undefined, from: from || undefined, to: to || undefined, status: (status || undefined) as TimeEntry['status'] | undefined, limit: 500 });
  const withdraw = useMutation({
    mutationFn: (id: string) => unwrap(api.PATCH('/time/entries/{id}', { params: { path: { id } }, body: { status: 'draft' } })),
    onError: (e) => toast({ text: err(e), tone: 'error' }), onSettled: () => invalidateTime(qc),
  });
  const del = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/time/entries/{id}', { params: { path: { id } } })),
    onError: (e) => toast({ text: err(e), tone: 'error' }), onSettled: () => invalidateTime(qc),
  });
  const items = list.data?.items ?? [];
  const reversed = new Set(items.map((e) => e.reversesId).filter(Boolean));
  return (
    <div className="space-y-2">
      <div className="card grid gap-2 p-3 sm:grid-cols-4">
        <PersonSelect label={t('p6.f.person')} value={userId} onChange={setUserId} />
        <Field label={t('p6.f.from')}><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('p6.f.to')}><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label={t('p6.f.status')}><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('tasks.f.any')}</option>{TIME_STATUSES.map((s) => <option key={s} value={s}>{t(`p6.status.${s}`)}</option>)}</select></Field>
      </div>
      <p className="text-sm text-muted" role="status">{t('p6.time.listTotals', { count: list.data?.total ?? 0, time: fmtMinutes(list.data?.totalMinutes ?? 0) })}</p>
      <div className="card overflow-auto"><table className="table w-full">
        <thead><tr><th>{t('p6.f.date')}</th><th>{t('p6.f.person')}</th><th>{t('p6.f.task')}</th><th className="text-right">{t('p6.f.duration')}</th><th>{t('p6.f.billable')}</th><th>{t('p6.f.status')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
        <tbody>{items.map((e) => (
          <tr key={e.id}>
            <td>{formatDate(e.workDate)}</td><td>{e.userName}</td>
            <td>{e.taskTitle ?? e.clientName ?? t('p6.time.internal')}{e.taskTitle && e.clientName && <span className="block text-xs text-muted">{e.clientName}</span>}
              {e.notes && <span className="block text-xs text-muted">{e.notes}</span>}{e.capped && <span className="ml-1 text-xs text-due-soon">{t('p6.time.capped')}</span>}
              {e.source === 'reversal' && <span className="ml-1 text-xs text-muted">{t('p6.time.reversal')}</span>}</td>
            <td className="text-right tabular-nums">{fmtMinutes(e.minutes)}</td><td>{e.billable ? t('svc.yes') : t('svc.no')}</td><td><StatusPill status={e.status} /></td>
            <td className="space-x-1 text-right whitespace-nowrap">
              {e.userId === me?.id && e.status === 'submitted' && <button className="btn" onClick={() => withdraw.mutate(e.id)}>{t('p6.time.withdraw')}</button>}
              {e.userId === me?.id && (e.status === 'draft' || e.status === 'rejected') && <button className="btn" onClick={() => del.mutate(e.id)}>{t('p6.delete')}</button>}
              {e.userId !== me?.id && e.status === 'approved' && e.source !== 'reversal' && !reversed.has(e.id) && <button className="btn" onClick={() => setReversing(e)}>{t('p6.time.reverse')}</button>}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      {reversing && <ReverseDialog e={reversing} onClose={() => setReversing(null)} />}
    </div>
  );
}

function ReverseDialog({ e, onClose }: { e: TimeEntry; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const [note, setNote] = useState('');
  const rev = useMutation({
    mutationFn: () => unwrap(api.POST('/time/entries/{id}/reverse', { params: { path: { id: e.id } }, body: { note: note.trim() } })),
    onSuccess: () => { invalidateTime(qc); onClose(); }, onError: (x) => toast({ text: err(x), tone: 'error' }),
  });
  return (
    <Dialog title={t('p6.time.reverseTitle')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(x) => { x.preventDefault(); rev.mutate(); }}>
        <p className="text-sm">{t('p6.time.reverseHint', { time: fmtMinutes(e.minutes), date: formatDate(e.workDate) })}</p>
        <Field label={t('p6.f.reason')}><textarea className="input" required minLength={3} value={note} onChange={(x) => setNote(x.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-danger" disabled={note.trim().length < 3 || rev.isPending}>{t('p6.time.reverse')}</button></div>
      </form>
    </Dialog>
  );
}

function Approvals() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const me = useMe().data;
  const list = useEntries({ status: 'submitted', limit: 500 });
  const items = list.data?.items ?? [];
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const approvable = items.filter((e) => e.userId !== me?.id);
  const decide = useMutation({
    mutationFn: (approve: boolean) => unwrap(api.POST('/time/entries/decide', { body: { ids: [...sel], approve, note: note.trim() || null } })),
    onSuccess: (r) => {
      const skipped = (r.results ?? []).filter((x) => x.reason);
      toast({ text: t('p6.time.decided', { approved: r.approved ?? 0, rejected: r.rejected ?? 0, skipped: skipped.length }), tone: skipped.length ? 'error' : 'ok' }, 5000);
      setSel(new Set()); setNote('');
    },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
    onSettled: () => invalidateTime(qc),
  });
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const total = items.filter((e) => sel.has(e.id)).reduce((s, e) => s + e.minutes, 0);
  return (
    <div className="space-y-2">
      <div className="card flex flex-wrap items-end gap-2 p-3">
        <label className="flex items-center gap-2"><input type="checkbox" aria-label={t('p6.selectAll')} checked={!!approvable.length && sel.size === approvable.length}
          onChange={(e) => setSel(e.target.checked ? new Set(approvable.map((x) => x.id)) : new Set())} /> {t('p6.selectAll')}</label>
        <span className="text-sm text-muted">{t('p6.time.selected', { count: sel.size, time: fmtMinutes(total) })}</span>
        <input className="input max-w-xs" aria-label={t('p6.f.note')} placeholder={t('p6.f.note')} value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn btn-primary" disabled={!sel.size || decide.isPending} onClick={() => decide.mutate(true)}>{t('p6.approve')}</button>
        <button className="btn btn-danger" disabled={!sel.size || decide.isPending} onClick={() => decide.mutate(false)}>{t('p6.reject')}</button>
      </div>
      {list.data && !items.length && <p className="card p-6 text-muted">{t('p6.nothingPending')}</p>}
      {!!items.length && <div className="card overflow-auto"><table className="table w-full">
        <thead><tr><th><span className="sr-only">{t('p6.select')}</span></th><th>{t('p6.f.person')}</th><th>{t('p6.f.date')}</th><th>{t('p6.f.task')}</th><th className="text-right">{t('p6.f.duration')}</th><th>{t('p6.f.billable')}</th></tr></thead>
        <tbody>{items.map((e) => {
          const own = e.userId === me?.id;
          return (
            <tr key={e.id} className={own ? 'text-muted' : ''}>
              <td><input type="checkbox" disabled={own} aria-label={t('p6.time.selectEntry', { who: e.userName ?? '', date: e.workDate })} checked={sel.has(e.id)} onChange={() => toggle(e.id)} /></td>
              <td>{e.userName}{own && <span className="block text-xs">{t('p6.selfNotApprovable')}</span>}</td><td>{formatDate(e.workDate)}</td>
              <td>{e.taskTitle ?? e.clientName ?? t('p6.time.internal')}{e.notes && <span className="block text-xs text-muted">{e.notes}</span>}</td>
              <td className="text-right tabular-nums">{fmtMinutes(e.minutes)}</td><td>{e.billable ? t('svc.yes') : t('svc.no')}</td>
            </tr>
          );
        })}</tbody>
      </table></div>}
    </div>
  );
}

export function LiveActivity() {
  const t = useT();
  const q = useQuery({ queryKey: ['time', 'live'], queryFn: () => as<{ asOf: string; items: LiveItem[] }>(api.GET('/activity/live')), refetchInterval: 30_000 });
  const items = q.data?.items ?? [];
  return (
    <div className="card overflow-auto">
      <table className="table w-full" aria-label={t('p6.time.tab.live')}>
        <thead><tr><th>{t('p6.f.person')}</th><th>{t('p6.live.on')}</th><th className="text-right">{t('p6.live.for')}</th></tr></thead>
        <tbody>
          {q.data && !items.length && <tr><td colSpan={3} className="text-muted">{t('p6.live.none')}</td></tr>}
          {items.map((x) => (
            <tr key={x.userId}><td>{x.userName}</td>
              <td>{x.label === 'Busy' ? <span className="text-muted">{t('p6.live.busy')}</span> : x.label}{x.task && x.client && <span className="block text-xs text-muted">{x.client.name}</span>}</td>
              <td className="text-right tabular-nums">{fmtMinutes(x.minutes)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
