import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@worko/i18n';
import { ArrowUpRight, CalendarDays, CheckCircle2, Clock3, Pause, Play, Plus, Square, TrendingUp, Upload, Video } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { initials } from '../components/Shell';
import { toast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { useCan, useMe } from '../lib/me';
import { api, unwrap } from '../lib/session';
import { useSync } from '../lib/sync';
import { as, type Timer } from './hr/api';
import { fmtMinutes } from './hr/logic';
import { DashboardView } from './reports/Dashboard';
import type { Task } from './tasks/logic';
import { elapsed, startTimerFor } from './time/TimerWidget';
import { invalidateTime } from './time/shared';
import { dashboardStats, weekBars } from './home-logic';

/** Staggered entrance: each card rises in a little after the previous one. */
const delay = (i: number): CSSProperties => ({ animationDelay: `${i * 60}ms` });

/** Counts up from 0 to `to` once (ease-out); jumps straight there when the user prefers reduced motion. */
export function useCountUp(to: number, ms = 900) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) { setV(to); return; }
    let raf = 0; const t0 = performance.now();
    const tick = (now: number) => { const p = Math.min(1, (now - t0) / ms); setV(Math.round(to * (1 - (1 - p) ** 3))); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, ms]);
  return v;
}

function useNow(everyMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(id); }, [everyMs]);
  return now;
}

export function HomeScreen() {
  const t = useT();
  const me = useMe().data;
  const can = useCan();
  const now = useNow(30_000);
  const canTasks = can('tasks', 'view');
  const tv = useSync((s) => s.versions.task ?? 0);
  const tasks = useQuery({
    queryKey: ['dash', 'tasks', tv], enabled: canTasks, placeholderData: (p) => p,
    queryFn: () => unwrap(api.GET('/tasks', { params: { query: { limit: 1000 } } })),
  });
  const items = useMemo(() => ((tasks.data?.items ?? []) as Task[]).filter((x) => x.status !== 'cancelled'), [tasks.data]);
  const stats = useMemo(() => dashboardStats(items, new Date(now)), [items, now]);
  const h = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date(now)));
  const partOfDay = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  const loading = canTasks && !tasks.data;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 rounded-2xl border border-border bg-surface p-4 md:p-6">
      <div className="rise flex flex-wrap items-end gap-3">
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
          <h1 className="text-[28px] font-bold leading-tight tracking-tight">{t('dash.title')}</h1>
          <h2 className="mt-1 text-[13px] font-normal text-muted">
            {t('home.greeting', { partOfDay, name: me?.name.split(' ')[0] ?? '' })} · {new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(now))}
          </h2>
        </div>
        {canTasks && <a href="#/tasks" className="btn btn-primary px-5 py-2.5"><Plus size={16} aria-hidden /> {t('dash.addTask')}</a>}
        <a href="#/clients/import" className="btn px-5 py-2.5"><Upload size={15} aria-hidden /> {t('dash.import')}</a>
      </div>

      {canTasks && (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          <StatCard i={0} hero label={t('dash.stat.total')} value={stats.total} loading={loading} href="#/tasks"
            note={<><TrendingUp size={12} aria-hidden /> {t('dash.stat.newThisMonth', { n: stats.createdThisMonth })}</>} />
          <StatCard i={1} label={t('dash.stat.done')} value={stats.done} loading={loading} href="#/tasks"
            note={<><CheckCircle2 size={12} aria-hidden /> {t('dash.stat.doneThisMonth', { n: stats.doneThisMonth })}</>} />
          <StatCard i={2} label={t('dash.stat.running')} value={stats.running} loading={loading} href="#/tasks"
            note={<><Clock3 size={12} aria-hidden /> {t('dash.stat.overdue', { n: stats.overdue })}</>} />
          <StatCard i={3} label={t('dash.stat.pending')} value={stats.pendingClient} loading={loading} href="#/tasks"
            note={t('dash.stat.onClient')} />
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr_1fr]">
        {canTasks && <Analytics i={4} items={items} now={now} loading={loading} />}
        <Reminder i={5} />
        {canTasks && <DueSoon i={6} items={items} now={now} loading={loading} />}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr_1fr]">
        {can('users', 'view') && <Team i={7} items={items} />}
        {canTasks && <Progress i={8} stats={stats} loading={loading} />}
        {can('time', 'view') && <TimeTracker i={9} />}
      </div>

      {can('reports', 'view') && <div className="rise" style={delay(10)}><DashboardView /></div>}
    </div>
  );
}

function StatCard({ i, hero, label, value, note, href, loading }: { i: number; hero?: boolean; label: string; value: number; note: ReactNode; href: string; loading: boolean }) {
  const n = useCountUp(loading ? 0 : value);
  return (
    <a href={href} className={`tile tile-hover rise group block ${hero ? 'hero' : ''}`} style={delay(i)}>
      <div className="flex items-start justify-between">
        <span className={`text-[13px] font-semibold sm:text-[15px] ${hero ? 'text-white' : ''}`}>{label}</span>
        <span aria-hidden className={`flex h-8 w-8 items-center justify-center rounded-full border transition-transform duration-200 group-hover:rotate-45 ${hero ? 'border-white/30 bg-white text-primary' : 'border-border'}`}>
          <ArrowUpRight size={16} />
        </span>
      </div>
      {loading ? <div className="skeleton mt-4 h-12 w-20" /> : <div className="mt-3 text-[32px] font-bold leading-none tabular-nums sm:text-[44px]" data-testid={`stat-${label}`}>{n}</div>}
      <div className={`mt-4 flex items-center gap-1.5 text-xs ${hero ? 'text-white/80' : 'text-muted'}`}>
        <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ${hero ? 'bg-white/15' : 'bg-primary-soft text-primary'}`}>{note}</span>
      </div>
    </a>
  );
}

function Card({ i, title, action, children, className = '' }: { i: number; title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`tile rise min-w-0 ${className}`} style={delay(i)} aria-label={title}>
      <div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-[17px] font-semibold">{title}</h2>{action}</div>
      {children}
    </section>
  );
}

function Analytics({ i, items, now, loading }: { i: number; items: Task[]; now: number; loading: boolean }) {
  const t = useT();
  const bars = useMemo(() => weekBars(items, new Date(now)), [items, now]);
  const max = Math.max(1, ...bars.map((b) => b.count));
  const best = bars.reduce((a, b) => (b.count > a.count ? b : a), bars[0]!);
  const total = bars.reduce((s, b) => s + b.count, 0);
  const [hover, setHover] = useState<number | null>(null);
  const shades = ['bg-primary', 'bg-accent', 'bg-primary-strong'];
  return (
    <Card i={i} title={t('dash.analytics')} action={<span className="pill bg-primary-soft text-primary">{t('dash.analyticsDone', { n: total })}</span>}>
      {!loading && total === 0 && <p className="-mt-2 mb-2 text-xs text-muted">{t('dash.analyticsEmpty')}</p>}
      <div className="flex h-48 items-end justify-between gap-2 pt-6 sm:gap-3" role="img" aria-label={t('dash.analyticsAria', { list: bars.map((b) => `${b.label}: ${b.count}`).join(', ') })}>
        {bars.map((b, k) => {
          const pct = loading ? 30 : Math.max(18, Math.round((b.count / max) * 100));
          const tip = hover === k || (hover === null && b === best && b.count > 0);
          return (
            <div key={b.label + k} className="flex h-full flex-1 flex-col items-center justify-end gap-2" onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
              <div className="relative flex w-full max-w-[52px] flex-1 items-end">
                {tip && !b.future && <span className="absolute -top-1 left-1/2 z-10 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-semibold shadow-sm">{b.count}</span>}
                <div className={`grow w-full rounded-full ${b.future || b.count === 0 ? 'border border-border' : shades[k % 3]} ${b.today ? 'ring-2 ring-primary ring-offset-2 ring-offset-surface' : ''}`}
                  style={{ height: `${pct}%`, animationDelay: `${120 + k * 70}ms` }}>
                  {(b.future || b.count === 0) && <div className="stripes h-full w-full rounded-full" />}
                </div>
              </div>
              <span className={`text-xs ${b.today ? 'font-bold text-primary' : 'text-muted'}`}>{b.label}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

type CalItem = { id?: string; title?: string; startsAt?: string; endsAt?: string; allDay?: boolean; source?: string; clientName?: string | null };

function Reminder({ i }: { i: number }) {
  const t = useT();
  const today = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const cal = useQuery({ queryKey: ['dash', 'calendar', today], queryFn: () => unwrap(api.GET('/calendar/events', { params: { query: { from: today, to } } })) as Promise<CalItem[]> });
  const next = (cal.data ?? []).filter((e) => e.source === 'event' && e.startsAt && Date.parse(e.endsAt ?? e.startsAt) > Date.now())
    .sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!))[0];
  const time = (s: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(s));
  return (
    <Card i={i} title={t('dash.reminders')} className="flex flex-col">
      {!cal.data ? <><div className="skeleton h-14 w-full" /><div className="skeleton mt-3 h-4 w-1/2" /></> : next ? (
        <div className="flex flex-1 flex-col">
          <div className="text-[22px] font-bold leading-tight text-primary">{next.title}</div>
          <div className="mt-2 text-sm text-muted">
            {next.allDay ? formatDate(next.startsAt!) : `${formatDate(next.startsAt!)} · ${time(next.startsAt!)}${next.endsAt ? ` – ${time(next.endsAt)}` : ''}`}
            {next.clientName ? ` · ${next.clientName}` : ''}
          </div>
          <a href="#/calendar" className="btn btn-primary mt-auto justify-center py-2.5 text-[15px]"><Video size={16} aria-hidden /> {t('dash.openMeeting')}</a>
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          <div className="text-[20px] font-bold leading-tight">{t('dash.noReminders')}</div>
          <div className="mt-2 text-sm text-muted">{t('dash.noRemindersHint')}</div>
          <a href="#/calendar" className="btn mt-auto justify-center py-2.5"><CalendarDays size={16} aria-hidden /> {t('dash.openCalendar')}</a>
        </div>
      )}
    </Card>
  );
}

const DOTS = ['bg-blue-500', 'bg-teal-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-violet-500'];

function DueSoon({ i, items, now, loading }: { i: number; items: Task[]; now: number; loading: boolean }) {
  const t = useT();
  const today = new Date(now).toISOString().slice(0, 10);
  const due = items.filter((x) => x.status !== 'done' && (x.actBy ?? x.statutoryDue))
    .sort((a, b) => (a.actBy ?? a.statutoryDue ?? '').localeCompare(b.actBy ?? b.statutoryDue ?? '')).slice(0, 5);
  return (
    <Card i={i} title={t('dash.dueSoon')} action={<a href="#/tasks" className="btn py-1 text-sm"><Plus size={14} aria-hidden /> {t('dash.new')}</a>}>
      {loading ? <div className="space-y-3">{[0, 1, 2, 3].map((k) => <div key={k} className="skeleton h-9" />)}</div> : due.length === 0 ? <p className="text-muted">{t('dash.nothingDue')}</p> : (
        <ul className="space-y-3">
          {due.map((x, k) => {
            const d = x.actBy ?? x.statutoryDue!;
            const late = d < today;
            return (
              <li key={x.id}>
                <a href={`#/tasks/${x.id}`} className="group flex items-center gap-3 rounded-lg transition-colors">
                  <span aria-hidden className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${DOTS[k % DOTS.length]} text-xs font-bold text-white transition-transform group-hover:scale-110`}>{initials(x.clientName ?? x.title)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium group-hover:text-primary">{x.title}</span>
                    <span className={`block text-xs ${late ? 'font-medium text-overdue' : 'text-muted'}`}>{late ? t('dash.overdueSince', { date: formatDate(d) }) : t('dash.dueOn', { date: formatDate(d) })}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

type User = { id: string; name: string; email: string; status: string; roles: string[] };
const STATUS_PILL: Record<string, string> = {
  done: 'bg-primary-soft text-primary', in_progress: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  review: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200', pending_client: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  open: 'bg-surface-alt text-muted',
};
const AVATAR = ['from-rose-400 to-orange-300', 'from-emerald-500 to-lime-300', 'from-sky-500 to-indigo-400', 'from-amber-400 to-yellow-200', 'from-fuchsia-500 to-pink-300'];

function Team({ i, items }: { i: number; items: Task[] }) {
  const t = useT();
  const users = useQuery({ queryKey: ['users'], queryFn: () => unwrap(api.GET('/users')) as Promise<User[]> });
  const order = ['in_progress', 'review', 'pending_client', 'open', 'done'];
  const rows = (users.data ?? []).filter((u) => u.status !== 'disabled').map((u) => {
    const mine = items.filter((x) => x.assigneeId === u.id).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    return { u, task: mine[0] };
  }).sort((a, b) => (a.task ? order.indexOf(a.task.status) : 9) - (b.task ? order.indexOf(b.task.status) : 9)).slice(0, 5);
  return (
    <Card i={i} title={t('dash.team')} action={<a href="#/team" className="btn py-1 text-sm"><Plus size={14} aria-hidden /> {t('dash.addMember')}</a>}>
      {!users.data ? <div className="space-y-3">{[0, 1, 2, 3].map((k) => <div key={k} className="skeleton h-10" />)}</div> : (
        <ul className="space-y-3">
          {rows.map(({ u, task }, k) => (
            <li key={u.id} className="flex items-center gap-3">
              <span aria-hidden className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${AVATAR[k % AVATAR.length]} text-sm font-bold text-white`}>{initials(u.name)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{u.name}</span>
                <span className="block truncate text-xs text-muted">{task ? <>{t('dash.workingOn')} <span className="font-medium text-fg">{task.title}</span></> : t('dash.free')}</span>
              </span>
              {task && <span className={`pill shrink-0 ${STATUS_PILL[task.status] ?? STATUS_PILL.open}`}>{t(`tasks.status.${task.status}` as never)}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Progress({ i, stats, loading }: { i: number; stats: ReturnType<typeof dashboardStats>; loading: boolean }) {
  const t = useT();
  const total = Math.max(1, stats.total);
  const done = stats.done / total; const running = stats.running / total;
  const pct = useCountUp(loading ? 0 : Math.round(done * 100));
  // Semicircle arcs: completed, then in progress, then the rest (pending, striped).
  const R = 80; const L = Math.PI * R;
  const [drawn, setDrawn] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setDrawn(true)); return () => cancelAnimationFrame(id); }, []);
  const seg = (from: number, len: number) => ({ strokeDasharray: `${drawn && !loading ? len * L : 0} ${L}`, strokeDashoffset: -from * L, transition: 'stroke-dasharray 1s cubic-bezier(.2,.7,.2,1)' });
  return (
    <Card i={i} title={t('dash.progress')}>
      <div className="relative mx-auto w-full max-w-[260px]">
        <svg viewBox="0 0 200 110" className="w-full" role="img" aria-label={t('dash.progressAria', { pct: Math.round(done * 100) })}>
          <defs><pattern id="w-stripe" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2.5" height="6" fill="var(--w-primary)" opacity=".45" /></pattern></defs>
          <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="url(#w-stripe)" strokeWidth="26" strokeLinecap="round" />
          <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--w-accent)" strokeWidth="26" strokeLinecap="round" style={seg(done, running)} />
          <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--w-primary)" strokeWidth="26" strokeLinecap="round" style={seg(0, done)} />
        </svg>
        <div className="absolute inset-x-0 bottom-0 text-center">
          <div className="text-[40px] font-bold leading-none tabular-nums">{pct}%</div>
          <div className="mt-1 text-xs text-muted">{t('dash.tasksDone')}</div>
        </div>
      </div>
      <ul className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted">
        <li className="flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-full bg-primary" /> {t('dash.legend.done')}</li>
        <li className="flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-full bg-accent" /> {t('dash.legend.running')}</li>
        <li className="flex items-center gap-1.5"><span aria-hidden className="stripes h-2.5 w-2.5 rounded-full !opacity-100" /> {t('dash.legend.pending')}</li>
      </ul>
    </Card>
  );
}

function TimeTracker({ i }: { i: number }) {
  const t = useT();
  const qc = useQueryClient();
  const timer = useQuery({ queryKey: ['time', 'timer'], queryFn: async () => (await as<Timer>(api.GET('/time/timer'))) ?? null, refetchInterval: 60_000 });
  const running = timer.data ?? null;
  const now = useNow(1000);
  const stop = useMutation({
    mutationFn: () => as<{ minutes: number }>(api.POST('/time/timer/stop', { body: {} })),
    onSuccess: (r) => { invalidateTime(qc); toast({ text: t('p6.timer.stopped', { time: fmtMinutes(r.minutes) }), tone: 'ok' }, 4000); },
  });
  const ref = useRef<HTMLElement>(null);
  return (
    <section ref={ref} className="tile rise relative min-h-[210px] overflow-hidden border-transparent bg-primary-strong text-white" style={delay(i)} aria-label={t('dash.tracker')}>
      <svg aria-hidden className="drift pointer-events-none absolute inset-0 h-full w-[200%] opacity-40" viewBox="0 0 400 200" preserveAspectRatio="none">
        {Array.from({ length: 14 }, (_, k) => <path key={k} d={`M0 ${20 + k * 13} C60 ${-10 + k * 13} 140 ${60 + k * 13} 200 ${20 + k * 13} S340 ${-10 + k * 13} 400 ${20 + k * 13}`} fill="none" stroke="#4ade80" strokeWidth=".8" />)}
      </svg>
      <div className="relative flex h-full flex-col">
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-semibold">{t('dash.tracker')}</h2>
          {running && <span className="flex items-center gap-1.5 text-xs text-white/80"><span aria-hidden className="pulse-dot h-2 w-2 rounded-full bg-red-400" /> {t('dash.live')}</span>}
        </div>
        <div className="mt-4 text-center text-[44px] font-bold tabular-nums tracking-tight" role="timer" aria-live="off">
          {running ? elapsed(running.startedAt, now) : '0:00:00'}
        </div>
        <div className="mt-1 truncate text-center text-xs text-white/70">{running ? (running.notes || t('dash.trackerRunning')) : t('dash.trackerIdle')}</div>
        <div className="mt-auto flex justify-center gap-3 pt-4">
          {running ? (
            <>
              <span aria-hidden className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15"><Pause size={18} /></span>
              <button className="flex h-11 w-11 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition-transform hover:scale-105 disabled:opacity-60" aria-label={t('p6.timer.stop')} onClick={() => stop.mutate()} disabled={stop.isPending}><Square size={16} fill="currentColor" /></button>
            </>
          ) : (
            <button className="flex h-11 items-center gap-2 rounded-full bg-white px-5 font-semibold text-primary-strong shadow-lg transition-transform hover:scale-105" onClick={() => startTimerFor()}><Play size={16} fill="currentColor" aria-hidden /> {t('p6.timer.start')}</button>
          )}
        </div>
      </div>
    </section>
  );
}

export function ComingSoon({ module, phase }: { module: string; phase: number }) {
  const t = useT();
  return <div className="card p-6 text-muted">{t('home.comingSoon', { module, phase })}</div>;
}
