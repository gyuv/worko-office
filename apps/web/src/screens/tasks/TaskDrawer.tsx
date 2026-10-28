import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { TASK_OUTCOMES, TASK_STATUSES, type TaskOutcome, type TaskStatus } from '@worko/domain';
import { formatDate, formatDateTime, type MessageKey } from '@worko/i18n';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api, unwrap } from '../../lib/session';
import { isOverdue, moveError } from './logic';
import { LogTimeDialog } from '../time/shared';
import { startTimerFor } from '../time/TimerWidget';
import { fmtMinutes, parseMinutes } from '../hr/logic';
import { PersonSelect, useRuleMessage, useStatusLabel, useUsers } from './shared';

type TaskIn = Schemas['TaskIn'];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Side drawer with the full task: checks, pending issue, people, dates, close. */
export function TaskDrawer({ id, onClose }: { id: string; onClose(): void }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const statusLabel = useStatusLabel();
  const ruleMsg = useRuleMessage();
  const { name } = useUsers();
  const box = useRef<HTMLElement>(null);
  const q = useQuery({ queryKey: ['task', id], queryFn: () => unwrap(api.GET('/tasks/{id}', { params: { path: { id } } })), retry: false });
  const [issue, setIssue] = useState('');
  const [closing, setClosing] = useState(false);
  const [logging, setLogging] = useState(false);
  useEffect(() => { setIssue(q.data?.pendingIssue ?? ''); }, [q.data?.pendingIssue]);
  useEffect(() => {
    box.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !closing && !logging) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, closing, logging]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['task', id] }); void qc.invalidateQueries({ queryKey: ['tasks'] }); };
  const patch = useMutation({
    mutationFn: (body: TaskIn) => unwrap(api.PATCH('/tasks/{id}', { params: { path: { id } }, body })),
    onError: (e) => toast({ text: ruleMsg(e), tone: 'error' }),
    onSettled: refresh,
  });
  const check = useMutation({
    mutationFn: (b: { key: string; done: boolean }) => unwrap(api.POST('/tasks/{id}/checks', { params: { path: { id } }, body: b })),
    onError: (e) => toast({ text: ruleMsg(e), tone: 'error' }),
    onSettled: refresh,
  });

  const x = q.data;
  const closed = !!x?.outcome;
  const editable = can('tasks', 'edit') && !closed;
  const assignable = can('tasks', 'assign') && !closed;
  const setStatus = (to: TaskStatus) => {
    if (!x) return;
    const why = moveError(x, to, { pendingIssue: issue });
    if (why) { toast({ text: ruleMsg({ code: why }), tone: 'error' }); return; }
    patch.mutate({ status: to, ...(to === 'pending_client' ? { pending_issue: issue.trim() } : {}) });
  };

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/20" onMouseDown={onClose}>
      <aside ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={x?.title ?? t('nav.tasks')} onMouseDown={(e) => e.stopPropagation()}
        className="h-full w-full max-w-lg overflow-auto border-l border-border bg-surface p-4 shadow-xl outline-none">
        <div className="flex items-start gap-2">
          <h2 className="flex-1 text-lg font-semibold">{x?.title ?? t('common.loading')}</h2>
          <button className="rounded p-1 text-muted hover:text-fg" aria-label={t('common.close')} onClick={onClose}><X size={16} /></button>
        </div>
        {q.isError && <p role="alert" className="text-overdue">{t('tasks.notFound')}</p>}
        {x && (
          <div className="mt-2 space-y-4 text-sm">
            <div className="text-muted">
              {x.clientId ? <a className="underline" href={`#/clients/${x.clientId}`}>{x.clientName}</a> : t('tasks.firmTask')}
              {x.serviceName && <> · {x.serviceName}</>}{x.periodLabel && <> · {x.periodLabel}</>}
              {x.source === 'auto' && <> · {t('tasks.autoCreated')}</>}
            </div>
            {closed && <p className="rounded bg-surface-alt p-2">{t('tasks.closedAs', { outcome: t(`tasks.outcome.${x.outcome}` as MessageKey) })}{x.outcomeNote ? ` — ${x.outcomeNote}` : ''}</p>}

            <label className="block"><span className="label">{t('tasks.f.status')}</span>
              <select className="input" value={x.status} disabled={!editable} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                {TASK_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
              </select></label>

            <section aria-labelledby="td-dates">
              <h3 id="td-dates" className="mb-1 font-semibold">{t('tasks.dates')}</h3>
              <div className="grid grid-cols-2 gap-3">
                <div><span className="label">{t('tasks.statutoryDue')}</span><div className="input bg-surface-alt">{x.statutoryDue ? formatDate(x.statutoryDue) : '—'}</div>
                  {x.extensionId && <span className="text-xs text-muted">{t('tasks.extended')}</span>}</div>
                <label><span className="label">{t('tasks.actBy')}</span>
                  <input type="date" className={`input ${isOverdue(x, todayIst()) ? 'text-overdue' : ''}`} disabled={!editable} defaultValue={x.actBy ?? ''} key={x.actBy ?? ''}
                    max={x.statutoryDue ?? undefined} onBlur={(e) => { if ((e.target.value || null) !== (x.actBy ?? null)) patch.mutate({ act_by: e.target.value || null }); }} /></label>
              </div>
              {x.actBy && x.statutoryDue && <p className="mt-1 text-xs text-muted">{t('tasks.bufferDays', { count: daysBetween(x.actBy, x.statutoryDue) })}</p>}
            </section>

            <section aria-labelledby="td-people">
              <h3 id="td-people" className="mb-1 font-semibold">{t('tasks.people')}</h3>
              {assignable ? (
                <div className="grid grid-cols-2 gap-3">
                  <PersonSelect label={t('tasks.leader')} value={x.leaderId ?? null} onChange={(v) => patch.mutate({ leader_id: v })} />
                  <PersonSelect label={t('tasks.manager')} value={x.managerId ?? null} onChange={(v) => patch.mutate({ manager_id: v })} />
                  <PersonSelect label={t('tasks.f.assignee')} value={x.assigneeId ?? null} onChange={(v) => patch.mutate({ assignee_id: v })} />
                  <PersonSelect label={t('tasks.reviewer')} value={x.reviewerId ?? null} onChange={(v) => patch.mutate({ reviewer_id: v })} />
                </div>
              ) : (
                <dl className="grid grid-cols-2 gap-1">
                  <dt className="text-muted">{t('tasks.leader')}</dt><dd>{name(x.leaderId)}</dd>
                  <dt className="text-muted">{t('tasks.manager')}</dt><dd>{name(x.managerId)}</dd>
                  <dt className="text-muted">{t('tasks.f.assignee')}</dt><dd>{name(x.assigneeId)}</dd>
                  <dt className="text-muted">{t('tasks.reviewer')}</dt><dd>{name(x.reviewerId)}</dd>
                </dl>
              )}
            </section>

            <section aria-labelledby="td-time">
              <h3 id="td-time" className="mb-1 font-semibold">{t('p6.task.time')}</h3>
              <div className="flex flex-wrap items-end gap-2">
                <label><span className="label">{t('p6.task.estimate')}</span>
                  <input className="input w-24" disabled={!editable} defaultValue={x.estimateMinutes ? fmtMinutes(x.estimateMinutes) : ''} key={x.estimateMinutes ?? ''} placeholder="h:mm"
                    onBlur={(e) => { const m = parseMinutes(e.target.value); if (m === null) { toast({ text: t('p6.time.badDuration'), tone: 'error' }); return; }
                      if ((m || null) !== (x.estimateMinutes ?? null)) patch.mutate({ estimate_minutes: m || null }); }} /></label>
                {can('time', 'edit') && <>
                  <button className="btn" onClick={() => setLogging(true)}>{t('p6.time.log')}</button>
                  <button className="btn" onClick={() => startTimerFor({ id: x.id, title: x.title, clientId: x.clientId ?? null, clientName: x.clientName ?? null })}>{t('p6.timer.start')}</button>
                </>}
              </div>
            </section>

            <section aria-labelledby="td-checks">
              <h3 id="td-checks" className="mb-1 font-semibold">{t('tasks.checks')} <span className="font-normal text-muted">{x.checks.filter((c) => c.done).length}/{x.checks.length}</span></h3>
              {!x.checks.length && <p className="text-muted">{t('tasks.noChecks')}</p>}
              <ul className="space-y-1">
                {x.checks.map((c) => (
                  <li key={c.key}><label className="flex items-start gap-2">
                    <input type="checkbox" checked={c.done} disabled={!editable || check.isPending} onChange={(e) => check.mutate({ key: c.key, done: e.target.checked })} />
                    <span>{c.label}{c.required && <span className="ml-1 text-xs text-overdue">{t('tasks.required')}</span>}
                      {c.done && c.doneAt && <span className="block text-xs text-muted">{name(c.doneBy)} · {formatDateTime(c.doneAt)}</span>}</span>
                  </label></li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="td-issue">
              <h3 id="td-issue" className="mb-1 font-semibold">{t('tasks.pendingIssue')}</h3>
              <textarea className="input min-h-16" aria-labelledby="td-issue" value={issue} disabled={!editable} placeholder={t('tasks.pendingIssueHint')} onChange={(e) => setIssue(e.target.value)} />
              {editable && issue !== (x.pendingIssue ?? '') && (
                <button className="btn mt-1" onClick={() => patch.mutate({ pending_issue: issue.trim() || null })}>{t('common.save')}</button>
              )}
            </section>

            {can('tasks', 'edit') && !closed && (
              <div className="flex justify-end border-t border-border pt-3"><button className="btn" onClick={() => setClosing(true)}>{t('tasks.close')}</button></div>
            )}
          </div>
        )}
        {logging && x && <LogTimeDialog task={{ id: x.id, title: x.title, clientId: x.clientId ?? null, clientName: x.clientName ?? null }} onClose={() => setLogging(false)} />}
        {closing && x && <CloseDialog task={x} onClose={() => setClosing(false)} onDone={() => { setClosing(false); refresh(); onClose(); }} />}
      </aside>
    </div>
  );
}

function CloseDialog({ task, onClose, onDone }: { task: Schemas['Task']; onClose(): void; onDone(): void }) {
  const t = useT();
  const can = useCan();
  const ruleMsg = useRuleMessage();
  const [outcome, setOutcome] = useState<TaskOutcome>(task.status === 'done' ? 'billed' : 'deleted');
  const [note, setNote] = useState('');
  const close = useMutation({
    mutationFn: () => unwrap(api.POST('/tasks/{id}/close', { params: { path: { id: task.id } }, body: { outcome, note: note.trim() || null } })),
    onSuccess: onDone,
  });
  const allowed = (o: TaskOutcome) => (o === 'deleted' ? can('tasks', 'delete') : task.status === 'done');
  return (
    <Dialog title={t('tasks.closeTitle')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); close.mutate(); }}>
        <fieldset className="space-y-1"><legend className="label">{t('tasks.outcome')}</legend>
          {TASK_OUTCOMES.map((o) => (
            <label key={o} className={`flex items-center gap-2 ${allowed(o) ? '' : 'text-muted'}`}>
              <input type="radio" name="outcome" value={o} checked={outcome === o} disabled={!allowed(o)} onChange={() => setOutcome(o)} /> {t(`tasks.outcome.${o}` as MessageKey)}
            </label>
          ))}
        </fieldset>
        {task.status !== 'done' && <p className="text-xs text-muted">{t('tasks.closeNeedsDone')}</p>}
        <label className="block"><span className="label">{t('tasks.closeNote')}</span><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {close.isError && <p role="alert" className="text-overdue">{ruleMsg(close.error)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className={`btn ${outcome === 'deleted' ? 'btn-danger' : 'btn-primary'}`} disabled={!allowed(outcome) || close.isPending}>{t('tasks.close')}</button></div>
      </form>
    </Dialog>
  );
}
