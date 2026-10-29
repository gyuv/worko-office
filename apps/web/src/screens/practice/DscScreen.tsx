import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateTime } from '@worko/i18n';
import { Plus, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { api } from '../../lib/session';
import { PersonSelect, useUsers } from '../tasks/shared';
import { TaskDrawer } from '../tasks/TaskDrawer';
import { as, body, useClientContacts, useP8Error, useP8Label, type Dsc, type DscDetail, type Licence } from './api';
import { BAND_CLASS, expiryBand } from './logic';

const CUSTODY = ['in_office', 'with_client', 'with_staff'] as const;

export function ExpiryBadge({ validTo }: { validTo: string | null }) {
  const t = useT();
  if (!validTo) return <span className="text-muted">—</span>;
  const b = expiryBand(validTo, todayIst());
  return <span data-testid="band" data-band={b} className={`rounded px-1.5 py-0.5 text-xs ${BAND_CLASS[b]}`}>{formatDate(validTo)} · {t(`p8.band.${b}`)}</span>;
}

/** Explicit: the register never stores token PINs or passwords (D117). */
function NoSecretsNote() {
  const t = useT();
  return <p className="flex items-start gap-2 rounded border border-border bg-surface-alt p-2 text-sm" data-testid="no-pins"><ShieldAlert size={16} className="mt-0.5 text-due-soon" aria-hidden /> {t('p8.dsc.noPins')}</p>;
}

export function DscScreen() {
  const t = useT();
  const can = useCan();
  const label = useP8Label();
  const [client, setClient] = useState<PickedClient | null>(null);
  const [custody, setCustody] = useState('');
  const [within, setWithin] = useState('');
  const [firm, setFirm] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const query = { ...(client ? { clientId: client.id } : {}), ...(custody ? { custody } : {}), ...(within ? { expiringWithinDays: Number(within) } : {}), ...(firm ? { firm: 'true' } : {}) };
  const q = useQuery({ queryKey: ['p8', 'dsc', query], enabled: can('dsc', 'view'), queryFn: () => as<Dsc[]>(api.GET('/dsc', { params: { query: query as never } })) });
  if (!can('dsc', 'view')) return <p className="card p-6 text-muted">{t('p8.noAccess')}</p>;
  return (
    <div className="space-y-3">
      <header className="flex items-center gap-2"><h1 className="text-xl font-semibold">{t('p8.nav.dsc')}</h1>
        {can('dsc', 'create') && <button className="btn btn-primary ml-auto" onClick={() => setCreating(true)}><Plus size={14} aria-hidden /> {t('p8.dsc.new')}</button>}</header>
      <NoSecretsNote />
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-60"><ClientPicker label={t('p8.f.client')} value={client} onChange={setClient} /></div>
        <Field label={t('p8.dsc.custody')}><select className="input" value={custody} onChange={(e) => setCustody(e.target.value)}><option value="">{t('p8.all')}</option>
          {CUSTODY.map((c) => <option key={c} value={c}>{label('custody', c)}</option>)}</select></Field>
        <Field label={t('p8.dsc.expiring')}><select className="input" value={within} onChange={(e) => setWithin(e.target.value)}><option value="">{t('p8.all')}</option>
          {['0', '7', '15', '30', '60'].map((d) => <option key={d} value={d}>{d === '0' ? t('p8.band.expired') : t('p8.dsc.withinDays', { days: d })}</option>)}</select></Field>
        <label className="flex items-center gap-2 pb-2"><input type="checkbox" checked={firm} onChange={(e) => setFirm(e.target.checked)} /> {t('p8.dsc.firmOnly')}</label>
      </div>
      {q.data && !q.data.length && <p className="card p-6 text-muted">{t('p8.dsc.none')}</p>}
      {!!q.data?.length && <div className="card overflow-auto"><table className="table w-full" aria-label={t('p8.nav.dsc')}>
        <thead><tr><th>{t('p8.dsc.holder')}</th><th>{t('p8.f.client')}</th><th>{t('p8.dsc.class')}</th><th>{t('p8.dsc.issuer')}</th><th>{t('p8.dsc.validTo')}</th><th>{t('p8.dsc.custody')}</th></tr></thead>
        <tbody>{q.data.map((d) => (
          <tr key={d.id}><td><button className="hover:underline" onClick={() => setOpen(d.id)}>{d.holderName}</button>{d.tokenLabel && <span className="block text-xs text-muted">{d.tokenLabel}</span>}</td>
            <td>{d.clientName ?? t('p8.dsc.firm')}</td><td>{d.dscClass} · {label('dtype', d.dscType)}</td><td>{d.issuer}</td><td><ExpiryBadge validTo={d.validTo} /></td><td>{label('custody', d.custody)}</td></tr>
        ))}</tbody>
      </table></div>}
      {open && <DscDialog id={open} onClose={() => setOpen(null)} />}
      {creating && <NewDsc onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewDsc({ onClose }: { onClose(): void }) {
  const t = useT();
  const err = useP8Error();
  const label = useP8Label();
  const qc = useQueryClient();
  const [kind, setKind] = useState<'client_contact' | 'staff'>('client_contact');
  const [client, setClient] = useState<PickedClient | null>(null);
  const contacts = (useClientContacts(kind === 'client_contact' ? client?.id ?? null : null).data?.contacts ?? []) as Array<{ id: string; name: string }>;
  const [contactId, setContact] = useState('');
  const [userId, setUser] = useState<string | null>(null);
  const [f, setF] = useState({ dscClass: 'Class 3', dscType: 'sign', issuer: '', serialNo: '', validFrom: todayIst(), validTo: '', tokenLabel: '', custody: 'in_office' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ok = f.issuer.trim() && f.validTo && (kind === 'staff' ? !!userId : !!client && !!contactId);
  const m = useMutation({
    mutationFn: () => as(api.POST('/dsc', { body: body({
      holderKind: kind, ...(kind === 'client_contact' ? { clientId: client!.id, contactId } : { holderUserId: userId }),
      dscClass: f.dscClass, dscType: f.dscType, issuer: f.issuer.trim(), serialNo: f.serialNo.trim() || null, validFrom: f.validFrom, validTo: f.validTo, tokenLabel: f.tokenLabel.trim() || null, custody: f.custody,
    }) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['p8', 'dsc'] }); onClose(); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p8.dsc.new')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ok) m.mutate(); }}>
        <NoSecretsNote />
        <fieldset className="flex gap-4"><legend className="label">{t('p8.dsc.holder')}</legend>
          <label className="flex items-center gap-2"><input type="radio" checked={kind === 'client_contact'} onChange={() => setKind('client_contact')} /> {t('p8.dsc.clientContact')}</label>
          <label className="flex items-center gap-2"><input type="radio" checked={kind === 'staff'} onChange={() => setKind('staff')} /> {t('p8.dsc.staff')}</label></fieldset>
        {kind === 'client_contact' ? <>
          <ClientPicker label={t('p8.f.client')} value={client} onChange={setClient} />
          <Field label={t('p8.dsc.contact')}><select className="input" value={contactId} onChange={(e) => setContact(e.target.value)}><option value="">—</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        </> : <PersonSelect label={t('p8.dsc.staff')} value={userId} onChange={setUser} />}
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('p8.dsc.class')}><input className="input" value={f.dscClass} onChange={set('dscClass')} /></Field>
          <Field label={t('p8.dsc.type')}><select className="input" value={f.dscType} onChange={set('dscType')}>{['sign', 'encrypt', 'combo'].map((x) => <option key={x} value={x}>{label('dtype', x)}</option>)}</select></Field>
          <Field label={t('p8.dsc.issuer')}><input className="input" value={f.issuer} onChange={set('issuer')} required /></Field>
          <Field label={t('p8.dsc.serial')}><input className="input" value={f.serialNo} onChange={set('serialNo')} /></Field>
          <Field label={t('p8.dsc.validFrom')}><input type="date" className="input" value={f.validFrom} onChange={set('validFrom')} required /></Field>
          <Field label={t('p8.dsc.validTo')}><input type="date" className="input" value={f.validTo} min={f.validFrom} onChange={set('validTo')} required /></Field>
          <Field label={t('p8.dsc.tokenLabel')}><input className="input" value={f.tokenLabel} onChange={set('tokenLabel')} /></Field>
          <Field label={t('p8.dsc.custody')}><select className="input" value={f.custody} onChange={set('custody')}>{CUSTODY.filter((c) => c !== 'with_staff').map((c) => <option key={c} value={c}>{label('custody', c)}</option>)}</select></Field>
        </div>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={!ok || m.isPending}>{t('p8.create')}</button></div>
      </form>
    </Dialog>
  );
}

function DscDialog({ id, onClose }: { id: string; onClose(): void }) {
  const t = useT();
  const err = useP8Error();
  const label = useP8Label();
  const can = useCan();
  const me = useMe().data;
  const { name } = useUsers();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p8', 'dsc', id], queryFn: () => as<DscDetail>(api.GET('/dsc/{id}', { params: { path: { id } } })) });
  const [to, setTo] = useState<string>('in_office');
  const [toUser, setToUser] = useState<string | null>(null);
  const [counterparty, setCp] = useState('');
  const [purpose, setPurpose] = useState('');
  const [ackName, setAckName] = useState('');
  const [task, setTask] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['p8', 'dsc'] });
  const move = useMutation({
    mutationFn: () => as(api.POST('/dsc/{id}/custody', { params: { path: { id } }, body: body({ to, toUserId: to === 'with_staff' ? toUser : null, counterparty: counterparty.trim() || null, purpose: purpose.trim() || null }) })),
    onSuccess: () => { setCp(''); setPurpose(''); refresh(); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const ack = useMutation({
    mutationFn: (mid: string) => as(api.POST('/dsc/custody/{id}/acknowledge', { params: { path: { id: mid } }, body: body(ackName.trim() ? { name: ackName.trim() } : {}) })),
    onSuccess: refresh, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const d = q.data;
  const latest = d?.custodyLog[d.custodyLog.length - 1];
  const needsName = latest && latest.toCustody !== 'with_staff';
  return (
    <Dialog title={d ? `${d.holderName} · ${d.dscClass}` : t('common.loading')} onClose={onClose} wide>
      {d && <div className="space-y-3">
        <NoSecretsNote />
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">{t('p8.f.client')}</dt><dd>{d.clientName ?? t('p8.dsc.firm')}</dd>
          <dt className="text-muted">{t('p8.dsc.issuer')}</dt><dd>{d.issuer}{d.serialNo ? ` · ${d.serialNo}` : ''}</dd>
          <dt className="text-muted">{t('p8.dsc.validTo')}</dt><dd><ExpiryBadge validTo={d.validTo} /> <span className="text-xs text-muted">{t('p8.dsc.daysLeft', { days: d.daysLeft })}</span></dd>
          <dt className="text-muted">{t('p8.dsc.custody')}</dt><dd>{label('custody', d.custody)}{d.custodyUserId ? ` · ${name(d.custodyUserId)}` : ''}</dd>
        </dl>
        {d.renewalTaskId && <button className="btn" onClick={() => setTask(d.renewalTaskId)}>{t('p8.dsc.renewalTask')}</button>}
        <section aria-label={t('p8.dsc.timeline')}><h3 className="font-medium">{t('p8.dsc.timeline')}</h3>
          {!d.custodyLog.length && <p className="text-sm text-muted">{t('p8.dsc.noMoves')}</p>}
          <ol className="space-y-1 border-l border-border pl-3 text-sm">{d.custodyLog.map((m) => (
            <li key={m.id}><span className="text-muted">{formatDateTime(m.movedAt)}</span> · {label('custody', m.fromCustody)} → <b>{label('custody', m.toCustody)}</b>{m.toUserId ? ` (${name(m.toUserId)})` : ''}
              {m.counterparty ? ` · ${m.counterparty}` : ''}{m.purpose ? ` · ${m.purpose}` : ''} · {t('p8.dsc.by', { who: name(m.movedBy) })}
              {m.acknowledgedAt ? <span className="block text-xs text-done">{t('p8.dsc.acked', { who: m.acknowledgedName ?? name(m.acknowledgedBy), when: formatDateTime(m.acknowledgedAt) })}</span>
                : m.id === latest?.id && (m.toUserId === me?.id || (needsName && m.movedBy === me?.id)) && <span className="mt-1 flex flex-wrap items-center gap-2">
                  {needsName && <input className="input w-48" aria-label={t('p8.dsc.receiverName')} placeholder={t('p8.dsc.receiverName')} value={ackName} onChange={(e) => setAckName(e.target.value)} />}
                  <button className="btn" disabled={!!needsName && !ackName.trim()} onClick={() => ack.mutate(m.id)}>{t('p8.dsc.acknowledge')}</button></span>}
            </li>
          ))}</ol></section>
        {can('dsc', 'edit') && <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); move.mutate(); }} aria-label={t('p8.dsc.move')}>
          <Field label={t('p8.dsc.moveTo')}><select className="input" value={to} onChange={(e) => setTo(e.target.value)}>{CUSTODY.map((c) => <option key={c} value={c}>{label('custody', c)}</option>)}</select></Field>
          {to === 'with_staff' ? <PersonSelect label={t('p8.dsc.staff')} value={toUser} onChange={setToUser} allowNone={false} />
            : <Field label={t('p8.dsc.counterparty')}><input className="input" value={counterparty} onChange={(e) => setCp(e.target.value)} /></Field>}
          <Field label={t('p8.dsc.purpose')}><input className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
          <div className="flex items-end"><button className="btn btn-primary" disabled={move.isPending || (to === 'with_staff' && !toUser)}>{t('p8.dsc.move')}</button></div>
        </form>}
      </div>}
      {task && <TaskDrawer id={task} onClose={() => setTask(null)} />}
    </Dialog>
  );
}

// ---------- Licences ----------
const LIC_STATUS = ['active', 'renewal_in_progress', 'lapsed', 'surrendered'] as const;

export function LicencesScreen() {
  const t = useT();
  const can = useCan();
  const label = useP8Label();
  const [client, setClient] = useState<PickedClient | null>(null);
  const [status, setStatus] = useState('');
  const [due, setDue] = useState('');
  const [type, setType] = useState('');
  const [editing, setEditing] = useState<Licence | 'new' | null>(null);
  const query = { ...(client ? { clientId: client.id } : {}), ...(status ? { status } : {}), ...(due ? { dueWithinDays: Number(due) } : {}) };
  const q = useQuery({ queryKey: ['p8', 'licences', query], enabled: can('compliance', 'view'), queryFn: () => as<Licence[]>(api.GET('/licences', { params: { query: query as never } })) });
  if (!can('compliance', 'view')) return <p className="card p-6 text-muted">{t('p8.noAccess')}</p>;
  const rows = (q.data ?? []).filter((l) => !type || l.licenceType === type);
  const types = [...new Set((q.data ?? []).map((l) => l.licenceType))];
  return (
    <div className="space-y-3">
      <header className="flex items-center gap-2"><h1 className="text-xl font-semibold">{t('p8.nav.licences')}</h1>
        {can('compliance', 'create') && <button className="btn btn-primary ml-auto" onClick={() => setEditing('new')}><Plus size={14} aria-hidden /> {t('p8.lic.new')}</button>}</header>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-60"><ClientPicker label={t('p8.f.client')} value={client} onChange={setClient} /></div>
        <Field label={t('p8.lic.type')}><select className="input" value={type} onChange={(e) => setType(e.target.value)}><option value="">{t('p8.all')}</option>{types.map((x) => <option key={x} value={x}>{label('ltype', x)}</option>)}</select></Field>
        <Field label={t('p8.f.status')}><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('p8.all')}</option>{LIC_STATUS.map((x) => <option key={x} value={x}>{label('lstatus', x)}</option>)}</select></Field>
        <Field label={t('p8.lic.renewalDue')}><select className="input" value={due} onChange={(e) => setDue(e.target.value)}><option value="">{t('p8.all')}</option>
          {['30', '60', '90'].map((d) => <option key={d} value={d}>{t('p8.dsc.withinDays', { days: d })}</option>)}</select></Field>
      </div>
      {q.data && !rows.length && <p className="card p-6 text-muted">{t('p8.lic.none')}</p>}
      {!!rows.length && <div className="card overflow-auto"><table className="table w-full" aria-label={t('p8.nav.licences')}>
        <thead><tr><th>{t('p8.f.client')}</th><th>{t('p8.lic.type')}</th><th>{t('p8.lic.number')}</th><th>{t('p8.lic.validTo')}</th><th>{t('p8.lic.renewalDue')}</th><th>{t('p8.f.status')}</th><th /></tr></thead>
        <tbody>{rows.map((l) => (
          <tr key={l.id}><td>{l.clientName}</td><td>{label('ltype', l.licenceType)}</td><td>{l.number ?? '—'}{l.authority && <span className="block text-xs text-muted">{l.authority}</span>}</td>
            <td><ExpiryBadge validTo={l.validTo} /></td><td><ExpiryBadge validTo={l.renewalDue} /></td><td>{label('lstatus', l.status)}</td>
            <td className="text-right">{can('compliance', 'edit') && <button className="btn" onClick={() => setEditing(l)}>{t('p8.edit')}</button>}</td></tr>
        ))}</tbody>
      </table></div>}
      {editing && <LicenceDialog l={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function LicenceDialog({ l, onClose }: { l: Licence | null; onClose(): void }) {
  const t = useT();
  const err = useP8Error();
  const label = useP8Label();
  const qc = useQueryClient();
  const [client, setClient] = useState<PickedClient | null>(l ? { id: l.clientId, name: l.clientName ?? '' } : null);
  const [f, setF] = useState({ licenceType: l?.licenceType ?? 'trade_licence', number: l?.number ?? '', authority: l?.authority ?? '', validFrom: l?.validFrom ?? '', validTo: l?.validTo ?? '',
    renewalDue: l?.renewalDue ?? '', status: l?.status ?? 'active', notes: l?.notes ?? '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const payload = { licenceType: f.licenceType, number: f.number.trim() || null, authority: f.authority.trim() || null, validFrom: f.validFrom || null, validTo: f.validTo || null,
    renewalDue: f.renewalDue || null, status: f.status, notes: f.notes.trim() || null };
  const m = useMutation({
    mutationFn: () => l ? as(api.PATCH('/licences/{id}', { params: { path: { id: l.id } }, body: body(payload) })) : as(api.POST('/licences', { body: body({ clientId: client!.id, ...payload }) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['p8', 'licences'] }); onClose(); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={l ? t('p8.lic.edit') : t('p8.lic.new')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (client) m.mutate(); }}>
        {!l && <ClientPicker label={t('p8.f.client')} value={client} onChange={setClient} />}
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('p8.lic.type')} hint={t('p8.lic.typeHint')}><input className="input" list="lic-types" pattern="[a-z0-9_]{2,40}" value={f.licenceType} onChange={set('licenceType')} required /></Field>
          <datalist id="lic-types">{['trade_licence', 'fssai', 'iec', 'udyam', 'professional_tax', 'shops_establishment'].map((x) => <option key={x} value={x}>{label('ltype', x)}</option>)}</datalist>
          <Field label={t('p8.lic.number')}><input className="input" value={f.number} onChange={set('number')} /></Field>
          <Field label={t('p8.lic.authority')}><input className="input" value={f.authority} onChange={set('authority')} /></Field>
          <Field label={t('p8.f.status')}><select className="input" value={f.status} onChange={set('status')}>{LIC_STATUS.map((x) => <option key={x} value={x}>{label('lstatus', x)}</option>)}</select></Field>
          <Field label={t('p8.dsc.validFrom')}><input type="date" className="input" value={f.validFrom} onChange={set('validFrom')} /></Field>
          <Field label={t('p8.lic.validTo')}><input type="date" className="input" value={f.validTo} onChange={set('validTo')} /></Field>
          <Field label={t('p8.lic.renewalDue')}><input type="date" className="input" value={f.renewalDue} onChange={set('renewalDue')} /></Field>
        </div>
        <Field label={t('p8.f.note')}><textarea className="input" value={f.notes} onChange={set('notes')} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={!client || m.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}
