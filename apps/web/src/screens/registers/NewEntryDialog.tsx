import { useMutation } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field } from '../../components/Dialog';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import type { Kind } from './RegisterList';

const MODES: Record<Kind, readonly string[]> = {
  inward: ['physical', 'email', 'whatsapp', 'courier', 'portal', 'other'],
  outward: ['hand', 'courier', 'email', 'whatsapp', 'post', 'other'],
};
type Item = { description: string; qty: number; original: boolean };

export function NewEntryDialog({ kind, client: fixed, onClose, onCreated }: { kind: Kind; client: PickedClient | null; onClose(): void; onCreated(number: string): void }) {
  const t = useT();
  const [client, setClient] = useState<PickedClient | null>(fixed);
  const [date, setDate] = useState(todayIst());
  const [mode, setMode] = useState(MODES[kind][0]!);
  const [person, setPerson] = useState('');
  const [phone, setPhone] = useState('');
  const [courier, setCourier] = useState('');
  const [tracking, setTracking] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<Item[]>([{ description: '', qty: 1, original: false }]);
  const [flag, setFlag] = useState(false);
  const [dueBack, setDueBack] = useState('');

  const body = (): Schemas['RegisterEntryIn'] => {
    const its = items.filter((i) => i.description.trim()).map((i) => ({ description: i.description.trim(), qty: i.qty, original: i.original }));
    const ph = phone ? `+91${phone.slice(-10)}` : null;
    return kind === 'inward'
      ? { client_id: client!.id, received_on: date, mode, from_name: person || null, from_phone: ph, description: description.trim(), items: its, returnable: flag, due_back: flag && dueBack ? dueBack : null }
      : { client_id: client!.id, sent_on: date, mode, to_name: person || null, to_phone: ph, courier_name: courier || null, tracking_no: tracking || null, description: description.trim(), items: its, original: its.some((i) => i.original), to_be_received_back: flag };
  };
  const save = useMutation({
    mutationFn: () => unwrap(api.POST('/registers/{kind}', { params: { path: { kind } }, body: body() })),
    onSuccess: (r) => onCreated(r.number),
  });
  const setItem = (i: number, p: Partial<Item>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <Dialog title={t(kind === 'inward' ? 'reg.newInward' : 'reg.newOutward')} onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (client) save.mutate(); }}>
        {fixed ? <p className="font-medium">{fixed.name}</p> : <ClientPicker label={t('docs.client')} value={client} onChange={setClient} />}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t(kind === 'inward' ? 'reg.receivedOn.label' : 'reg.sentOn')}><input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={t('reg.mode')}>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>{MODES[kind].map((m) => <option key={m} value={m}>{t(`reg.mode.${m}` as 'reg.mode.other')}</option>)}</select>
          </Field>
          <Field label={t(kind === 'inward' ? 'reg.fromName' : 'reg.toName')}><input className="input" value={person} onChange={(e) => setPerson(e.target.value)} /></Field>
          <Field label={t('clients.phone')}><input className="input" inputMode="tel" maxLength={10} placeholder="+91" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} /></Field>
          {kind === 'outward' && mode === 'courier' && <>
            <Field label={t('reg.courier')}><input className="input" value={courier} onChange={(e) => setCourier(e.target.value)} /></Field>
            <Field label={t('reg.tracking')}><input className="input" value={tracking} onChange={(e) => setTracking(e.target.value)} /></Field>
          </>}
        </div>
        <Field label={t('reg.description')}><input className="input" required value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <fieldset className="space-y-1">
          <legend className="label">{t('reg.items')}</legend>
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-2">
              <input aria-label={t('reg.itemDescription', { n: i + 1 })} className="input flex-1" value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} />
              <input aria-label={t('reg.qty', { n: i + 1 })} className="input w-16" type="number" min={1} value={it.qty} onChange={(e) => setItem(i, { qty: Math.max(1, Number(e.target.value)) })} />
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={it.original} onChange={(e) => setItem(i, { original: e.target.checked })} /> {t('reg.original')}</label>
              {items.length > 1 && <button type="button" className="rounded p-1 text-muted" aria-label={t('reg.removeItem', { n: i + 1 })} onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}><X size={14} /></button>}
            </div>
          ))}
          <button type="button" className="btn" onClick={() => setItems((xs) => [...xs, { description: '', qty: 1, original: false }])}><Plus size={14} aria-hidden /> {t('reg.addItem')}</button>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={flag} onChange={(e) => setFlag(e.target.checked)} /> {t(kind === 'inward' ? 'reg.returnable' : 'reg.toBeReceivedBack')}</label>
          {kind === 'inward' && flag && <label className="text-sm">{t('reg.dueBack')} <input type="date" className="input w-40" value={dueBack} onChange={(e) => setDueBack(e.target.value)} /></label>}
        </div>
        {save.isError && <p role="alert" className="text-overdue">{(save.error as Error).message}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!client || !description.trim() || save.isPending}>{t('common.save')}</button>
        </div>
      </form>
    </Dialog>
  );
}
