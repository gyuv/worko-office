import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';

export function GroupDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'family' | 'group' | 'other'>('family');
  const save = useMutation({
    mutationFn: () => unwrap(api.POST('/client-groups', { body: { name: name.trim(), kind } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['client-groups'] }); onClose(); },
  });
  return (
    <Dialog title={t('clients.newGroup')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label={t('clients.groupName')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label={t('clients.groupKind')}>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {(['family', 'group', 'other'] as const).map((k) => <option key={k} value={k}>{t(`clients.groupKind.${k}`)}</option>)}
          </select>
        </Field>
        {save.isError && <p role="alert" className="text-overdue">{(save.error as Error).message}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!name.trim() || save.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}
