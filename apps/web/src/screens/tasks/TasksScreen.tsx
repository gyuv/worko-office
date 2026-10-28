import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TASK_STATUSES, type TaskStatus } from '@worko/domain';
import { formatDate, type MessageKey } from '@worko/i18n';
import { ChevronLeft, ChevronRight, Plus, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst, useDebounced } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api, unwrap } from '../../lib/session';
import { AutoCreateWizard } from './AutoCreateWizard';
import { BulkBar } from './BulkBar';
import { NewTaskDialog } from './NewTaskDialog';
import { TaskDrawer } from './TaskDrawer';
import {
  addDays, ganttBar, isOverdue, KANBAN_COLUMNS, kanbanColumns, monthGrid, monthRange, moveError, shiftMonth, sprintBuckets, type Task,
} from './logic';
import { usePriorityLabel, useRuleMessage, useServiceTypes, useStatusLabel, useUsers } from './shared';

type View = 'list' | 'kanban' | 'calendar' | 'gantt' | 'sprint';

export function TasksScreen() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const today = todayIst();
  const statusLabel = useStatusLabel();
  const ruleMsg = useRuleMessage();
  const { users, name } = useUsers();
  const services = useServiceTypes();
  const [view, setView] = useState<View>('list');
  const [status, setStatus] = useState('');
  const [assignee, setAssignee] = useState('');
  const [client, setClient] = useState<PickedClient | null>(null);
  const [service, setService] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [auto, setAuto] = useState(false);

  const query = { status: status || undefined, assigneeId: assignee || undefined, clientId: client?.id, serviceTypeId: service || undefined, overdue: overdue ? 'true' as const : undefined, asOf: overdue ? today : undefined, closed: 'false' as const, q: dq || undefined, limit: 500 };
  const list = useQuery({ queryKey: ['tasks', query], queryFn: () => unwrap(api.GET('/tasks', { params: { query } })), placeholderData: (p) => p });
  const tasks = list.data?.items ?? [];

  const move = useMutation({
    mutationFn: ({ task, to, pendingIssue }: { task: Task; to: TaskStatus; pendingIssue?: string }) =>
      unwrap(api.PATCH('/tasks/{id}', { params: { path: { id: task.id } }, body: { status: to, ...(pendingIssue ? { pending_issue: pendingIssue } : {}) } })),
    onError: (e) => toast({ text: ruleMsg(e), tone: 'error' }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
  /** Drag/drop or menu status change; asks for the pending issue when moving to "waiting for client". */
  const changeStatus = (task: Task, to: TaskStatus) => {
    if (task.status === to) return;
    let pendingIssue: string | undefined;
    let why = moveError(task, to);
    if (why === 'pending_issue_required') {
      pendingIssue = prompt(t('tasks.pendingIssuePrompt'))?.trim() || undefined;
      if (!pendingIssue) return;
      why = moveError(task, to, { pendingIssue });
    }
    if (why) { toast({ text: ruleMsg({ code: why }), tone: 'error' }); return; }
    move.mutate({ task, to, pendingIssue });
  };

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const views: Array<[View, string]> = [['list', t('tasks.view.list')], ['kanban', t('tasks.view.kanban')], ['calendar', t('tasks.view.calendar')], ['gantt', t('tasks.view.gantt')], ['sprint', t('tasks.view.sprint')]];
  const card = (task: Task) => <TaskCard key={task.id} task={task} today={today} onOpen={() => setOpenId(task.id)} assignee={name(task.assigneeId)} />;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t('nav.tasks')}</h1>
        <span className="text-sm text-muted">{t('tasks.count', { count: list.data?.total ?? 0 })}</span>
        <div className="ml-auto flex gap-2">
          {can('tasks', 'create') && <button className="btn" onClick={() => setAuto(true)}><Wand2 size={14} aria-hidden /> {t('tasks.auto.open')}</button>}
          {can('tasks', 'create') && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={14} aria-hidden /> {t('tasks.new')}</button>}
        </div>
      </header>
      <Tabs<View> label={t('tasks.views')} tabs={views} value={view} onChange={setView} />
      <div className="flex flex-wrap items-end gap-2">
        <input type="search" aria-label={t('common.search')} placeholder={t('tasks.searchPlaceholder')} className="input max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="text-sm"><span className="label">{t('tasks.f.status')}</span>
          <select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('tasks.f.any')}</option>
            {TASK_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select></label>
        <label className="text-sm"><span className="label">{t('tasks.f.assignee')}</span>
          <select className="input w-40" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{t('tasks.f.any')}</option><option value="me">{t('tasks.f.me')}</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></label>
        <label className="text-sm"><span className="label">{t('tasks.f.service')}</span>
          <select className="input w-44" value={service} onChange={(e) => setService(e.target.value)}>
            <option value="">{t('tasks.f.any')}</option>
            {(services.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
        <div className="w-56"><ClientPicker label={t('tasks.f.client')} value={client} onChange={setClient} /></div>
        <label className="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> {t('tasks.f.overdue')}</label>
      </div>

      {selected.size > 0 && can('tasks', 'edit') && <BulkBar ids={[...selected]} onDone={() => setSelected(new Set())} />}
      {list.isError && <p role="alert" className="text-overdue">{t('common.error')}</p>}

      {view === 'list' && (tasks.length === 0 && list.data ? <p className="card p-6 text-muted">{t('tasks.empty')}</p> : (
        <div className="card overflow-auto">
          <table className="table w-full">
            <thead><tr>
              <th><input type="checkbox" aria-label={t('tasks.selectAll')} checked={tasks.length > 0 && tasks.every((x) => selected.has(x.id))}
                onChange={(e) => setSelected(e.target.checked ? new Set(tasks.map((x) => x.id)) : new Set())} /></th>
              <th>{t('tasks.title')}</th><th>{t('tasks.f.client')}</th><th>{t('tasks.f.status')}</th><th>{t('tasks.f.assignee')}</th><th>{t('tasks.actBy')}</th><th>{t('tasks.statutoryDue')}</th><th>{t('tasks.priority')}</th>
            </tr></thead>
            <tbody>
              {tasks.map((x) => (
                <tr key={x.id} className={selected.has(x.id) ? 'bg-surface-alt' : ''}>
                  <td><input type="checkbox" aria-label={t('tasks.select', { title: x.title })} checked={selected.has(x.id)} onChange={() => toggle(x.id)} /></td>
                  <td><button className="text-left underline-offset-2 hover:underline" onClick={() => setOpenId(x.id)}>{x.title}</button>{x.periodLabel && <div className="text-xs text-muted">{x.serviceName} · {x.periodLabel}</div>}</td>
                  <td>{x.clientId ? <a className="underline" href={`#/clients/${x.clientId}`}>{x.clientName}</a> : <span className="text-muted">{t('tasks.firmTask')}</span>}</td>
                  <td>{statusLabel(x.status)}</td>
                  <td>{name(x.assigneeId)}</td>
                  <td className={isOverdue(x, today) ? 'font-medium text-overdue' : ''}>{x.actBy ? formatDate(x.actBy) : '—'}</td>
                  <td>{x.statutoryDue ? formatDate(x.statutoryDue) : '—'}</td>
                  <td><PriorityBadge p={x.priority} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {view === 'kanban' && <Kanban tasks={tasks} canEdit={can('tasks', 'edit')} onMove={changeStatus} card={card} />}
      {view === 'calendar' && <CalendarView onOpen={setOpenId} />}
      {view === 'gantt' && <Gantt tasks={tasks} today={today} onOpen={setOpenId} />}
      {view === 'sprint' && (
        <div className="grid gap-3 md:grid-cols-5">
          {Object.entries(sprintBuckets(tasks, today)).map(([b, items]) => (
            <section key={b} aria-label={t(`tasks.sprint.${b}` as MessageKey)} className="card p-2">
              <h2 className={`mb-2 text-sm font-semibold ${b === 'overdue' ? 'text-overdue' : ''}`}>{t(`tasks.sprint.${b}` as MessageKey)} <span className="text-muted">({items.length})</span></h2>
              <div className="space-y-2">{items.map(card)}</div>
            </section>
          ))}
        </div>
      )}

      {openId && <TaskDrawer id={openId} onClose={() => setOpenId(null)} />}
      {creating && <NewTaskDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); void qc.invalidateQueries({ queryKey: ['tasks'] }); }} />}
      {auto && <AutoCreateWizard onClose={() => { setAuto(false); void qc.invalidateQueries({ queryKey: ['tasks'] }); }} />}
    </div>
  );
}

export function PriorityBadge({ p }: { p: string }) {
  const label = usePriorityLabel();
  const tone = p === 'urgent' ? 'text-overdue font-semibold' : p === 'high' ? 'text-due-soon' : 'text-muted';
  return <span className={`text-xs ${tone}`}>{label(p)}</span>;
}

function TaskCard({ task, today, onOpen, assignee }: { task: Task; today: string; onOpen(): void; assignee: string }) {
  const t = useT();
  const done = task.checks.filter((c) => c.done).length;
  return (
    <button type="button" onClick={onOpen} className="block w-full rounded border border-border bg-surface p-2 text-left text-sm hover:border-primary" data-task-id={task.id}>
      <div className="font-medium">{task.title}</div>
      <div className="text-xs text-muted">{task.clientName ?? t('tasks.firmTask')}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        {task.actBy && <span className={isOverdue(task, today) ? 'text-overdue' : 'text-muted'}>{t('tasks.actBy')} {formatDate(task.actBy)}</span>}
        {task.checks.length > 0 && <span className="text-muted">{done}/{task.checks.length}</span>}
        <span className="text-muted">{assignee}</span>
        <PriorityBadge p={task.priority} />
      </div>
    </button>
  );
}

function Kanban({ tasks, canEdit, onMove, card }: { tasks: Task[]; canEdit: boolean; onMove(t: Task, to: TaskStatus): void; card(t: Task): JSX.Element }) {
  const t = useT();
  const statusLabel = useStatusLabel();
  const cols = kanbanColumns(tasks);
  const [over, setOver] = useState<string | null>(null);
  const byId = new Map(tasks.map((x) => [x.id, x]));
  return (
    <div className="grid gap-3 overflow-auto md:grid-cols-5">
      {KANBAN_COLUMNS.map((c) => (
        <section key={c} aria-label={statusLabel(c)} data-column={c}
          className={`card min-h-40 p-2 ${over === c ? 'ring-2 ring-primary' : ''}`}
          onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(c); } }} onDragLeave={() => setOver(null)}
          onDrop={(e) => { e.preventDefault(); setOver(null); const task = byId.get(e.dataTransfer.getData('text/task-id')); if (task) onMove(task, c); }}>
          <h2 className="mb-2 text-sm font-semibold">{statusLabel(c)} <span className="text-muted">({cols[c].length})</span></h2>
          <div className="space-y-2">
            {cols[c].map((x) => (
              <div key={x.id} draggable={canEdit} onDragStart={(e) => { e.dataTransfer.setData('text/task-id', x.id); e.dataTransfer.effectAllowed = 'move'; }}>
                {card(x)}
                {canEdit && (
                  <label className="sr-only">{t('tasks.moveTo', { title: x.title })}
                    <select value={x.status} onChange={(e) => onMove(x, e.target.value as TaskStatus)}>
                      {KANBAN_COLUMNS.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                    </select></label>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CalendarView({ onOpen }: { onOpen(id: string): void }) {
  const t = useT();
  const today = todayIst();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [field, setField] = useState<'act_by' | 'statutory_due'>('act_by');
  const { from, to } = monthRange(month);
  const cal = useQuery({ queryKey: ['tasks', 'calendar', from, to, field], queryFn: () => unwrap(api.GET('/tasks/calendar', { params: { query: { from, to, field } } })) });
  const byDate = useMemo(() => new Map((cal.data?.days ?? []).map((d) => [d.date, d.tasks])), [cal.data]);
  const weekdays = monthGrid(month)[0]!.map((d) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" aria-label={t('tasks.cal.prev')} onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={14} /></button>
        <span className="min-w-32 text-center font-medium">{new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}</span>
        <button className="btn" aria-label={t('tasks.cal.next')} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={14} /></button>
        <Tabs<'act_by' | 'statutory_due'> label={t('tasks.cal.field')} tabs={[['act_by', t('tasks.actBy')], ['statutory_due', t('tasks.statutoryDue')]]} value={field} onChange={setField} />
      </div>
      <div className="card grid grid-cols-7 overflow-hidden text-xs">
        {weekdays.map((w) => <div key={w} className="border-b border-border bg-surface-alt p-1 font-semibold">{w}</div>)}
        {monthGrid(month).flat().map((d) => (
          <div key={d} className={`min-h-20 border-b border-r border-border p-1 ${d.slice(0, 7) !== month ? 'text-muted opacity-60' : ''} ${d === today ? 'bg-surface-alt' : ''}`}>
            <div className="font-medium">{Number(d.slice(8))}</div>
            {(byDate.get(d) ?? []).slice(0, 4).map((x) => (
              <button key={x.id} onClick={() => onOpen(x.id)} className={`block w-full truncate text-left hover:underline ${isOverdue(x, today) ? 'text-overdue' : ''}`} title={x.title}>{x.clientName ? `${x.clientName}: ` : ''}{x.title}</button>
            ))}
            {(byDate.get(d)?.length ?? 0) > 4 && <div className="text-muted">{t('tasks.cal.more', { count: byDate.get(d)!.length - 4 })}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Gantt({ tasks, today, onOpen }: { tasks: Task[]; today: string; onOpen(id: string): void }) {
  const t = useT();
  const days = 42;
  const from = addDays(today, -14);
  const rows = tasks.map((x) => [x, ganttBar(x, from, days)] as const).filter(([, b]) => b);
  const todayOff = 14;
  if (!rows.length) return <p className="card p-6 text-muted">{t('tasks.gantt.empty')}</p>;
  return (
    <div className="card overflow-auto p-2">
      <div className="mb-1 flex text-xs text-muted"><div className="w-56 shrink-0" /><div className="relative flex-1">{formatDate(from)} – {formatDate(addDays(from, days - 1))}</div></div>
      {rows.map(([x, b]) => (
        <div key={x.id} className="flex items-center border-t border-border py-1 text-sm">
          <button className="w-56 shrink-0 truncate pr-2 text-left hover:underline" onClick={() => onOpen(x.id)} title={x.title}>{x.title}</button>
          <div className="relative h-4 flex-1">
            <div className="absolute inset-y-0 w-px bg-primary" style={{ left: `${(todayOff / days) * 100}%` }} aria-hidden />
            <div className={`absolute inset-y-0.5 rounded ${isOverdue(x, today) ? 'bg-overdue' : x.status === 'done' ? 'bg-done' : 'bg-primary'} opacity-80`}
              style={{ left: `${(b!.offset / days) * 100}%`, width: `${(b!.span / days) * 100}%` }} title={`${x.title} → ${x.actBy ?? x.statutoryDue}`} />
          </div>
        </div>
      ))}
    </div>
  );
}
