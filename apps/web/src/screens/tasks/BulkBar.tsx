import { useQueryClient } from '@tanstack/react-query';
import { TASK_PRIORITIES, TASK_STATUSES } from '@worko/domain';
import type { Schemas } from '@worko/api-client';
import { useState } from 'react';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api, unwrap } from '../../lib/session';
import { usePriorityLabel, useRuleMessage, useStatusLabel, useUsers } from './shared';

type Patch = Schemas['TaskBulkPatch'];
type Field = 'status' | 'assignee_id' | 'reviewer_id' | 'act_by' | 'priority';

/** Applies a bulk patch, then offers Undo (POST /tasks/bulk/undo with the returned token) in a toast. */
export async function runBulk(ids: string[], patch: Patch, msgs: { applied(n: number, failed: number): string; undo: string; restored(n: number, skipped: number): string; error(e: unknown): string }, refresh: () => void) {
  try {
    const r = await unwrap(api.POST('/tasks/bulk', { body: { ids, patch } }));
    refresh();
    const token = r.undoToken;
    toast({
      text: msgs.applied(r.applied, r.failed.length), tone: r.failed.length && !r.applied ? 'error' : 'ok',
      action: token ? { label: msgs.undo, run: () => void unwrap(api.POST('/tasks/bulk/undo', { body: { undoToken: token } }))
        .then((u) => { refresh(); toast({ text: msgs.restored(u.restored, u.skipped.length) }); })
        .catch((e) => toast({ text: msgs.error(e), tone: 'error' })) } : undefined,
    }, Math.min(r.expiresInSeconds, 60) * 1000);
    return r;
  } catch (e) {
    toast({ text: msgs.error(e), tone: 'error' });
    return null;
  }
}

export function BulkBar({ ids, onDone }: { ids: string[]; onDone(): void }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const statusLabel = useStatusLabel();
  const prioLabel = usePriorityLabel();
  const ruleMsg = useRuleMessage();
  const { users } = useUsers();
  const [field, setField] = useState<Field>('status');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const fields: Array<[Field, string]> = [
    ['status', t('tasks.f.status')], ['priority', t('tasks.priority')], ['act_by', t('tasks.actBy')],
    ...(can('tasks', 'assign') ? [['assignee_id', t('tasks.f.assignee')], ['reviewer_id', t('tasks.reviewer')]] as Array<[Field, string]> : []),
  ];
  const apply = async () => {
    const v = value || null;
    if (!v && (field === 'status' || field === 'priority')) return;
    setBusy(true);
    const r = await runBulk(ids, { [field]: v } as Patch, {
      applied: (n, f) => t('tasks.bulk.applied', { count: n, failed: f }), undo: t('tasks.bulk.undo'),
      restored: (n, s) => t('tasks.bulk.restored', { count: n, skipped: s }), error: ruleMsg,
    }, () => void qc.invalidateQueries({ queryKey: ['tasks'] }));
    setBusy(false);
    if (r) onDone();
  };
  return (
    <div role="region" aria-label={t('tasks.bulk.label')} className="card flex flex-wrap items-end gap-2 p-2">
      <span className="pb-2 text-sm font-medium">{t('tasks.bulk.selected', { count: ids.length })}</span>
      <label className="text-sm"><span className="label">{t('tasks.bulk.field')}</span>
        <select className="input w-36" value={field} onChange={(e) => { setField(e.target.value as Field); setValue(''); }}>
          {fields.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select></label>
      <label className="text-sm"><span className="label">{t('tasks.bulk.value')}</span>
        {field === 'act_by' ? <input type="date" className="input w-40" value={value} onChange={(e) => setValue(e.target.value)} /> : (
          <select className="input w-44" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">{field === 'status' || field === 'priority' ? '—' : t('tasks.nobody')}</option>
            {field === 'status' && TASK_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            {field === 'priority' && TASK_PRIORITIES.map((s) => <option key={s} value={s}>{prioLabel(s)}</option>)}
            {(field === 'assignee_id' || field === 'reviewer_id') && users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}</label>
      <button className="btn btn-primary" disabled={busy} onClick={() => void apply()}>{t('tasks.bulk.apply')}</button>
      <button className="btn" onClick={onDone}>{t('tasks.bulk.clear')}</button>
    </div>
  );
}
