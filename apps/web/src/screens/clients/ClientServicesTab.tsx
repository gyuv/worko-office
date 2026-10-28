import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api, unwrap } from '../../lib/session';
import { PersonSelect, useRuleMessage, useServiceTypes, useUsers } from '../tasks/shared';

type Sub = Schemas['ClientService'];
type ST = Schemas['ServiceType'];

/** Client 360 → Services: subscribe/unsubscribe a client to catalogue services, with people overrides. */
export function ClientServicesTab({ clientId }: { clientId: string }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const { name } = useUsers();
  const catalogue = useServiceTypes();
  const subs = useQuery({ queryKey: ['client-services', clientId], queryFn: () => unwrap(api.GET('/clients/{id}/services', { params: { path: { id: clientId } } })) });
  const [editing, setEditing] = useState<{ st: ST; sub: Sub | null } | null>(null);
  const toggle = useMutation({
    mutationFn: ({ st, active }: { st: ST; active: boolean }) => unwrap(api.PUT('/clients/{id}/services/{serviceTypeId}', { params: { path: { id: clientId, serviceTypeId: st.id } }, body: { active } })),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['client-services', clientId] }),
  });
  const canAssign = can('tasks', 'assign');
  const subOf = (st: ST) => subs.data?.find((s) => s.serviceTypeId === st.id) ?? null;
  return (
    <div className="space-y-2">
      {toggle.isError && <p role="alert" className="text-overdue">{(toggle.error as Error).message}</p>}
      {catalogue.data && !catalogue.data.length ? <p className="card p-6 text-muted">{t('svc.empty')}</p> : (
        <div className="card overflow-auto">
          <table className="table w-full">
            <thead><tr><th>{t('svc.name')}</th><th>{t('svc.subscribed')}</th><th>{t('svc.overrides')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
            <tbody>{(catalogue.data ?? []).map((st) => {
              const sub = subOf(st);
              return (
                <tr key={st.id}>
                  <td>{st.name}<div className="text-xs text-muted">{st.category}</div></td>
                  <td><input type="checkbox" aria-label={t('svc.subscribeTo', { name: st.name })} disabled={!canAssign || toggle.isPending} checked={!!sub?.active} onChange={(e) => toggle.mutate({ st, active: e.target.checked })} /></td>
                  <td className="text-xs text-muted">{sub ? [sub.assigneeId && `${t('tasks.f.assignee')}: ${name(sub.assigneeId)}`, sub.reviewerId && `${t('tasks.reviewer')}: ${name(sub.reviewerId)}`, sub.startPeriod && `${t('svc.from')} ${sub.startPeriod}`].filter(Boolean).join(' · ') || '—' : '—'}</td>
                  <td className="text-right">{canAssign && sub?.active && <button className="btn" onClick={() => setEditing({ st, sub })}>{t('svc.overridesEdit')}</button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {editing && <OverrideDialog clientId={clientId} st={editing.st} sub={editing.sub} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: ['client-services', clientId] }); }} />}
    </div>
  );
}

function OverrideDialog({ clientId, st, sub, onClose, onSaved }: { clientId: string; st: ST; sub: Sub | null; onClose(): void; onSaved(): void }) {
  const t = useT();
  const ruleMsg = useRuleMessage();
  const [f, setF] = useState({ leaderId: sub?.leaderId ?? null, managerId: sub?.managerId ?? null, assigneeId: sub?.assigneeId ?? null, reviewerId: sub?.reviewerId ?? null,
    startPeriod: sub?.startPeriod ?? '', endPeriod: sub?.endPeriod ?? '', notes: sub?.notes ?? '' });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => unwrap(api.PUT('/clients/{id}/services/{serviceTypeId}', { params: { path: { id: clientId, serviceTypeId: st.id } },
      body: { active: true, ...f, startPeriod: f.startPeriod || null, endPeriod: f.endPeriod || null, notes: f.notes || null } })),
    onSuccess: onSaved,
  });
  return (
    <Dialog title={t('svc.overridesFor', { name: st.name })} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="text-xs text-muted">{t('svc.overridesHint')}</p>
        <div className="grid grid-cols-2 gap-3">
          <PersonSelect label={t('tasks.leader')} value={f.leaderId} onChange={(v) => set('leaderId', v)} />
          <PersonSelect label={t('tasks.manager')} value={f.managerId} onChange={(v) => set('managerId', v)} />
          <PersonSelect label={t('tasks.f.assignee')} value={f.assigneeId} onChange={(v) => set('assigneeId', v)} />
          <PersonSelect label={t('tasks.reviewer')} value={f.reviewerId} onChange={(v) => set('reviewerId', v)} />
          <Field label={t('svc.startPeriod')}><input type="month" className="input" value={f.startPeriod} onChange={(e) => set('startPeriod', e.target.value)} /></Field>
          <Field label={t('svc.endPeriod')}><input type="month" className="input" value={f.endPeriod} onChange={(e) => set('endPeriod', e.target.value)} /></Field>
        </div>
        <Field label={t('svc.notes')}><textarea className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        {save.isError && <p role="alert" className="text-overdue">{ruleMsg(save.error)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={save.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}
