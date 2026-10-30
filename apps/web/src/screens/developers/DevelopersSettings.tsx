import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { formatDateTime } from '@worko/i18n';
import { Copy, KeyRound, Plus, RefreshCw, Send, Trash2, Webhook } from 'lucide-react';
import { useState } from 'react';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { absoluteUrl } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api } from '../../lib/session';
import { as, asFull, body } from '../leads/api';
import { deliveryTone, expiryIso, groupScopes, parseCidrs, PUBLIC_API_PRESET, type DeliveryStatus } from './logic';

type ApiKey = Schemas['ApiKey'];
type Hook = Schemas['WebhookSubscription'];
type Delivery = Schemas['WebhookDelivery'];
type Catalogue = { scopes: string[]; events: string[]; docsUrl: string };

const useCatalogue = () => useQuery({ queryKey: ['developers', 'catalogue'], queryFn: () => as<Catalogue>(api.GET('/developers/catalogue')) });
const when = (s: string | null | undefined) => (s ? formatDateTime(s) : '—');

/** Settings → Developers (M18): API keys and webhooks. Desktop uses the same screen; not on mobile (D190). */
export function DevelopersSettings() {
  const t = useT();
  const [tab, setTab] = useState<'keys' | 'hooks'>('keys');
  const cat = useCatalogue();
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t('p12b.title')}</h1>
        {cat.data && <a className="text-sm underline" href={absoluteUrl(cat.data.docsUrl)} target="_blank" rel="noreferrer">{t('p12b.docs')}</a>}
      </header>
      <p className="text-sm text-muted">{t('p12b.intro')}</p>
      <Tabs<'keys' | 'hooks'> label={t('p12b.title')} value={tab} onChange={setTab} tabs={[['keys', t('p12b.keys')], ['hooks', t('p12b.hooks')]]} />
      {tab === 'keys' ? <ApiKeys cat={cat.data} /> : <Webhooks cat={cat.data} />}
    </div>
  );
}

function ShownOnce({ secret, onClose }: { secret: string; onClose(): void }) {
  const t = useT();
  return (
    <Dialog title={t('p12b.once.title')} onClose={onClose}>
      <p role="alert" className="text-sm text-due-soon">{t('p12b.once.warn')}</p>
      <div className="mt-2 flex items-center gap-2">
        <code data-testid="secret" className="flex-1 break-all rounded bg-surface-alt p-2 text-xs">{secret}</code>
        <button className="btn" aria-label={t('p12b.copy')} onClick={() => { void navigator.clipboard?.writeText(secret); toast({ text: t('p12b.copied'), tone: 'ok' }, 2000); }}><Copy size={14} /></button>
      </div>
      <div className="mt-3 flex justify-end"><button className="btn btn-primary" onClick={onClose}>{t('p12b.once.done')}</button></div>
    </Dialog>
  );
}

function ApiKeys({ cat }: { cat?: Catalogue }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['developers', 'keys'], queryFn: () => as<{ items: ApiKey[] }>(api.GET('/developers/api-keys')).then((r) => r.items) });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['developers', 'keys'] });
  const rotate = useMutation({ mutationFn: (id: string) => as<{ secret: string }>(api.POST('/developers/api-keys/{id}/rotate', { params: { path: { id } } })), onSuccess: (r) => { setSecret(r.secret); refresh(); } });
  const revoke = useMutation({ mutationFn: (id: string) => as(api.DELETE('/developers/api-keys/{id}', { params: { path: { id } } })), onSuccess: refresh });
  const edit = can('settings', 'edit');
  return (
    <section className="space-y-2" aria-label={t('p12b.keys')}>
      {edit && <div className="flex justify-end"><button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={14} /> {t('p12b.k.new')}</button></div>}
      {q.data?.length === 0 && <p className="text-muted">{t('p12b.k.empty')}</p>}
      <ul className="space-y-2">
        {q.data?.map((k) => (
          <li key={k.id} className="card space-y-1 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <KeyRound size={14} /><span className="font-medium">{k.name}</span>
              <code className="rounded bg-surface-alt px-1 text-xs">wk_{k.prefix}_…</code>
              <span className={`text-xs ${k.status === 'active' ? 'text-done' : 'text-overdue'}`}>{t(`p12b.k.status.${k.status ?? 'active'}` as 'p12b.k.status.active')}</span>
              {edit && k.status !== 'revoked' && <span className="ml-auto flex gap-1">
                <button className="btn" onClick={() => rotate.mutate(k.id!)}><RefreshCw size={14} /> {t('p12b.k.rotate')}</button>
                <button className="btn" onClick={() => { if (confirm(t('p12b.k.revokeConfirm', { name: k.name ?? '' }))) revoke.mutate(k.id!); }}><Trash2 size={14} /> {t('p12b.k.revoke')}</button>
              </span>}
            </div>
            <div className="text-xs text-muted">{t('p12b.k.scopes')}: {k.scopes?.join(', ')}</div>
            <div className="text-xs text-muted">
              {t('p12b.k.meta', { by: k.createdByName ?? '—', created: when(k.createdAt), used: when(k.lastUsedAt), expires: when(k.expiresAt) })}
              {k.ipAllowlist?.length ? ` · ${t('p12b.k.ips')}: ${k.ipAllowlist.join(', ')}` : ''}{k.clientGroupIds?.length ? ` · ${t('p12b.k.groupsOnly', { n: k.clientGroupIds.length })}` : ''}
            </div>
          </li>
        ))}
      </ul>
      {creating && cat && <NewKey scopes={cat.scopes} onClose={() => setCreating(false)} onCreated={(s) => { setCreating(false); setSecret(s); refresh(); }} />}
      {secret && <ShownOnce secret={secret} onClose={() => setSecret(null)} />}
    </section>
  );
}

function NewKey({ scopes, onClose, onCreated }: { scopes: string[]; onClose(): void; onCreated(secret: string): void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>(PUBLIC_API_PRESET.filter((s) => scopes.includes(s)));
  const [ips, setIps] = useState('');
  const [expires, setExpires] = useState('');
  const [rate, setRate] = useState(120);
  const [error, setError] = useState<string | null>(null);
  const cidr = parseCidrs(ips);
  const save = useMutation({
    mutationFn: () => asFull<{ secret: string }>(api.POST('/developers/api-keys', { body: body({ name, scopes: picked, ipAllowlist: cidr.cidrs, expiresAt: expiryIso(expires), ratePerMin: rate }) })),
    onSuccess: (r) => onCreated(r.secret), onError: (e) => setError((e as Error).message),
  });
  const toggle = (s: string) => setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]));
  return (
    <Dialog title={t('p12b.k.new')} onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label={t('p12b.k.name')}><input className="input" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <fieldset className="space-y-1">
          <legend className="label">{t('p12b.k.scopes')}</legend>
          <p className="text-xs text-muted">{t('p12b.k.scopesHint')}</p>
          <div className="grid max-h-64 gap-1 overflow-auto sm:grid-cols-2">
            {groupScopes(scopes).map((g) => (
              <div key={g.module} className="text-sm"><span className="font-medium">{g.module}</span>{' '}
                {g.actions.map((a) => { const s = `${g.module}:${a}`; return <label key={s} className="mr-2 inline-flex items-center gap-1"><input type="checkbox" checked={picked.includes(s)} onChange={() => toggle(s)} />{a}</label>; })}
              </div>
            ))}
          </div>
        </fieldset>
        <Field label={t('p12b.k.ips')} hint={t('p12b.k.ipsHint')} error={cidr.invalid.length ? t('p12b.k.badCidr', { list: cidr.invalid.join(', ') }) : null}>
          <textarea className="input" rows={2} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.0/24" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('p12b.k.expires')} hint={t('p12b.k.expiresHint')}><input className="input" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
          <Field label={t('p12b.k.rate')}><input className="input" type="number" min={1} max={2000} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></Field>
        </div>
        {error && <p role="alert" className="text-sm text-overdue">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!name || picked.length === 0 || cidr.invalid.length > 0 || save.isPending}>{t('p12b.k.create')}</button></div>
      </form>
    </Dialog>
  );
}

function Webhooks({ cat }: { cat?: Catalogue }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['developers', 'hooks'], queryFn: () => as<{ items: Hook[] }>(api.GET('/developers/webhooks')).then((r) => r.items) });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['developers'] });
  const ping = useMutation({ mutationFn: (id: string) => as(api.POST('/developers/webhooks/{id}/ping', { params: { path: { id } } })), onSuccess: () => { toast({ text: t('p12b.h.pinged'), tone: 'ok' }, 3000); refresh(); } });
  const toggle = useMutation({ mutationFn: (h: Hook) => as(api.PATCH('/developers/webhooks/{id}', { params: { path: { id: h.id! } }, body: { active: h.status !== 'active' } })), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => as(api.DELETE('/developers/webhooks/{id}', { params: { path: { id } } })), onSuccess: refresh });
  const rotate = useMutation({ mutationFn: (id: string) => as<{ secret: string }>(api.POST('/developers/webhooks/{id}/rotate-secret', { params: { path: { id } } })), onSuccess: (r) => setSecret(r.secret) });
  const edit = can('settings', 'edit');
  return (
    <section className="space-y-2" aria-label={t('p12b.hooks')}>
      <p className="text-xs text-muted">{t('p12b.h.intro')}</p>
      {edit && <div className="flex justify-end"><button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={14} /> {t('p12b.h.new')}</button></div>}
      {q.data?.length === 0 && <p className="text-muted">{t('p12b.h.empty')}</p>}
      <ul className="space-y-2">
        {q.data?.map((h) => (
          <li key={h.id} className="card space-y-1 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Webhook size={14} /><span className="font-medium">{h.name}</span><code className="text-xs">{h.url}</code>
              <span className={`text-xs ${h.status === 'active' ? 'text-done' : 'text-overdue'}`}>{h.status === 'active' ? t('p12b.h.active') : t('p12b.h.disabled', { reason: h.disabledReason ?? '' })}</span>
              {edit && <span className="ml-auto flex flex-wrap gap-1">
                <button className="btn" onClick={() => ping.mutate(h.id!)}><Send size={14} /> {t('p12b.h.ping')}</button>
                <button className="btn" onClick={() => toggle.mutate(h)}>{h.status === 'active' ? t('p12b.h.disable') : t('p12b.h.enable')}</button>
                <button className="btn" onClick={() => rotate.mutate(h.id!)}><RefreshCw size={14} /> {t('p12b.h.rotate')}</button>
                <button className="btn" aria-label={t('p12b.h.delete')} onClick={() => { if (confirm(t('p12b.h.deleteConfirm', { name: h.name ?? '' }))) remove.mutate(h.id!); }}><Trash2 size={14} /></button>
              </span>}
            </div>
            <div className="text-xs text-muted">{h.events?.join(', ')} · {t('p12b.h.failures', { n: h.consecutiveFailures ?? 0 })}</div>
            <button className="text-xs underline" onClick={() => setOpen(open === h.id ? null : h.id!)}>{open === h.id ? t('p12b.h.hideLog') : t('p12b.h.showLog')}</button>
            {open === h.id && <DeliveryLog id={h.id!} canEdit={edit} />}
          </li>
        ))}
      </ul>
      {creating && cat && <NewHook events={cat.events} onClose={() => setCreating(false)} onCreated={(s) => { setCreating(false); setSecret(s); refresh(); }} />}
      {secret && <ShownOnce secret={secret} onClose={() => setSecret(null)} />}
    </section>
  );
}

function DeliveryLog({ id, canEdit }: { id: string; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['developers', 'deliveries', id], queryFn: () => as<{ items: Delivery[] }>(api.GET('/developers/webhooks/{id}/deliveries', { params: { path: { id } } })).then((r) => r.items) });
  const redeliver = useMutation({ mutationFn: (d: string) => as(api.POST('/developers/webhook-deliveries/{id}/redeliver', { params: { path: { id: d } } })), onSuccess: () => void qc.invalidateQueries({ queryKey: ['developers', 'deliveries', id] }) });
  if (!q.data?.length) return <p className="text-xs text-muted">{t('p12b.h.noDeliveries')}</p>;
  return (
    <table className="w-full text-xs" aria-label={t('p12b.h.log')}>
      <thead><tr className="text-left text-muted"><th>{t('p12b.h.at')}</th><th>{t('p12b.h.event')}</th><th>{t('p12b.h.status')}</th><th>{t('p12b.h.code')}</th><th>{t('p12b.h.attempts')}</th><th /></tr></thead>
      <tbody>
        {q.data.map((d) => (
          <tr key={d.id}>
            <td>{when(d.createdAt)}</td><td>{d.eventType}{d.redeliveryOf ? ` (${t('p12b.h.redelivery')})` : ''}</td>
            <td className={deliveryTone(d.status as DeliveryStatus)}>{d.status}{d.lastError ? ` · ${d.lastError}` : ''}</td>
            <td>{d.lastStatusCode ?? '—'}</td><td>{d.attempts}</td>
            <td>{canEdit && d.status !== 'skipped' && <button className="underline" onClick={() => redeliver.mutate(d.id!)}>{t('p12b.h.redeliver')}</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NewHook({ events, onClose, onCreated }: { events: string[]; onClose(): void; onCreated(secret: string): void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('https://');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => asFull<{ secret: string }>(api.POST('/developers/webhooks', { body: { name, url, events: picked } })),
    onSuccess: (r) => onCreated(r.secret),
    onError: (e) => { const c = (e as { code?: string }).code; setError(c === 'blocked_address' ? t('p12b.h.blocked') : (e as Error).message); },
  });
  return (
    <Dialog title={t('p12b.h.new')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label={t('p12b.h.name')}><input className="input" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('p12b.h.url')} hint={t('p12b.h.urlHint')}><input className="input" type="url" required pattern="https://.*" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
        <fieldset><legend className="label">{t('p12b.h.events')}</legend>
          {events.map((ev) => <label key={ev} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={picked.includes(ev)} onChange={() => setPicked((p) => (p.includes(ev) ? p.filter((x) => x !== ev) : [...p, ev]))} />{ev}</label>)}
        </fieldset>
        {error && <p role="alert" className="text-sm text-overdue">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!name || picked.length === 0 || save.isPending}>{t('p12b.h.create')}</button></div>
      </form>
    </Dialog>
  );
}
