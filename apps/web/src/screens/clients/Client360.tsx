import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { ArrowLeft, Eye, EyeOff, Mail, MessageCircle, Pencil, Phone, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Field, Tabs } from '../../components/Dialog';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { errStatus } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { StepUpCancelled, withStepUp } from '../../lib/stepup';
import { DocumentsPanel } from '../documents/DocumentsPanel';
import { RegisterList } from '../registers/RegisterList';
import { CredentialsTab } from './CredentialsTab';
import { useEntityLabel } from './labels';

type Detail = Schemas['ClientDetail'];
type Tab = 'overview' | 'documents' | 'credentials' | 'registers' | 'access' | 'merge';

export const waLink = (phone: string) => `https://wa.me/${phone.replace(/\D/g, '').replace(/^(\d{10})$/, '91$1')}`;

export function Client360({ id }: { id: string }) {
  const t = useT();
  const go = useRoute((s) => s.go);
  const qc = useQueryClient();
  const entity = useEntityLabel();
  const q = useQuery({ queryKey: ['client', id], queryFn: () => unwrap(api.GET('/clients/{id}', { params: { path: { id } } })), retry: false });
  const [tab, setTab] = useState<Tab>('overview');
  const [seen, setSeen] = useState<Set<Tab>>(new Set(['overview']));
  const pick = (k: Tab) => { setTab(k); setSeen((s) => new Set(s).add(k)); };
  const del = useMutation({
    mutationFn: () => unwrap(api.DELETE('/clients/{id}', { params: { path: { id } } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['clients'] }); go('clients'); },
  });

  if (q.isError) return <div role="alert" className="card p-6">{errStatus(q.error) === 404 || errStatus(q.error) === 403 ? t('clients.notFound') : t('common.error')} <a className="underline" href="#/clients">{t('clients.backToList')}</a></div>;
  const c = q.data;
  if (!c) return <p className="text-muted" aria-live="polite">{t('common.loading')}</p>;
  const gstins = c.registrations.filter((r) => r.kind === 'GSTIN');
  const tabs: Array<[Tab, string]> = [
    ['overview', t('client360.overview')],
    ...(c.counts.documents !== null ? [['documents', `${t('nav.documents')} (${c.counts.documents})`] as [Tab, string]] : []),
    ...(c.can.vault ? [['credentials', `${t('client360.credentials')} (${c.counts.secrets})`] as [Tab, string]] : []),
    ...(c.counts.inward !== null ? [['registers', `${t('nav.registers')} (${c.counts.inward + (c.counts.outward ?? 0)})`] as [Tab, string]] : []),
    ...(c.can.edit ? [['access', t('client360.access')] as [Tab, string]] : []),
    ...(c.can.delete ? [['merge', t('client360.merge')] as [Tab, string]] : []),
  ];
  const panel = (k: Tab, node: ReactNode) => seen.has(k) && <div role="tabpanel" hidden={tab !== k} aria-label={tabs.find(([x]) => x === k)?.[1]}>{node}</div>;

  return (
    <div className="space-y-3">
      <a href="#/clients" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> {t('nav.clients')}</a>
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{c.name}{c.sensitive && <span className="ml-2 rounded bg-surface-alt px-1.5 py-0.5 text-xs font-normal text-overdue">{t('clients.sensitiveBadge')}</span>}</h1>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-muted">
            {c.fileNo && <span>{c.fileNo}</span>}
            <span>{entity(c.entityType)}</span>
            {c.pan && <span className="font-mono">PAN {c.pan}</span>}
            {gstins.map((g) => <span key={g.id} className="font-mono">GSTIN {g.number}</span>)}
            <span className="capitalize">{c.status}</span>
          </div>
          {c.tags.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{c.tags.map((x) => <span key={x} className="rounded bg-surface-alt px-1.5 py-0.5 text-xs">{x}</span>)}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {c.phone && <a className="btn" href={`tel:${c.phone}`}><Phone size={14} aria-hidden /> {t('client360.call')}</a>}
          {c.phone && <a className="btn" href={waLink(c.phone)} target="_blank" rel="noreferrer"><MessageCircle size={14} aria-hidden /> WhatsApp</a>}
          {c.email && <a className="btn" href={`mailto:${c.email}`}><Mail size={14} aria-hidden /> {t('clients.email')}</a>}
          {c.can.delete && <button className="btn btn-danger" onClick={() => confirm(t('client360.deleteConfirm', { name: c.name })) && del.mutate()}><Trash2 size={14} aria-hidden /> {t('common.delete')}</button>}
        </div>
      </header>
      <Tabs label={c.name} tabs={tabs} value={tab} onChange={pick} />
      {panel('overview', <Overview c={c} />)}
      {panel('documents', <DocumentsPanel clientId={c.id} />)}
      {panel('credentials', <CredentialsTab clientId={c.id} />)}
      {panel('registers', <RegisterList clientId={c.id} />)}
      {panel('access', <AccessTab c={c} />)}
      {panel('merge', <MergeTab c={c} />)}
    </div>
  );
}

function useClientPatch(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas['ClientFields']) => unwrap(api.PATCH('/clients/{id}', { params: { path: { id } }, body })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['client', id] }); void qc.invalidateQueries({ queryKey: ['clients'] }); },
  });
}

type EditKey = 'name' | 'tradeName' | 'fileNo' | 'email' | 'phone' | 'pan' | 'tan' | 'cin' | 'udyam' | 'iec' | 'notes';
const EDITABLE: EditKey[] = ['name', 'tradeName', 'fileNo', 'pan', 'tan', 'cin', 'udyam', 'iec', 'email', 'phone', 'notes'];

function Overview({ c }: { c: Detail }) {
  const t = useT();
  const patch = useClientPatch(c.id);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card p-4">
        <h2 className="mb-2 font-semibold">{t('client360.profile')}</h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
          {EDITABLE.map((k) => <EditableRow key={k} label={t(`clientField.${k}`)} value={(c[k] as string | null | undefined) ?? ''} canEdit={c.can.edit}
            onSave={(v) => patch.mutateAsync({ [k]: k === 'name' ? v : v || null })} />)}
          <dt className="text-muted">{t('clients.status')}</dt>
          <dd>{c.can.edit
            ? <select aria-label={t('clients.status')} className="input w-40" value={c.status} onChange={(e) => patch.mutate({ status: e.target.value as 'active' })}>
                {(['active', 'inactive', 'prospect'] as const).map((s) => <option key={s} value={s}>{t(`clients.status.${s}`)}</option>)}
              </select>
            : <span className="capitalize">{c.status}</span>}</dd>
          <EditableRow label={t('clients.tags')} value={c.tags.join(', ')} canEdit={c.can.edit} onSave={(v) => patch.mutateAsync({ tags: v.split(',').map((x) => x.trim()).filter(Boolean) })} />
          {(c.addresses ?? []).map((a, i) => <AddressRow key={i} a={a} />)}
        </dl>
        <div aria-live="polite" className="mt-2 text-sm">{patch.isError && <span role="alert" className="text-overdue">{(patch.error as Error).message}</span>}</div>
      </section>
      <div className="space-y-4">
        <Registrations c={c} />
        <Contacts c={c} />
        <section className="card p-4">
          <h2 className="mb-2 font-semibold">{t('client360.groups')}</h2>
          {c.groups.length ? <div className="flex flex-wrap gap-1">{c.groups.map((g) => <span key={g.id} className="rounded bg-surface-alt px-2 py-0.5">{g.name}</span>)}</div> : <p className="text-muted">{t('client360.noGroups')}</p>}
        </section>
        <SensitiveSection c={c} />
      </div>
    </div>
  );
}

function AddressRow({ a }: { a: Schemas['Address'] }) {
  const t = useT();
  return <><dt className="text-muted">{t('clients.address')}</dt><dd>{[a.line1, a.line2, a.city, a.state, a.pin].filter(Boolean).join(', ')}</dd></>;
}

function EditableRow({ label, value, canEdit, onSave }: { label: string; value: string; canEdit: boolean; onSave(v: string): Promise<unknown> }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!editing) setV(value); }, [value, editing]);
  const save = async () => { setBusy(true); try { await onSave(v.trim()); setEditing(false); } catch { /* error shown by caller */ } finally { setBusy(false); } };
  return (
    <>
      <dt className="py-1 text-muted">{label}</dt>
      <dd className="group flex min-h-8 items-center gap-1">
        {editing ? (
          <form className="flex flex-1 gap-1" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <input aria-label={label} className="input" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }} />
            <button className="btn btn-primary" disabled={busy}>{t('common.save')}</button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>{t('common.cancel')}</button>
          </form>
        ) : (
          <>
            <span className="min-w-0 flex-1 break-words">{value || <span className="text-muted">—</span>}</span>
            {canEdit && <button className="rounded p-1 text-muted opacity-60 hover:text-fg group-hover:opacity-100" aria-label={t('client360.editField', { field: label })} onClick={() => setEditing(true)}><Pencil size={13} /></button>}
          </>
        )}
      </dd>
    </>
  );
}

const REG_KINDS = ['GSTIN', 'TAN', 'CIN', 'LLPIN', 'DIN', 'UDYAM', 'IEC', 'PF', 'ESI', 'PT', 'FSSAI', 'SHOPS', 'OTHER'] as const;

function Registrations({ c }: { c: Detail }) {
  const t = useT();
  const qc = useQueryClient();
  const [kind, setKind] = useState<(typeof REG_KINDS)[number]>('GSTIN');
  const [number, setNumber] = useState('');
  const add = useMutation({
    mutationFn: () => unwrap(api.POST('/clients/{id}/registrations', { params: { path: { id: c.id } }, body: { kind, number: number.trim().toUpperCase() } })),
    onSuccess: () => { setNumber(''); void qc.invalidateQueries({ queryKey: ['client', c.id] }); },
  });
  return (
    <section className="card p-4">
      <h2 className="mb-2 font-semibold">{t('client360.registrations')}</h2>
      {c.registrations.length ? (
        <ul className="mb-2 space-y-0.5">{c.registrations.map((r) => <li key={r.id} className="flex gap-2"><span className="w-16 text-muted">{r.kind}</span><span className="font-mono">{r.number}</span>{r.isPrimary && <span className="text-xs text-muted">{t('client360.primary')}</span>}</li>)}</ul>
      ) : <p className="mb-2 text-muted">{t('client360.noRegistrations')}</p>}
      {c.can.edit && (
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <select aria-label={t('client360.regKind')} className="input w-28" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{REG_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
          <input aria-label={t('client360.regNumber')} className="input flex-1 font-mono uppercase" value={number} onChange={(e) => setNumber(e.target.value)} />
          <button className="btn" disabled={!number.trim() || add.isPending}><Plus size={14} aria-hidden /> {t('common.add')}</button>
          {add.isError && <p role="alert" className="w-full text-sm text-overdue">{(add.error as Error).message}</p>}
        </form>
      )}
    </section>
  );
}

function Contacts({ c }: { c: Detail }) {
  const t = useT();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', role: '', phone: '', email: '' });
  const add = useMutation({
    mutationFn: () => unwrap(api.POST('/clients/{id}/contacts', { params: { path: { id: c.id } }, body: { name: f.name.trim(), role: f.role || null, phone: f.phone ? `+91${f.phone.slice(-10)}` : null, email: f.email || null } })),
    onSuccess: () => { setF({ name: '', role: '', phone: '', email: '' }); void qc.invalidateQueries({ queryKey: ['client', c.id] }); },
  });
  return (
    <section className="card p-4">
      <h2 className="mb-2 font-semibold">{t('client360.contacts')}</h2>
      {c.contacts.length ? (
        <ul className="mb-2 divide-y divide-border">
          {c.contacts.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-1">
              <span className="font-medium">{p.name}</span>{p.role && <span className="text-muted">{p.role}</span>}
              <span className="ml-auto flex gap-2">
                {p.phone && <a className="underline" href={`tel:${p.phone}`}>{p.phone}</a>}
                {(p.whatsapp || p.phone) && <a className="underline" href={waLink((p.whatsapp || p.phone)!)} target="_blank" rel="noreferrer" aria-label={t('client360.whatsappTo', { name: p.name })}>WhatsApp</a>}
                {p.email && <a className="underline" href={`mailto:${p.email}`}>{p.email}</a>}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="mb-2 text-muted">{t('client360.noContacts')}</p>}
      {c.can.edit && (
        <form className="grid grid-cols-2 gap-2 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <input aria-label={t('clients.contactPerson')} placeholder={t('clients.contactPerson')} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input aria-label={t('client360.role')} placeholder={t('client360.role')} className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />
          <input aria-label={t('clients.phone')} placeholder="+91" inputMode="tel" maxLength={10} className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '') })} />
          <input aria-label={t('clients.email')} placeholder={t('clients.email')} type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <button className="btn" disabled={!f.name.trim() || add.isPending}><Plus size={14} aria-hidden /> {t('common.add')}</button>
        </form>
      )}
    </section>
  );
}

const REVEAL_MS = 30_000;
type Bank = { bank?: string; accountNo?: string; ifsc?: string; holder?: string | null };

function SensitiveSection({ c }: { c: Detail }) {
  const t = useT();
  const [shown, setShown] = useState<{ aadhaar?: string; bankAccounts?: Bank[] }>({});
  const [status, setStatus] = useState<'' | 'error' | 'cancelled'>('');
  useEffect(() => {
    if (!shown.aadhaar && !shown.bankAccounts) return;
    const id = setTimeout(() => setShown({}), REVEAL_MS);
    return () => clearTimeout(id);
  }, [shown]);
  // Plaintext is held in component state only (never in the query cache) and auto-hidden after 30 s.
  const reveal = async (field: 'aadhaar' | 'bankAccounts') => {
    setStatus('');
    try {
      const r = await withStepUp(() => unwrap(api.POST('/clients/{id}/reveal', { params: { path: { id: c.id } }, body: { field } })));
      setShown((s) => ({ ...s, [field]: r.value }));
    } catch (e) { setStatus(e instanceof StepUpCancelled ? 'cancelled' : 'error'); }
  };
  if (!c.aadhaarLast4 && !c.bankAccounts?.length) return null;
  const fmtAadhaar = (a: string) => a.replace(/(\d{4})(?=\d)/g, '$1 ');
  return (
    <section className="card p-4">
      <h2 className="mb-2 font-semibold">{t('client360.sensitive')}</h2>
      <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
        {c.aadhaarLast4 && <>
          <dt className="text-muted">{t('client360.aadhaar')}</dt>
          <dd className="flex items-center gap-2">
            <span className="font-mono" data-testid="aadhaar-value">{shown.aadhaar ? fmtAadhaar(shown.aadhaar) : `XXXX XXXX ${c.aadhaarLast4}`}</span>
            {c.can.reveal && <RevealButton shown={!!shown.aadhaar} onReveal={() => void reveal('aadhaar')} onHide={() => setShown((s) => ({ ...s, aadhaar: undefined }))} />}
          </dd>
        </>}
        {!!c.bankAccounts?.length && <>
          <dt className="text-muted">{t('client360.bankAccounts')}</dt>
          <dd>
            <ul>
              {(shown.bankAccounts ?? c.bankAccounts).map((b, i) => (
                <li key={i} className="font-mono text-sm">{b.bank} · {'accountNo' in b && b.accountNo ? b.accountNo : `XXXXXX${'last4' in b ? b.last4 : ''}`} · {b.ifsc}{b.holder ? ` · ${b.holder}` : ''}</li>
              ))}
            </ul>
            {c.can.reveal && <RevealButton shown={!!shown.bankAccounts} onReveal={() => void reveal('bankAccounts')} onHide={() => setShown((s) => ({ ...s, bankAccounts: undefined }))} />}
          </dd>
        </>}
      </dl>
      <p aria-live="polite" className="mt-1 text-sm">
        {status === 'error' && <span className="text-overdue">{t('client360.revealFailed')}</span>}
        {(shown.aadhaar || shown.bankAccounts) && <span className="text-muted">{t('client360.autoHide')}</span>}
      </p>
    </section>
  );
}

function RevealButton({ shown, onReveal, onHide }: { shown: boolean; onReveal(): void; onHide(): void }) {
  const t = useT();
  return shown
    ? <button className="btn" onClick={onHide}><EyeOff size={14} aria-hidden /> {t('client360.hide')}</button>
    : <button className="btn" onClick={onReveal}><Eye size={14} aria-hidden /> {t('client360.reveal')}</button>;
}

function AccessTab({ c }: { c: Detail }) {
  const t = useT();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => unwrap(api.GET('/users')), retry: false });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => unwrap(api.GET('/teams')), retry: false });
  const groups = useQuery({ queryKey: ['client-groups'], queryFn: () => unwrap(api.GET('/client-groups')) });
  const [a, setA] = useState<Schemas['ClientAccess']>({
    partnerId: c.partnerId ?? null, managerId: c.managerId ?? null, teamId: c.teamId ?? null,
    staffIds: c.staffIds, groupIds: c.groupIds, sensitive: c.sensitive, allowedUserIds: c.allowedUserIds ?? [],
  });
  const save = useMutation({
    mutationFn: () => unwrap(api.PUT('/clients/{id}/access', { params: { path: { id: c.id } }, body: a })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['client', c.id] }),
  });
  const userList = users.data ?? [];
  const toggle = (k: 'staffIds' | 'groupIds' | 'allowedUserIds', id: string) =>
    setA((p) => ({ ...p, [k]: (p[k] ?? []).includes(id) ? (p[k] ?? []).filter((x) => x !== id) : [...(p[k] ?? []), id] }));
  const userSelect = (k: 'partnerId' | 'managerId', label: string) => (
    <Field label={label}>
      <select className="input" value={a[k] ?? ''} onChange={(e) => setA({ ...a, [k]: e.target.value || null })} disabled={users.isError}>
        <option value="">{t('client360.none')}</option>
        {userList.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        {a[k] && !userList.some((u) => u.id === a[k]) && <option value={a[k]!}>{t('client360.unknownUser')}</option>}
      </select>
    </Field>
  );
  return (
    <form className="card max-w-3xl space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      {(users.isError || teams.isError) && <p role="status" className="text-sm text-muted">{t('client360.pickersUnavailable')}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        {userSelect('partnerId', t('client360.partner'))}
        {userSelect('managerId', t('client360.manager'))}
        <Field label={t('client360.team')}>
          <select className="input" value={a.teamId ?? ''} onChange={(e) => setA({ ...a, teamId: e.target.value || null })} disabled={teams.isError}>
            <option value="">{t('client360.none')}</option>
            {(teams.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
      </div>
      {userList.length > 0 && <CheckList legend={t('client360.staff')} items={userList.map((u) => [u.id, u.name])} selected={a.staffIds ?? []} onToggle={(id) => toggle('staffIds', id)} />}
      <CheckList legend={t('client360.groups')} items={(groups.data ?? []).map((g) => [g.id, g.name])} selected={a.groupIds ?? []} onToggle={(id) => toggle('groupIds', id)} />
      <label className="flex items-center gap-2"><input type="checkbox" checked={!!a.sensitive} onChange={(e) => setA({ ...a, sensitive: e.target.checked })} /> {t('clients.sensitive')}</label>
      {a.sensitive && userList.length > 0 && <CheckList legend={t('client360.allowedUsers')} items={userList.map((u) => [u.id, u.name])} selected={a.allowedUserIds ?? []} onToggle={(id) => toggle('allowedUserIds', id)} />}
      <div className="flex items-center gap-2" aria-live="polite">
        <button className="btn btn-primary" disabled={save.isPending}>{t('common.save')}</button>
        {save.isSuccess && <span role="status" className="text-done">{t('notif.saved')}</span>}
        {save.isError && <span role="alert" className="text-overdue">{(save.error as Error).message}</span>}
      </div>
    </form>
  );
}

function CheckList({ legend, items, selected, onToggle }: { legend: string; items: Array<[string, string]>; selected: string[]; onToggle(id: string): void }) {
  return (
    <fieldset>
      <legend className="label">{legend}</legend>
      <div className="flex max-h-40 flex-wrap gap-x-4 gap-y-1 overflow-auto">
        {items.map(([id, name]) => <label key={id} className="flex items-center gap-1.5"><input type="checkbox" checked={selected.includes(id)} onChange={() => onToggle(id)} /> {name}</label>)}
      </div>
    </fieldset>
  );
}

function MergeTab({ c }: { c: Detail }) {
  const t = useT();
  const go = useRoute((s) => s.go);
  const qc = useQueryClient();
  const [into, setInto] = useState<PickedClient | null>(null);
  const merge = useMutation({
    mutationFn: (intoId: string) => unwrap(api.POST('/clients/{id}/merge', { params: { path: { id: c.id } }, body: { intoId } })),
    onSuccess: (_d, intoId) => { void qc.invalidateQueries({ queryKey: ['clients'] }); go(`clients/${intoId}`); },
  });
  return (
    <div className="card max-w-xl space-y-3 p-4">
      <p className="text-muted">{t('client360.mergeHelp', { name: c.name })}</p>
      <ClientPicker label={t('client360.mergeInto')} value={into} onChange={setInto} excludeId={c.id} />
      <button className="btn btn-danger" disabled={!into || merge.isPending}
        onClick={() => into && confirm(t('client360.mergeConfirm', { from: c.name, into: into.name })) && merge.mutate(into.id)}>{t('client360.merge')}</button>
      {merge.isError && <p role="alert" className="text-overdue">{(merge.error as Error).message}</p>}
    </div>
  );
}
