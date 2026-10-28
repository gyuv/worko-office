import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { SERVICE_FREQUENCIES } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api, unwrap } from '../../lib/session';
import { PersonSelect, useRuleMessage, useServiceTypes } from '../tasks/shared';

type ST = Schemas['ServiceType'];
type Check = { key: string; label: string; required: boolean };

/** Settings → Services: the firm's service catalogue (no prices — billing rates live elsewhere). */
export function ServicesSettings() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const list = useServiceTypes(true);
  const [editing, setEditing] = useState<ST | 'new' | null>(null);
  const install = useMutation({
    mutationFn: () => unwrap(api.POST('/service-types/install-defaults')),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['service-types'] }),
  });
  const canEdit = can('settings', 'edit');
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t('svc.title')}</h1>
        {canEdit && <div className="ml-auto flex gap-2">
          <button className="btn" disabled={install.isPending} onClick={() => install.mutate()}>{t('svc.installDefaults')}</button>
          <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={14} aria-hidden /> {t('svc.new')}</button>
        </div>}
      </header>
      {install.data && <p role="status" className="text-done">{t('svc.installed', { created: install.data.created, skipped: install.data.skipped })}</p>}
      {list.data && !list.data.length ? <p className="card p-6 text-muted">{t('svc.empty')}</p> : (
        <div className="card overflow-auto">
          <table className="table w-full">
            <thead><tr><th>{t('svc.name')}</th><th>{t('svc.key')}</th><th>{t('svc.category')}</th><th>{t('svc.frequency')}</th><th>{t('svc.rule')}</th><th>{t('svc.checks')}</th><th>{t('svc.active')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
            <tbody>{(list.data ?? []).map((s) => (
              <tr key={s.id} className={s.active ? '' : 'text-muted'}>
                <td>{s.name}</td><td className="font-mono text-xs">{s.key}</td><td>{s.category}</td><td>{t(`svc.freq.${s.frequency}` as MessageKey)}</td>
                <td className="font-mono text-xs">{s.ruleId ?? '—'}</td><td>{s.defaultChecks?.length ?? 0}</td><td>{s.active ? t('svc.yes') : t('svc.no')}</td>
                <td className="text-right">{canEdit && <button className="btn" aria-label={t('svc.edit', { name: s.name })} onClick={() => setEditing(s)}><Pencil size={14} /></button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {editing && <ServiceDialog st={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: ['service-types'] }); }} />}
    </div>
  );
}

function ServiceDialog({ st, onClose, onSaved }: { st: ST | null; onClose(): void; onSaved(): void }) {
  const t = useT();
  const ruleMsg = useRuleMessage();
  const [f, setF] = useState({
    key: st?.key ?? '', name: st?.name ?? '', category: st?.category ?? 'Compliance', description: st?.description ?? '', frequency: st?.frequency ?? 'monthly',
    ruleId: st?.ruleId ?? '', slaDays: st?.slaDays?.toString() ?? '', billable: st?.billable ?? true, active: st?.active ?? true,
    leaderId: st?.leaderId ?? null, managerId: st?.managerId ?? null, reviewerId: st?.reviewerId ?? null, assigneeId: st?.assigneeId ?? null,
  });
  const [checks, setChecks] = useState<Check[]>((st?.defaultChecks ?? []).map((c) => ({ key: c.key ?? '', label: c.label ?? '', required: !!c.required })));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, description: f.description || null, ruleId: f.ruleId || null, slaDays: f.slaDays ? Number(f.slaDays) : null,
        defaultChecks: checks.filter((c) => c.label.trim()).map((c, i) => ({ key: c.key || `c${i + 1}`, label: c.label.trim(), required: c.required })) };
      return st ? unwrap(api.PATCH('/service-types/{id}', { params: { path: { id: st.id } }, body })) : unwrap(api.POST('/service-types', { body }));
    },
    onSuccess: onSaved,
  });
  return (
    <Dialog title={st ? t('svc.editTitle') : t('svc.new')} onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('svc.name')}><input className="input" required value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label={t('svc.key')} hint={t('svc.keyHint')}><input className="input font-mono" required pattern="[A-Z0-9_]{2,40}" value={f.key} disabled={!!st} onChange={(e) => set('key', e.target.value.toUpperCase())} /></Field>
          <Field label={t('svc.category')}><input className="input" value={f.category} onChange={(e) => set('category', e.target.value)} /></Field>
          <Field label={t('svc.frequency')}>
            <select className="input" value={f.frequency} onChange={(e) => set('frequency', e.target.value as typeof f.frequency)}>
              {SERVICE_FREQUENCIES.map((x) => <option key={x} value={x}>{t(`svc.freq.${x}` as MessageKey)}</option>)}
            </select>
          </Field>
          <Field label={t('svc.rule')} hint={t('svc.ruleHint')}><input className="input font-mono" value={f.ruleId} onChange={(e) => set('ruleId', e.target.value)} /></Field>
          <Field label={t('svc.sla')}><input type="number" min="0" max="365" className="input" value={f.slaDays} onChange={(e) => set('slaDays', e.target.value)} /></Field>
          <PersonSelect label={t('tasks.leader')} value={f.leaderId} onChange={(v) => set('leaderId', v)} />
          <PersonSelect label={t('tasks.manager')} value={f.managerId} onChange={(v) => set('managerId', v)} />
          <PersonSelect label={t('tasks.f.assignee')} value={f.assigneeId} onChange={(v) => set('assigneeId', v)} />
          <PersonSelect label={t('tasks.reviewer')} value={f.reviewerId} onChange={(v) => set('reviewerId', v)} />
        </div>
        <Field label={t('svc.description')}><textarea className="input" value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.billable} onChange={(e) => set('billable', e.target.checked)} /> {t('svc.billable')}</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> {t('svc.active')}</label>
        </div>
        <fieldset className="space-y-1"><legend className="label">{t('svc.checks')}</legend>
          {checks.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className="input flex-1" aria-label={t('svc.checkLabel', { n: i + 1 })} value={c.label} onChange={(e) => setChecks((cs) => cs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={c.required} onChange={(e) => setChecks((cs) => cs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} /> {t('tasks.required')}</label>
              <button type="button" className="rounded p-1 text-muted" aria-label={t('common.delete')} onClick={() => setChecks((cs) => cs.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => setChecks((cs) => [...cs, { key: '', label: '', required: false }])}><Plus size={14} aria-hidden /> {t('svc.addCheck')}</button>
        </fieldset>
        {save.isError && <p role="alert" className="text-overdue">{ruleMsg(save.error)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={save.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}
