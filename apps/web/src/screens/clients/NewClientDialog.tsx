import { useMutation, useQuery } from '@tanstack/react-query';
import { ENTITY_TYPES, entityHintFromPan, GST_STATES, isValidGstin, isValidPan, panFromGstin, type EntityType } from '@worko/domain';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Schemas } from '@worko/api-client';
import { Dialog, Field } from '../../components/Dialog';
import { errStatus, useDebounced } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { entityKey } from './labels';

type Form = {
  gstin: string; pan: string; entityType: EntityType; name: string; tradeName: string; email: string; phone: string;
  line1: string; city: string; state: string; pin: string; contactName: string; contactPhone: string; tags: string; sensitive: boolean;
};
const empty: Form = { gstin: '', pan: '', entityType: 'INDIVIDUAL', name: '', tradeName: '', email: '', phone: '', line1: '', city: '', state: '', pin: '', contactName: '', contactPhone: '', tags: '', sensitive: false };

export const phoneE164 = (digits: string) => (digits.trim() ? `+91${digits.replace(/\D/g, '').slice(-10)}` : undefined);

export function buildClientBody(f: Form): Schemas['ClientCreate'] {
  const gstin = f.gstin.trim().toUpperCase();
  return {
    name: f.name.trim(), entityType: f.entityType,
    tradeName: f.tradeName.trim() || null,
    pan: f.pan.trim().toUpperCase() || null,
    email: f.email.trim() || null,
    phone: phoneE164(f.phone) ?? null,
    addresses: f.line1.trim() ? [{ kind: 'registered', line1: f.line1.trim(), city: f.city.trim(), state: f.state.trim(), pin: f.pin.trim() }] : [],
    registrations: gstin ? [{ kind: 'GSTIN', number: gstin, stateCode: gstin.slice(0, 2), isPrimary: true }] : [],
    contacts: f.contactName.trim() ? [{ name: f.contactName.trim(), phone: phoneE164(f.contactPhone) ?? null, isPrimary: true }] : [],
    tags: f.tags.split(',').map((x) => x.trim()).filter(Boolean),
    sensitive: f.sensitive,
  };
}

export function NewClientDialog({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const t = useT();
  const [f, setF] = useState<Form>(empty);
  const [panTouched, setPanTouched] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  const gstin = f.gstin.trim().toUpperCase();
  const gstinOk = gstin.length === 15 && isValidGstin(gstin);
  const gstinError = gstin && (gstin.length > 15 || (gstin.length === 15 && !gstinOk)) ? t('clients.gstinInvalid') : null;
  const pan = f.pan.trim().toUpperCase();
  const panError = pan.length >= 10 && !isValidPan(pan) ? t('clients.panInvalid') : null;

  const lookup = useQuery({
    queryKey: ['gstin', gstin],
    queryFn: () => unwrap(api.GET('/lookup/gstin/{gstin}', { params: { path: { gstin } } })),
    enabled: gstinOk, retry: false, staleTime: Infinity,
  });
  // GSTIN → PAN (chars 3–12) and state; lookup → entity type. Never overwrite what the user typed after the fact.
  useEffect(() => {
    if (!gstinOk) return;
    setF((p) => ({ ...p, pan: panTouched && p.pan ? p.pan : panFromGstin(gstin), state: p.state || (GST_STATES[gstin.slice(0, 2)] ?? '') }));
  }, [gstinOk, gstin, panTouched]);
  const lk = lookup.data;
  useEffect(() => {
    if (!lk) return;
    setF((p) => ({
      ...p,
      entityType: lk.entityType && ENTITY_TYPES.includes(lk.entityType as EntityType) ? (lk.entityType as EntityType) : p.entityType,
      state: lk.state || p.state,
    }));
  }, [lk]);
  useEffect(() => {
    if (lk || !isValidPan(pan)) return;
    const hint = entityHintFromPan(pan);
    if (hint) setF((p) => ({ ...p, entityType: hint }));
  }, [pan, lk]);

  // Debounce a string (stable identity) rather than an object.
  const dupKey = useDebounced(JSON.stringify({ name: f.name.trim(), pan: isValidPan(pan) ? pan : '', gstin: gstinOk ? gstin : '', phone: phoneE164(f.phone) ?? '' }), 400);
  const dupInput = JSON.parse(dupKey) as { name: string; pan: string; gstin: string; phone: string };
  const dups = useQuery({
    queryKey: ['clients', 'dups', dupKey],
    queryFn: () => unwrap(api.POST('/clients/duplicates', { body: Object.fromEntries(Object.entries(dupInput).filter(([, v]) => v)) })),
    enabled: dupInput.name.length >= 3 || !!dupInput.pan || !!dupInput.gstin || dupInput.phone.length === 13,
  });

  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/clients', { body: buildClientBody(f) })),
    onSuccess: (r) => onCreated(r.id),
  });
  const valid = f.name.trim() && !gstinError && !panError;

  return (
    <Dialog title={t('clients.new')} onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="GSTIN" error={gstinError} hint={gstinOk ? (lookup.isFetching ? t('common.loading') : t('clients.gstinValid')) : t('clients.gstinHint')}>
            <input className="input font-mono uppercase" maxLength={15} value={f.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} aria-invalid={!!gstinError} />
          </Field>
          <Field label="PAN" error={panError}>
            <input className="input font-mono uppercase" maxLength={10} value={f.pan} onChange={(e) => { setPanTouched(true); set('pan', e.target.value.toUpperCase()); }} aria-invalid={!!panError} />
          </Field>
        </div>
        {lk && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-surface-alt px-3 py-2 text-sm">
            <span>{t('clients.lookupFound', { name: lk.legalName, state: lk.state, status: lk.status })}</span>
            {f.name !== lk.legalName && <button type="button" className="btn" onClick={() => setF((p) => ({ ...p, name: lk.legalName, tradeName: p.tradeName || (lk.tradeName ?? '') }))}>{t('clients.useName')}</button>}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('clients.name')}><input className="input" required value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label={t('clients.tradeName')}><input className="input" value={f.tradeName} onChange={(e) => set('tradeName', e.target.value)} /></Field>
          <Field label={t('clients.entityType')}>
            <select className="input" value={f.entityType} onChange={(e) => set('entityType', e.target.value as EntityType)}>
              {ENTITY_TYPES.map((x) => <option key={x} value={x}>{t(entityKey(x))}</option>)}
            </select>
          </Field>
          <Field label={t('clients.email')}><input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label={t('clients.phone')}>
            <div className="flex"><span className="input w-auto rounded-r-none border-r-0 text-muted">+91</span>
              <input className="input rounded-l-none" inputMode="tel" maxLength={10} value={f.phone} onChange={(e) => set('phone', e.target.value.replace(/\D/g, ''))} /></div>
          </Field>
          <Field label={t('clients.tags')} hint={t('clients.tagsHint')}><input className="input" value={f.tags} onChange={(e) => set('tags', e.target.value)} /></Field>
        </div>
        <fieldset className="grid gap-3 sm:grid-cols-4">
          <legend className="label">{t('clients.address')}</legend>
          <div className="sm:col-span-4"><Field label={t('clients.addressLine')}><input className="input" value={f.line1} onChange={(e) => set('line1', e.target.value)} /></Field></div>
          <div className="sm:col-span-2"><Field label={t('clients.city')}><input className="input" value={f.city} onChange={(e) => set('city', e.target.value)} /></Field></div>
          <Field label={t('clients.state')}><input className="input" value={f.state} onChange={(e) => set('state', e.target.value)} /></Field>
          <Field label={t('clients.pin')}><input className="input" inputMode="numeric" maxLength={6} value={f.pin} onChange={(e) => set('pin', e.target.value.replace(/\D/g, ''))} /></Field>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('clients.contactPerson')}><input className="input" value={f.contactName} onChange={(e) => set('contactName', e.target.value)} /></Field>
          <Field label={t('clients.contactPhone')}><input className="input" inputMode="tel" maxLength={10} value={f.contactPhone} onChange={(e) => set('contactPhone', e.target.value.replace(/\D/g, ''))} /></Field>
        </div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.sensitive} onChange={(e) => set('sensitive', e.target.checked)} /> {t('clients.sensitive')}</label>
        <DuplicatePanel data={dups.data} />
        <div aria-live="polite">
          {create.isError && <p role="alert" className="text-overdue">{errStatus(create.error) === 409 ? t('clients.conflict') : (create.error as Error).message}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!valid || create.isPending}>{t('clients.create')}</button>
        </div>
      </form>
    </Dialog>
  );
}

type Dups = { hidden: number; matches: Array<{ id: string; name: string; pan?: string | null; fileNo?: string | null }> };
function DuplicatePanel({ data }: { data?: Dups }) {
  const t = useT();
  if (!data || (!data.matches.length && !data.hidden)) return null;
  return (
    <div role="status" aria-live="polite" className="rounded-md border border-border bg-surface-alt px-3 py-2 text-sm">
      <div className="flex items-center gap-2 font-medium"><AlertTriangle size={14} aria-hidden /> {t('clients.possibleDuplicates')}</div>
      <ul className="mt-1 space-y-0.5">
        {data.matches.map((m) => <li key={m.id}><a className="underline" href={`#/clients/${m.id}`} target="_blank" rel="noreferrer">{m.name}</a> <span className="text-muted">{[m.fileNo, m.pan].filter(Boolean).join(' · ')}</span></li>)}
      </ul>
      {data.hidden > 0 && <p className="mt-1 text-muted">{t('clients.hiddenDuplicates', { count: data.hidden })}</p>}
    </div>
  );
}
