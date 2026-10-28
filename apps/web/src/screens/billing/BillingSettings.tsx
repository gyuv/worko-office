import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { GST_STATES } from '@worko/domain';
import { Download, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { ServicesSettings } from '../settings/ServicesSettings';
import { HrSettings } from '../hr/HrSettings';
import { CommSettings } from '../comm/CommSettings';
import { useServiceTypes } from '../tasks/shared';
import { parseRupees, TALLY_ACCOUNT_KEYS } from './logic';
import { download, MockBadge, Money, RupeeInput, useBillingSettings, useEntities } from './shared';

const onErr = (e: unknown) => toast({ text: (e as Error).message, tone: 'error' });

/** Settings: Services (catalogue) | Billing. */
export function SettingsRoute() {
  const t = useT();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  const can = useCan();
  const view = params[0] === 'billing' && can('billing', 'view') ? 'billing' : params[0] === 'hr' && can('hr', 'view') ? 'hr' : params[0] === 'comm' && can('communication', 'view') ? 'comm' : 'services';
  const tabs: Array<['services' | 'billing' | 'hr' | 'comm', string]> = [['services', t('svc.title')], ...(can('billing', 'view') ? [['billing', t('nav.billing')] as ['billing', string]] : []),
    ...(can('hr', 'view') ? [['hr', t('p6.hs.tab')] as ['hr', string]] : []), ...(can('communication', 'view') ? [['comm', t('p7.cs.tab')] as ['comm', string]] : [])];
  return (
    <div className="space-y-3">
      {tabs.length > 1 && <Tabs label={t('nav.settings')} tabs={tabs} value={view} onChange={(v) => go(v === 'services' ? 'settings' : `settings/${v}`)} />}
      {view === 'billing' ? <BillingSettings /> : view === 'hr' ? <HrSettings /> : view === 'comm' ? <CommSettings /> : <ServicesSettings />}
    </div>
  );
}

type Sub = 'entities' | 'rates' | 'followups' | 'tally' | 'registers';

function BillingSettings() {
  const t = useT();
  const [sub, setSub] = useState<Sub>('entities');
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('bs.title')}</h1>
      <Tabs<Sub> label={t('bs.title')} value={sub} onChange={setSub} tabs={[['entities', t('bs.entities')], ['rates', t('bs.rates')], ['followups', t('bs.followups')], ['tally', t('bs.tally')], ['registers', t('bs.registers')]]} />
      {sub === 'entities' && <Entities />}
      {sub === 'rates' && <Rates />}
      {sub === 'followups' && <FollowupSettings />}
      {sub === 'tally' && <Tally />}
      {sub === 'registers' && <Registers />}
    </div>
  );
}

type Entity = Schemas['BillingEntity'];

function Entities() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const list = useEntities();
  const [editing, setEditing] = useState<Entity | 'new' | null>(null);
  return (
    <div className="space-y-2">
      {can('settings', 'edit') && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={14} aria-hidden /> {t('bs.newEntity')}</button>}
      <div className="card overflow-auto"><table className="table w-full">
        <thead><tr><th>{t('bs.name')}</th><th>{t('bs.gstin')}</th><th>{t('bs.state')}</th><th>{t('bs.prefix')}</th><th>{t('bs.active')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
        <tbody>{(list.data ?? []).map((e) => (
          <tr key={e.id} className={e.active ? '' : 'text-muted'}><td>{e.name}</td><td className="font-mono text-xs">{e.gstin ?? t('bs.unregistered')}</td><td>{e.stateCode}</td><td className="font-mono">{e.invoicePrefix}</td>
            <td>{e.active ? t('svc.yes') : t('svc.no')}</td>
            <td className="text-right">{can('settings', 'edit') && <button className="btn" aria-label={t('bs.editEntity', { name: e.name })} onClick={() => setEditing(e)}><Pencil size={14} /></button>}</td></tr>
        ))}</tbody>
      </table></div>
      {editing && <EntityDialog e={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: ['billing', 'entities'] }); }} />}
    </div>
  );
}

function EntityDialog({ e, onClose, onSaved }: { e: Entity | null; onClose(): void; onSaved(): void }) {
  const t = useT();
  const bank = (e?.bank ?? {}) as Record<string, string>;
  const [f, setF] = useState({ name: e?.name ?? '', frn: e?.frn ?? '', pan: e?.pan ?? '', gstin: e?.gstin ?? '', stateCode: e?.stateCode ?? '', address: e?.address ?? '', email: e?.email ?? '', phone: e?.phone ?? '',
    invoicePrefix: e?.invoicePrefix ?? '', active: e?.active ?? true, bankName: bank.name ?? '', accountNo: bank.accountNo ?? '', ifsc: bank.ifsc ?? '', branch: bank.branch ?? '', upiId: bank.upiId ?? '' });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, frn: f.frn || null, pan: f.pan || null, gstin: f.gstin || null, stateCode: f.stateCode, address: f.address || null, email: f.email || null, phone: f.phone || null,
        invoicePrefix: f.invoicePrefix, active: f.active, bank: { name: f.bankName, accountNo: f.accountNo, ifsc: f.ifsc, branch: f.branch, upiId: f.upiId } };
      return e ? unwrap(api.PATCH('/billing/entities/{id}', { params: { path: { id: e.id } }, body })) : unwrap(api.POST('/billing/entities', { body }));
    },
    onSuccess: onSaved,
    onError: (err) => toast({ text: (err as { code?: string }).code === 'entity_locked' ? t('bs.lockedError') : (err as Error).message, tone: 'error' }),
  });
  const txt = (k: 'name' | 'frn' | 'pan' | 'gstin' | 'address' | 'email' | 'phone' | 'bankName' | 'accountNo' | 'ifsc' | 'branch' | 'upiId', label: string, extra: object = {}) =>
    <Field label={label}><input className="input" value={f[k]} onChange={(ev) => set(k, ev.target.value)} {...extra} /></Field>;
  return (
    <Dialog title={e ? t('bs.editEntity', { name: e.name }) : t('bs.newEntity')} onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(ev) => { ev.preventDefault(); save.mutate(); }}>
        {e && <p className="card p-2 text-sm text-due-soon">{t('bs.lockNotice')}</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          {txt('name', t('bs.name'), { required: true })}{txt('frn', t('bs.frn'))}{txt('pan', t('bs.pan'))}
          {txt('gstin', t('bs.gstin'))}
          <Field label={t('bs.state')}><select className="input" required value={f.stateCode} onChange={(ev) => set('stateCode', ev.target.value)}>
            <option value="" />{Object.entries(GST_STATES).map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}</select></Field>
          <Field label={t('bs.prefix')} hint={t('bs.prefixHint')}><input className="input font-mono" required pattern="[A-Z0-9]{1,4}" value={f.invoicePrefix} onChange={(ev) => set('invoicePrefix', ev.target.value.toUpperCase())} /></Field>
          {txt('address', t('bs.address'))}{txt('email', t('bs.email'))}{txt('phone', t('bs.phone'))}
          {txt('bankName', t('bs.bank'))}{txt('accountNo', t('bs.accountNo'))}{txt('ifsc', t('bs.ifsc'))}{txt('branch', t('bs.branch'))}{txt('upiId', t('bs.upi'))}
        </div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.active} onChange={(ev) => set('active', ev.target.checked)} /> {t('bs.active')}</label>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={save.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

function Rates() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const services = useServiceTypes(true).data ?? [];
  const groups = useQuery({ queryKey: ['client-groups'], queryFn: () => unwrap(api.GET('/client-groups')) }).data ?? [];
  const [serviceTypeId, setServiceTypeId] = useState('');
  const rates = useQuery({ queryKey: ['billing', 'rates', serviceTypeId], queryFn: () => unwrap(api.GET('/billing/rates', { params: { query: serviceTypeId ? { serviceTypeId } : {} } })) });
  const [adding, setAdding] = useState(false);
  const del = useMutation({ mutationFn: (id: string) => unwrap(api.PATCH('/billing/rates/{id}', { params: { path: { id } }, body: { deleted: true } })), onSuccess: () => void qc.invalidateQueries({ queryKey: ['billing', 'rates'] }), onError: onErr });
  const endDate = useMutation({ mutationFn: (id: string) => unwrap(api.PATCH('/billing/rates/{id}', { params: { path: { id } }, body: { effectiveTo: todayIst() } })), onSuccess: () => void qc.invalidateQueries({ queryKey: ['billing', 'rates'] }), onError: onErr });
  const svcName = (id: string) => services.find((s) => s.id === id)?.name ?? id;
  const groupName = (id: string | null | undefined) => groups.find((g) => g.id === id)?.name;
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">{t('bs.ratesHint')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('bill.ret.service')}><select className="input" value={serviceTypeId} onChange={(e) => setServiceTypeId(e.target.value)}>
          <option value="">{t('tasks.f.any')}</option>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        {can('settings', 'edit') && <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={14} aria-hidden /> {t('bs.newRate')}</button>}
      </div>
      <div className="card overflow-auto"><table className="table w-full">
        <thead><tr><th>{t('bill.ret.service')}</th><th>{t('bs.appliesTo')}</th><th className="text-right">{t('bill.ret.rate')}</th><th>{t('bs.effectiveFrom')}</th><th>{t('bs.effectiveTo')}</th><th>{t('bill.notes')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
        <tbody>{(rates.data ?? []).map((r) => (
          <tr key={r.id}><td>{svcName(r.serviceTypeId)}</td>
            <td>{r.clientId ? t('bs.clientOverride') : r.groupId ? `${t('bs.groupOverride')}: ${groupName(r.groupId) ?? ''}` : t('bs.firmDefault')}</td>
            <td className="text-right"><Money p={r.amountPaise} /></td><td>{r.effectiveFrom}</td><td>{r.effectiveTo ?? '—'}</td><td>{r.notes}</td>
            <td className="whitespace-nowrap text-right">{can('settings', 'edit') && <>
              {!r.effectiveTo && <button className="btn" onClick={() => endDate.mutate(r.id)}>{t('bs.endToday')}</button>}
              <button className="btn ml-1" aria-label={t('bs.deleteRate')} onClick={() => { if (confirm(t('bs.deleteRate'))) del.mutate(r.id); }}><Trash2 size={14} /></button></>}</td></tr>
        ))}</tbody>
      </table></div>
      {adding && <RateDialog services={services} groups={groups} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void qc.invalidateQueries({ queryKey: ['billing', 'rates'] }); }} />}
    </div>
  );
}

function RateDialog({ services, groups, onClose, onSaved }: { services: Array<{ id: string; name: string }>; groups: Array<{ id: string; name: string }>; onClose(): void; onSaved(): void }) {
  const t = useT();
  const [serviceTypeId, setServiceTypeId] = useState(services[0]?.id ?? '');
  const [scope, setScope] = useState<'firm' | 'group' | 'client'>('firm');
  const [groupId, setGroupId] = useState('');
  const [client, setClient] = useState<PickedClient | null>(null);
  const [amount, setAmount] = useState('');
  const [effectiveFrom, setFrom] = useState(todayIst());
  const [effectiveTo, setTo] = useState('');
  const [notes, setNotes] = useState('');
  const save = useMutation({
    mutationFn: () => unwrap(api.POST('/billing/rates', { body: { serviceTypeId, amountPaise: parseRupees(amount)!, effectiveFrom, effectiveTo: effectiveTo || null, notes: notes || null,
      clientId: scope === 'client' ? client?.id ?? null : null, groupId: scope === 'group' ? groupId || null : null } })),
    onSuccess: onSaved, onError: onErr,
  });
  return (
    <Dialog title={t('bs.newRate')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (parseRupees(amount) !== null) save.mutate(); }}>
        <Field label={t('bill.ret.service')}><select className="input" required value={serviceTypeId} onChange={(e) => setServiceTypeId(e.target.value)}>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label={t('bs.appliesTo')}><select className="input" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="firm">{t('bs.firmDefault')}</option><option value="group">{t('bs.groupOverride')}</option><option value="client">{t('bs.clientOverride')}</option></select></Field>
        {scope === 'group' && <Field label={t('bs.group')}><select className="input" required value={groupId} onChange={(e) => setGroupId(e.target.value)}><option value="" />{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>}
        {scope === 'client' && <ClientPicker label={t('bill.client')} value={client} onChange={setClient} />}
        <Field label={t('bill.ret.rate')}><RupeeInput label={t('bill.ret.rate')} required value={amount} onChange={setAmount} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('bs.effectiveFrom')}><input type="date" className="input" required value={effectiveFrom} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label={t('bs.effectiveTo')}><input type="date" className="input" value={effectiveTo} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Field label={t('bill.notes')}><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={save.isPending || (scope === 'client' && !client)}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

type Step = { step: number; daysAfterDue: number; channels: Array<'email' | 'whatsapp'>; escalate?: boolean };

function FollowupSettings() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const s = useBillingSettings();
  const entities = useEntities().data ?? [];
  if (!s.data) return <p className="text-muted">{t('common.loading')}</p>;
  return <FollowupForm key={JSON.stringify(s.data)} initial={s.data} entities={entities} readOnly={!can('settings', 'edit')} onSaved={() => void qc.invalidateQueries({ queryKey: ['billing', 'settings'] })} />;
}

function FollowupForm({ initial, entities, readOnly, onSaved }: { initial: Schemas['BillingSettings']; entities: Entity[]; readOnly: boolean; onSaved(): void }) {
  const t = useT();
  const [f, setF] = useState({ defaultEntityId: initial.defaultEntityId ?? '', dueDays: String(initial.dueDays ?? ''), terms: initial.terms ?? '' });
  const [ladder, setLadder] = useState<Step[]>((initial.ladder ?? []) as Step[]);
  const [asOf, setAsOf] = useState(todayIst());
  const save = useMutation({
    mutationFn: () => unwrap(api.PUT('/billing/settings', { body: { ...initial, defaultEntityId: f.defaultEntityId || null, dueDays: Number(f.dueDays), terms: f.terms || null,
      ladder: ladder.map((l, i) => ({ ...l, step: i + 1 })) } })),
    onSuccess: () => { toast({ text: t('bs.saved'), tone: 'ok' }); onSaved(); }, onError: onErr,
  });
  const run = useMutation({ mutationFn: () => unwrap(api.POST('/billing/follow-ups/run', { body: { asOf } })), onError: onErr });
  const setStep = (i: number, p: Partial<Step>) => setLadder(ladder.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const toggle = (i: number, ch: 'email' | 'whatsapp') => { const c = ladder[i]!.channels; setStep(i, { channels: c.includes(ch) ? c.filter((x) => x !== ch) : [...c, ch] }); };
  return (
    <form className="card space-y-3 p-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <fieldset disabled={readOnly} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('bs.defaultEntity')}><select className="input" value={f.defaultEntityId} onChange={(e) => setF({ ...f, defaultEntityId: e.target.value })}><option value="" />{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          <Field label={t('bs.dueDays')}><input type="number" min={0} className="input" value={f.dueDays} onChange={(e) => setF({ ...f, dueDays: e.target.value })} /></Field>
          <Field label={t('bs.defaults')}><span className="input block text-muted">{t('bs.defaultsValue', { sac: initial.defaultSac ?? '—', rate: String(initial.defaultGstRate ?? '—') })}</span></Field>
        </div>
        <Field label={t('bs.terms')}><textarea className="input" value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} /></Field>
        <h3 className="font-semibold">{t('bs.ladder')}</h3>
        <table className="table w-full">
          <thead><tr><th>#</th><th>{t('bs.daysAfterDue')}</th><th>{t('bs.channels')}</th><th>{t('bs.escalate')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
          <tbody>{ladder.map((l, i) => (
            <tr key={i}><td>{i + 1}</td>
              <td><input type="number" className="input w-24" aria-label={t('bs.daysAfterDueN', { n: i + 1 })} value={l.daysAfterDue} onChange={(e) => setStep(i, { daysAfterDue: Number(e.target.value) })} /></td>
              <td className="space-x-3">
                <label><input type="checkbox" checked={l.channels.includes('email')} onChange={() => toggle(i, 'email')} /> {t('bill.sendEmail')}</label>
                <label><input type="checkbox" checked={l.channels.includes('whatsapp')} onChange={() => toggle(i, 'whatsapp')} /> {t('bill.sendWhatsApp')}</label> <MockBadge />
              </td>
              <td><input type="checkbox" aria-label={t('bs.escalateN', { n: i + 1 })} checked={!!l.escalate} onChange={(e) => setStep(i, { escalate: e.target.checked })} /></td>
              <td><button type="button" className="btn" aria-label={t('bill.line.remove', { n: i + 1 })} onClick={() => setLadder(ladder.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td></tr>
          ))}</tbody>
        </table>
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={() => setLadder([...ladder, { step: ladder.length + 1, daysAfterDue: (ladder.at(-1)?.daysAfterDue ?? 0) + 7, channels: ['email'] }])}><Plus size={14} aria-hidden /> {t('bs.addStep')}</button>
          <button className="btn btn-primary" disabled={save.isPending}>{t('common.save')}</button>
        </div>
      </fieldset>
      {!readOnly && <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
        <Field label={t('bs.runAsOf')}><input type="date" className="input" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <button type="button" className="btn" disabled={run.isPending} onClick={() => run.mutate()}>{t('bs.runNow')}</button>
        {run.data && <span role="status" className="text-sm">{t('bs.runResult', { sent: run.data.sent ?? 0, skipped: run.data.skipped ?? 0, escalated: run.data.escalated ?? 0 })}</span>}
      </div>}
    </form>
  );
}

type TallyResult = Schemas['TallyResult'];

function Tally() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const entities = useEntities().data ?? [];
  const ledgers = useQuery({ queryKey: ['billing', 'tally'], queryFn: () => unwrap(api.GET('/billing/tally/ledgers')) });
  const [entityId, setEntityId] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [extraKey, setExtraKey] = useState('');
  const [range, setRange] = useState({ from: `${todayIst().slice(0, 8)}01`, to: todayIst() });
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<{ kind: 'dry' | 'export'; r: TallyResult } | null>(null);
  const [log, setLog] = useState<Array<{ at: string; batchId: string; count: number }>>([]);
  const current = (ledgers.data ?? []).filter((l) => (l.entityId ?? '') === entityId);
  const keys = [...new Set([...TALLY_ACCOUNT_KEYS, ...current.map((l) => l.accountKey), ...Object.keys(edits)])];
  const valueOf = (k: string) => edits[k] ?? current.find((l) => l.accountKey === k)?.ledgerName ?? '';
  const save = useMutation({
    mutationFn: () => unwrap(api.PUT('/billing/tally/ledgers', { body: Object.entries(edits).map(([accountKey, v]) => ({ entityId: entityId || null, accountKey, ledgerName: v.trim() || null })) })),
    onSuccess: () => { setEdits({}); toast({ text: t('bs.saved'), tone: 'ok' }); void qc.invalidateQueries({ queryKey: ['billing', 'tally'] }); }, onError: onErr,
  });
  const exportEntity = entityId || entities[0]?.id || '';
  const dry = useMutation({ mutationFn: () => unwrap(api.POST('/billing/tally/dry-run', { body: { entityId: exportEntity, ...range, force } })), onSuccess: (r) => setResult({ kind: 'dry', r }), onError: onErr });
  const exp = useMutation({
    mutationFn: () => unwrap(api.POST('/billing/tally/export', { body: { entityId: exportEntity, ...range, force } })),
    onSuccess: (r) => {
      setResult({ kind: 'export', r }); setLog((l) => [{ at: new Date().toISOString(), batchId: r.batchId ?? '', count: r.count ?? 0 }, ...l]);
      const blob = new Blob([r.xml ?? ''], { type: 'application/xml' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `tally-${range.from}-${range.to}.xml`; a.click();
    },
    onError: (e) => { const issues = (e as { issues?: TallyResult['errors'] }).issues; if (issues) setResult({ kind: 'dry', r: { xml: '', errors: issues } as TallyResult }); onErr(e); },
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{t('bs.tallyHint')} <MockBadge /></p>
      <Field label={t('bill.entity')}><select className="input max-w-xs" value={entityId} onChange={(e) => { setEntityId(e.target.value); setEdits({}); }}>
        <option value="">{t('bs.allEntities')}</option>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
      <form className="card space-y-2 p-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <table className="table w-full"><thead><tr><th>{t('bs.accountKey')}</th><th>{t('bs.ledgerName')}</th></tr></thead>
          <tbody>{keys.map((k) => <tr key={k}><td className="font-mono text-xs">{k}</td><td>
            <input className="input" aria-label={t('bs.ledgerFor', { key: k })} disabled={!can('settings', 'edit')} value={valueOf(k)} onChange={(e) => setEdits({ ...edits, [k]: e.target.value })} /></td></tr>)}</tbody></table>
        {can('settings', 'edit') && <div className="flex flex-wrap items-end gap-2">
          <Field label={t('bs.extraKey')} hint={t('bs.extraKeyHint')}><input className="input font-mono" value={extraKey} onChange={(e) => setExtraKey(e.target.value)} /></Field>
          <button type="button" className="btn" disabled={!extraKey.trim()} onClick={() => { setEdits({ ...edits, [extraKey.trim()]: '' }); setExtraKey(''); }}>{t('bs.addKey')}</button>
          <button className="btn btn-primary ml-auto" disabled={!Object.keys(edits).length || save.isPending}>{t('common.save')}</button>
        </div>}
      </form>
      {can('billing', 'export') && <div className="card space-y-2 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('bill.f.from')}><input type="date" className="input" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label={t('bill.f.to')}><input type="date" className="input" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          <label className="flex items-center gap-1"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {t('bs.force')}</label>
          <button className="btn" disabled={!exportEntity || dry.isPending} onClick={() => dry.mutate()}>{t('bs.dryRun')}</button>
          <button className="btn btn-primary" disabled={!exportEntity || exp.isPending || (result?.kind === 'dry' && !!result.r.errors?.length)} onClick={() => exp.mutate()}>{t('bs.export')}</button>
        </div>
        {result && <div className="space-y-2">
          <p role="status" className="text-sm">{t('bs.tallyCounts', { count: result.r.count ?? 0, invoices: result.r.invoices ?? 0, receipts: result.r.receipts ?? 0 })}</p>
          {!!result.r.errors?.length && <ul role="alert" className="text-sm text-overdue">{result.r.errors.map((e, i) => <li key={i}>{e.voucherNumber} · {e.code} · <span className="font-mono">{e.account}</span></li>)}</ul>}
          {result.r.xml && <pre className="max-h-80 overflow-auto rounded bg-surface-alt p-2 text-xs" aria-label={t('bs.xml')}>{result.r.xml}</pre>}
        </div>}
        {!!log.length && <div><h3 className="font-semibold">{t('bs.exportLog')}</h3><ul className="text-sm">{log.map((l) => <li key={l.batchId}>{l.at.slice(0, 19).replace('T', ' ')} · {l.batchId} · {l.count}</li>)}</ul></div>}
      </div>}
    </div>
  );
}

function Registers() {
  const t = useT();
  const can = useCan();
  const [from, setFrom] = useState(`${todayIst().slice(0, 8)}01`);
  const [to, setTo] = useState(todayIst());
  const get = async (kind: 'invoices' | 'receipts', format: 'csv' | 'xlsx') => {
    try { await download(`/billing/${kind}/export?format=${format}&from=${from}&to=${to}`, `${kind}.${format}`); } catch { toast({ text: t('bill.exportFailed'), tone: 'error' }); }
  };
  return (
    <div className="card space-y-3 p-3">
      <div className="flex gap-2">
        <Field label={t('bill.f.from')}><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('bill.f.to')}><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {can('billing', 'export') && <div className="flex items-center gap-2"><span className="w-40">{t('bs.invoiceRegister')}</span>
        <button className="btn" onClick={() => void get('invoices', 'csv')}><Download size={14} aria-hidden /> CSV</button><button className="btn" onClick={() => void get('invoices', 'xlsx')}><Download size={14} aria-hidden /> XLSX</button></div>}
      {can('receipts', 'export') && <div className="flex items-center gap-2"><span className="w-40">{t('bs.receiptRegister')}</span>
        <button className="btn" onClick={() => void get('receipts', 'csv')}><Download size={14} aria-hidden /> CSV</button><button className="btn" onClick={() => void get('receipts', 'xlsx')}><Download size={14} aria-hidden /> XLSX</button></div>}
    </div>
  );
}
