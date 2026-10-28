import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api } from '../../lib/session';
import { useSync } from '../../lib/sync';
import { as, body, type Timer } from '../hr/api';
import { fmtMinutes } from '../hr/logic';
import { invalidateTime, TaskSelect, useP6Error } from './shared';

export const elapsed = (startedAt: string, now: number) => {
  const s = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Start a timer from anywhere ("start-timer" event carries an optional task). */
export const startTimerFor = (task?: { id: string; title: string; clientId: string | null; clientName: string | null }) =>
  dispatchEvent(new CustomEvent('worko:start-timer', { detail: task ?? null }));

/**
 * Header timer. The server holds the one running timer per user; other tabs/devices learn about start/stop through the
 * realtime `changed` → sync of `time_timer`, which re-fetches this query.
 */
export function TimerWidget() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const err = useP6Error();
  const allowed = can('time', 'view');
  const v = useSync((s) => s.versions.time_timer ?? 0);
  const timer = useQuery({ queryKey: ['time', 'timer'], queryFn: async () => (await as<Timer>(api.GET('/time/timer'))) ?? null, enabled: allowed, refetchInterval: 60_000 });
  useEffect(() => { if (v) void qc.invalidateQueries({ queryKey: ['time', 'timer'] }); }, [v, qc]);
  const [now, setNow] = useState(Date.now());
  const running = timer.data ?? null;
  useEffect(() => { if (!running) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [running]);
  const [starting, setStarting] = useState<null | { task?: { id: string; title: string; clientId: string | null; clientName: string | null } }>(null);
  useEffect(() => {
    const on = (e: Event) => setStarting({ task: (e as CustomEvent).detail ?? undefined });
    addEventListener('worko:start-timer', on);
    return () => removeEventListener('worko:start-timer', on);
  }, []);
  const stop = useMutation({
    mutationFn: () => as<{ entryId: string; minutes: number; capped: boolean }>(api.POST('/time/timer/stop', { body: {} })),
    onSuccess: (r) => { invalidateTime(qc); toast({ text: r.capped ? t('p6.timer.stoppedCapped', { time: fmtMinutes(r.minutes) }) : t('p6.timer.stopped', { time: fmtMinutes(r.minutes) }), tone: 'ok' }, 5000); },
    onError: (e) => { toast({ text: err(e), tone: 'error' }); void qc.invalidateQueries({ queryKey: ['time', 'timer'] }); },
  });
  if (!allowed) return null;
  return (
    <>
      {running ? (
        <div className="flex items-center gap-1 rounded-md border border-border px-2 py-1" role="timer" aria-label={t('p6.timer.running')}>
          <span className="h-2 w-2 rounded-full bg-overdue" aria-hidden />
          <span className="font-mono tabular-nums" data-testid="timer-elapsed">{elapsed(running.startedAt, now)}</span>
          <button className="btn" onClick={() => stop.mutate()} disabled={stop.isPending}><Square size={12} aria-hidden /> {t('p6.timer.stop')}</button>
        </div>
      ) : (
        <button className="btn" onClick={() => setStarting({})}><Play size={12} aria-hidden /> {t('p6.timer.start')}</button>
      )}
      {starting && <StartDialog task={starting.task} onClose={() => setStarting(null)} />}
    </>
  );
}

function StartDialog({ task, onClose }: { task?: { id: string; title: string; clientId: string | null; clientName: string | null }; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const [client, setClient] = useState<PickedClient | null>(task?.clientId ? { id: task.clientId, name: task.clientName ?? '' } : null);
  const [taskId, setTaskId] = useState(task?.id ?? '');
  const [notes, setNotes] = useState('');
  const [billable, setBillable] = useState(true);
  const start = useMutation({
    mutationFn: () => as<{ id: string }>(api.POST('/time/timer/start', { body: body({ taskId: taskId || null, clientId: taskId ? null : client?.id ?? null, notes: notes.trim() || null, billable, deviceAt: new Date().toISOString() }) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['time'] }); onClose(); },
    onError: (e) => { toast({ text: err(e), tone: 'error' }); void qc.invalidateQueries({ queryKey: ['time', 'timer'] }); },
  });
  return (
    <Dialog title={t('p6.timer.startTitle')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
        {task ? <p>{task.title}{task.clientName ? ` — ${task.clientName}` : ''}</p> : <>
          <ClientPicker label={t('p6.f.client')} value={client} onChange={(c) => { setClient(c); setTaskId(''); }} />
          <TaskSelect label={t('p6.f.task')} clientId={client?.id ?? null} value={taskId} onChange={(id) => setTaskId(id)} />
        </>}
        <Field label={t('p6.f.notes')}><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <label className="flex items-center gap-2"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> {t('p6.f.billable')}</label>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={start.isPending}>{t('p6.timer.start')}</button></div>
      </form>
    </Dialog>
  );
}
