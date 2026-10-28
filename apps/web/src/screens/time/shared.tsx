import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageKey } from '@worko/i18n';
import { en } from '@worko/i18n';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { parseMinutes } from '../hr/logic';

/** Open tasks for pickers: mine by default, or a client's. */
export function TaskSelect({ clientId, value, onChange, label }: { clientId: string | null; value: string; onChange(id: string, task: { id: string; title: string; clientId: string | null; clientName: string | null } | null): void; label: string }) {
  const t = useT();
  const q = useQuery({
    queryKey: ['tasks', 'pick', clientId ?? 'me'],
    queryFn: () => unwrap(api.GET('/tasks', { params: { query: { ...(clientId ? { clientId } : { assigneeId: 'me' }), closed: 'false', limit: 100 } } })),
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  return (
    <Field label={label}>
      <select className="input" value={value} onChange={(e) => {
        const x = items.find((i) => i.id === e.target.value);
        onChange(e.target.value, x ? { id: x.id, title: x.title, clientId: x.clientId ?? null, clientName: x.clientName ?? null } : null);
      }}>
        <option value="">{t('p6.time.noTask')}</option>
        {items.map((i) => <option key={i.id} value={i.id}>{i.title}{i.clientName ? ` — ${i.clientName}` : ''}</option>)}
      </select>
    </Field>
  );
}

/** Error code → message (p6.err.<code>) or the server text. */
export function useP6Error() {
  const t = useT();
  return (e: unknown) => {
    const code = (e as { code?: string } | null)?.code?.split(':')[0];
    const key = `p6.err.${code}` as MessageKey;
    if (code && key in en) return t(key);
    return (e as Error | null)?.message || t('common.error');
  };
}

export const invalidateTime = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['time'] });
  void qc.invalidateQueries({ queryKey: ['reports'] });
};

/** Manual entry (also used by the task drawer's "Log time"). */
export function LogTimeDialog({ task, onClose }: { task?: { id: string; title: string; clientId: string | null; clientName: string | null }; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const [client, setClient] = useState<PickedClient | null>(task?.clientId ? { id: task.clientId, name: task.clientName ?? '' } : null);
  const [taskId, setTaskId] = useState(task?.id ?? '');
  const [date, setDate] = useState(todayIst());
  const [dur, setDur] = useState('');
  const [billable, setBillable] = useState(true);
  const [notes, setNotes] = useState('');
  const minutes = parseMinutes(dur);
  const save = useMutation({
    mutationFn: () => unwrap(api.POST('/time/entries', { body: { taskId: taskId || null, clientId: taskId ? undefined : client?.id ?? null, workDate: date, minutes: minutes!, billable, notes: notes.trim() || null } })),
    onSuccess: () => { invalidateTime(qc); toast({ text: t('p6.time.logged'), tone: 'ok' }, 3000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const bad = minutes === null || minutes < 1 || minutes > 1440;
  return (
    <Dialog title={task ? t('p6.time.logFor', { task: task.title }) : t('p6.time.log')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!bad) save.mutate(); }}>
        {!task && <>
          <ClientPicker label={t('p6.f.client')} value={client} onChange={(c) => { setClient(c); setTaskId(''); }} />
          <TaskSelect label={t('p6.f.task')} clientId={client?.id ?? null} value={taskId} onChange={(id) => setTaskId(id)} />
        </>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('p6.f.date')}><input type="date" className="input" value={date} max={todayIst()} required onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={t('p6.f.duration')} hint={t('p6.time.durationHint')} error={dur && bad ? t('p6.time.badDuration') : null}>
            <input className="input" value={dur} placeholder="1:30" required onChange={(e) => setDur(e.target.value)} /></Field>
        </div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> {t('p6.f.billable')}</label>
        <Field label={t('p6.f.notes')}><textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={bad || save.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

export function StatusPill({ status }: { status: string }) {
  const t = useT();
  const tone: Record<string, string> = { approved: 'text-done', paid: 'text-done', settled: 'text-done', ok: 'text-done', partially_approved: 'text-due-soon', submitted: 'text-primary', pending: 'text-primary', requested: 'text-primary', needs_approval: 'text-due-soon', flagged: 'text-due-soon', rejected: 'text-overdue', cancelled: 'text-muted line-through' };
  const key = `p6.status.${status}` as MessageKey;
  return <span className={`rounded bg-surface-alt px-1.5 py-0.5 text-xs ${tone[status] ?? 'text-muted'}`}>{key in en ? t(key) : status}</span>;
}
