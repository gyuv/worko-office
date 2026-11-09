import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@worko/i18n';
import { Check, ListTodo, MoonStar, Plus, Sparkles, SunMedium } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { openQuickAdd } from '../components/QuickAdd';
import { toast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { useCan, useMe } from '../lib/me';
import { api, unwrap } from '../lib/session';
import { myDay } from './home-logic';
import { moveError, type Task } from './tasks/logic';

type Patch = { status?: 'done'; act_by?: string };

/** One-tap daily list: tick to finish, moon to push to tomorrow, both undoable. */
export function MyDay({ items, now, loading, style }: { items: Task[]; now: number; loading: boolean; style?: CSSProperties }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe().data;
  const can = useCan();
  const day = myDay(items, me?.id, new Date(now));
  const [leaving, setLeaving] = useState<Record<string, 'done' | 'snooze'>>({});
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['dash'] }); void qc.invalidateQueries({ queryKey: ['tasks'] }); };

  const apply = useMutation({
    mutationFn: ({ task, patch }: { task: Task; patch: Patch }) => unwrap(api.POST('/tasks/bulk', { body: { ids: [task.id], patch } })),
    onSuccess: (r, { task, patch }) => {
      if (r.applied === 0) { setLeaving((l) => { const n = { ...l }; delete n[task.id]; return n; }); toast({ text: r.failed[0]?.reason ?? t('common.error'), tone: 'error' }); return; }
      setTimeout(refresh, 600);
      const token = r.undoToken;
      toast({
        text: patch.status ? t('myday.done', { title: task.title }) : t('myday.snoozed'), tone: 'ok',
        action: token ? { label: t('myday.undo'), run: () => { void api.POST('/tasks/bulk/undo', { body: { undoToken: token } }).then(() => { setLeaving((l) => { const n = { ...l }; delete n[task.id]; return n; }); refresh(); }); } } : undefined,
      }, 6000);
    },
    onError: (_e, { task }) => { setLeaving((l) => { const n = { ...l }; delete n[task.id]; return n; }); toast({ text: t('common.error'), tone: 'error' }); },
  });

  const complete = (task: Task) => {
    if (moveError(task, 'done')) { toast({ text: t('myday.needsDetail') }, 3000); location.hash = `#/tasks/${task.id}`; return; }
    setLeaving((l) => ({ ...l, [task.id]: 'done' }));
    apply.mutate({ task, patch: { status: 'done' } });
  };
  const snooze = (task: Task) => { setLeaving((l) => ({ ...l, [task.id]: 'snooze' })); apply.mutate({ task, patch: { act_by: day.tomorrow } }); };

  const cleared = day.doneToday + Object.values(leaving).filter((v) => v === 'done').length;
  const total = cleared + [...day.overdue, ...day.todayList].filter((x) => !leaving[x.id]).length;
  const pct = total ? Math.min(1, cleared / total) : 1;
  const empty = !loading && day.overdue.length + day.todayList.length + day.upcoming.length === 0;
  const canEdit = can('tasks', 'edit');

  const Row = ({ x, late }: { x: Task; late?: boolean }) => {
    const gone = leaving[x.id];
    const d = x.actBy ?? x.statutoryDue;
    return (
      <li className={`group flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-surface-alt ${gone ? 'leave' : ''}`}>
        <button type="button" disabled={!canEdit || !!gone} onClick={() => complete(x)} aria-label={t('myday.complete', { title: x.title })} data-on={gone === 'done' ? 1 : 0}
          className={`done-check flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-200 ${gone === 'done' ? 'border-primary bg-primary text-primary-fg' : 'border-border hover:scale-110 hover:border-primary'}`}>
          {gone === 'done' ? <Check size={14} strokeWidth={3} className="check-pop" aria-hidden /> : <Check size={12} strokeWidth={3} aria-hidden className="text-primary opacity-0 transition-opacity group-hover:opacity-60" />}
        </button>
        <a href={`#/tasks/${x.id}`} className="min-w-0 flex-1">
          <span className="strike block truncate font-medium" data-on={gone === 'done' ? 1 : 0}>{x.title}</span>
          <span className={`block truncate text-xs ${late ? 'font-medium text-overdue' : 'text-muted'}`}>
            {[x.clientName, d ? formatDate(d) : null].filter(Boolean).join(' · ')}
            {(x.priority === 'urgent' || x.priority === 'high') && <span className="ml-1.5 font-semibold text-amber-700 dark:text-amber-300">{t(`tasks.priority.${x.priority}`)}</span>}
          </span>
        </a>
        {canEdit && !gone && (
          <button type="button" className="icon-btn h-8 w-8 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100" aria-label={t('myday.snooze')} title={t('myday.snooze')} onClick={() => snooze(x)}>
            <MoonStar size={15} aria-hidden />
          </button>
        )}
      </li>
    );
  };
  const Group = ({ label, list, late }: { label: string; list: Task[]; late?: boolean }) => list.length === 0 ? null : (
    <div>
      <div className={`px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider ${late ? 'text-overdue' : 'text-muted'}`}>{label} · {list.length}</div>
      <ul className="space-y-0.5">{list.map((x) => <Row key={x.id} x={x} late={late} />)}</ul>
    </div>
  );

  const R = 18; const C = 2 * Math.PI * R;
  return (
    <section className="tile rise min-w-0" style={style} aria-label={t('myday.title')}>
      <div className="mb-3 flex items-center gap-3">
        <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden className="-rotate-90 shrink-0">
          <circle cx="22" cy="22" r={R} fill="none" stroke="var(--w-border)" strokeWidth="5" />
          <circle cx="22" cy="22" r={R} fill="none" stroke="var(--w-primary)" strokeWidth="5" strokeLinecap="round"
            strokeDasharray={`${loading ? 0 : pct * C} ${C}`} style={{ transition: 'stroke-dasharray .8s cubic-bezier(.2,.7,.2,1)' }} />
        </svg>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-[17px] font-semibold"><SunMedium size={17} aria-hidden className="text-primary" /> {t('myday.title')}</h2>
          <p className="text-xs text-muted">{t('myday.sub', { done: cleared, total })}</p>
        </div>
        {can('tasks', 'create') && <button type="button" className="btn btn-primary py-1.5 text-sm" onClick={openQuickAdd} title={t('quick.button')}><Plus size={14} aria-hidden /> {t('quick.add')}</button>}
      </div>
      {loading ? <div className="space-y-2">{[0, 1, 2].map((k) => <div key={k} className="skeleton h-10" />)}</div> : empty ? (
        <div className="float-up flex flex-col items-center py-6 text-center">
          <span className="breathe flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary"><Sparkles size={22} aria-hidden /></span>
          <div className="mt-3 font-semibold">{t('myday.empty')}</div>
          <div className="text-sm text-muted">{t('myday.emptyHint')}</div>
        </div>
      ) : (
        <div className="space-y-3">
          <Group label={t('myday.overdue')} list={day.overdue} late />
          <Group label={t('myday.today')} list={day.todayList} />
          <Group label={t('myday.upcoming')} list={day.upcoming} />
        </div>
      )}
      <a href={`#/tasks?assignee=${me?.id ?? ''}`} className="mt-3 inline-flex items-center gap-1.5 px-2 text-sm font-medium text-primary hover:underline"><ListTodo size={14} aria-hidden /> {t('myday.all')}</a>
    </section>
  );
}
