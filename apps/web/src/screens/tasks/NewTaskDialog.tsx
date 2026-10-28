import { useMutation } from '@tanstack/react-query';
import { TASK_PRIORITIES } from '@worko/domain';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field } from '../../components/Dialog';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { PersonSelect, usePriorityLabel, useRuleMessage, useServiceTypes } from './shared';

export function NewTaskDialog({ onClose, onCreated, client: initialClient }: { onClose(): void; onCreated(id: string): void; client?: PickedClient | null }) {
  const t = useT();
  const prio = usePriorityLabel();
  const ruleMsg = useRuleMessage();
  const services = useServiceTypes();
  const [title, setTitle] = useState('');
  const [client, setClient] = useState<PickedClient | null>(initialClient ?? null);
  const [service, setService] = useState('');
  const [actBy, setActBy] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState<(typeof TASK_PRIORITIES)[number]>('normal');
  const [assignee, setAssignee] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/tasks', { body: {
      title: title.trim(), client_id: client?.id ?? null, service_type_id: service || null, act_by: actBy || null, statutory_due: due || null, priority, assignee_id: assignee,
    } })),
    onSuccess: (r) => onCreated(r.id),
  });
  return (
    <Dialog title={t('tasks.new')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate(); }}>
        <Field label={t('tasks.title')}><input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <ClientPicker label={t('tasks.f.client')} value={client} onChange={setClient} />
        <Field label={t('tasks.f.service')}>
          <select className="input" value={service} onChange={(e) => setService(e.target.value)}>
            <option value="">—</option>
            {(services.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('tasks.actBy')}><input type="date" className="input" value={actBy} onChange={(e) => setActBy(e.target.value)} /></Field>
          <Field label={t('tasks.statutoryDue')}><input type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Field label={t('tasks.priority')}>
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
              {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{prio(p)}</option>)}
            </select>
          </Field>
          <PersonSelect label={t('tasks.f.assignee')} value={assignee} onChange={setAssignee} />
        </div>
        {create.isError && <p role="alert" className="text-overdue">{ruleMsg(create.error)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={create.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}
