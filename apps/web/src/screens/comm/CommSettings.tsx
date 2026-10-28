import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR, rupeesToPaise } from '@worko/domain';
import { formatDate, formatDateTime } from '@worko/i18n';
import { useEffect, useState } from 'react';
import { Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { apiBase } from '../../lib/platform';
import { api, useSession } from '../../lib/session';
import { as, body, CATEGORIES, CHANNELS, useCommError, useCommSettings, useLabel, useTemplates, type Channel, type CommSettings as Settings, type Connection, type Rate } from './api';
import { FlagBadge, NoAccess, StatusBadge } from './shared';

type Sub = 'policy' | 'rates' | 'connections';

/** Settings → Communication: channels, consent policy, caps, quiet hours, rates and mail/calendar connections. */
export function CommSettings() {
  const t = useT();
  const can = useCan();
  const [sub, setSub] = useState<Sub>('policy');
  if (!can('communication', 'view')) return <NoAccess />;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p7.cs.title')}</h1>
      <Tabs<Sub> label={t('p7.cs.title')} value={sub} onChange={setSub} tabs={[['policy', t('p7.cs.policy')], ['rates', t('p7.cs.rates')], ['connections', t('p7.cs.connections')]]} />
      {sub === 'policy' && <Policy />}
      {sub === 'rates' && <Rates />}
      {sub === 'connections' && <Connections />}
    </div>
  );
}

const rupees = (p: number | null) => (p === null ? '' : String(p / 100));
const toPaise = (s: string): number | null | undefined => (s.trim() === '' ? null : /^\d+(\.\d{1,2})?$/.test(s.trim()) ? rupeesToPaise(Number(s)) : undefined);

function Policy() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const err = useCommError();
  const label = useLabel();
  const s = useCommSettings().data;
  const templates = useTemplates().data ?? [];
  const rates = useQuery({ queryKey: ['comm', 'rates'], queryFn: () => as<Rate[]>(api.GET('/comm/rates')) }).data ?? [];
  const [f, setF] = useState<Settings | null>(null);
  const [caps, setCaps] = useState<Record<string, string>>({});
  useEffect(() => {
    if (s && !f) { setF(s); setCaps({ ...Object.fromEntries(CHANNELS.map((c) => [c, rupees(s.caps.monthlyPaise[c])])), perBroadcast: rupees(s.caps.perBroadcastPaise) }); }
  }, [s, f]);
  const save = useMutation({
    mutationFn: (v: Settings) => as<Settings>(api.PUT('/comm/settings', { body: body(v) })),
    onSuccess: (r) => { qc.setQueryData(['comm', 'settings'], r); toast({ text: t('p6.saved'), tone: 'ok' }, 3000); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  if (!f) return <p className="text-muted">{t('common.loading')}</p>;
  const editable = can('settings', 'edit');
  const parsed = Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, toPaise(v)]));
  const badCap = Object.values(parsed).some((v) => v === undefined);
  const waMock = templates.some((x) => x.channel === 'whatsapp' && x.providerRef?.startsWith('mock-'));
  const submit = () => {
    if (badCap) return;
    save.mutate({ ...f, caps: { ...f.caps, monthlyPaise: Object.fromEntries(CHANNELS.map((c) => [c, parsed[c] ?? null])) as Record<Channel, number | null>, perBroadcastPaise: parsed.perBroadcast ?? null } });
  };
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <fieldset disabled={!editable} className="space-y-4">
        <section className="card p-3">
          <h2 className="mb-2 font-semibold">{t('p7.cs.channels')}</h2>
          <ul className="space-y-1 text-sm">{CHANNELS.map((c) => {
            const unverified = rates.some((r) => r.channel === c && r.source === 'card' && !r.verified);
            return (
              <li key={c} className="flex flex-wrap items-center gap-2" data-testid={`chan-${c}`}><span className="w-24 font-medium">{label('channel', c)}</span>
                {c === 'whatsapp' && waMock && <FlagBadge kind="mock" />}
                {unverified ? <FlagBadge kind="unverified" /> : <FlagBadge kind="verified" />}
                <span className="text-xs text-muted">{t(`p7.cs.chanNote.${c}`)}</span></li>
            );
          })}</ul>
          <p className="mt-2 text-xs text-muted">{t('p7.cs.providerNote')}</p>
        </section>
        <section className="card space-y-2 p-3">
          <h2 className="font-semibold">{t('p7.cs.consent')}</h2>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.consent.transactionalRequiresOptIn} onChange={(e) => setF({ ...f, consent: { ...f.consent, transactionalRequiresOptIn: e.target.checked } })} /> {t('p7.cs.txnOptIn')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.consent.optOutBlocksTransactional} onChange={(e) => setF({ ...f, consent: { ...f.consent, optOutBlocksTransactional: e.target.checked } })} /> {t('p7.cs.optOutBlocks')}</label>
          <p className="text-xs text-muted">{t('p7.cs.marketingNote')}</p>
        </section>
        <section className="card space-y-2 p-3">
          <h2 className="font-semibold">{t('p7.cs.quiet')}</h2>
          <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.quietHours} onChange={(e) => setF({ ...f, quietHours: e.target.checked ? { start: '21:00', end: '08:00', appliesTo: 'all' } : null })} /> {t('p7.cs.quietOn')}</label>
          {f.quietHours && <div className="grid grid-cols-3 gap-2">
            <Field label={t('p6.f.from')}><input type="time" className="input" value={f.quietHours.start} onChange={(e) => setF({ ...f, quietHours: { ...f.quietHours!, start: e.target.value } })} /></Field>
            <Field label={t('p6.f.to')}><input type="time" className="input" value={f.quietHours.end} onChange={(e) => setF({ ...f, quietHours: { ...f.quietHours!, end: e.target.value } })} /></Field>
            <Field label={t('p7.cs.appliesTo')}><select className="input" value={f.quietHours.appliesTo} onChange={(e) => setF({ ...f, quietHours: { ...f.quietHours!, appliesTo: e.target.value as 'all' | 'marketing' } })}>
              <option value="all">{t('p7.cs.allMessages')}</option><option value="marketing">{t('p7.cs.marketingOnly')}</option></select></Field>
          </div>}
          <p className="text-xs text-muted">{t('p7.cs.istNote')}</p>
        </section>
        <section className="card space-y-2 p-3">
          <h2 className="font-semibold">{t('p7.cs.caps')}</h2>
          <div className="grid gap-2 sm:grid-cols-4">
            {CHANNELS.map((c) => <Field key={c} label={t('p7.cs.monthlyCap', { channel: label('channel', c) })} error={parsed[c] === undefined ? t('p7.cs.badAmount') : null}>
              <input className="input" inputMode="decimal" placeholder={t('p7.usage.noCap')} value={caps[c] ?? ''} onChange={(e) => setCaps({ ...caps, [c]: e.target.value })} /></Field>)}
            <Field label={t('p7.cs.perBroadcast')} error={parsed.perBroadcast === undefined ? t('p7.cs.badAmount') : null}>
              <input className="input" inputMode="decimal" placeholder={t('p7.usage.noCap')} value={caps.perBroadcast ?? ''} onChange={(e) => setCaps({ ...caps, perBroadcast: e.target.value })} /></Field>
          </div>
          <Field label={t('p7.cs.capMode')}><select className="input w-56" value={f.caps.mode} onChange={(e) => setF({ ...f, caps: { ...f.caps, mode: e.target.value as 'block' | 'warn' } })}>
            <option value="block">{t('p7.capMode.block')}</option><option value="warn">{t('p7.capMode.warn')}</option></select></Field>
        </section>
        <section className="card grid gap-2 p-3 sm:grid-cols-4">
          <h2 className="font-semibold sm:col-span-4">{t('p7.cs.broadcastChat')}</h2>
          <NumField label={t('p7.cs.threshold')} value={f.broadcast.approvalThreshold} onChange={(v) => setF({ ...f, broadcast: { ...f.broadcast, approvalThreshold: v } })} />
          <NumField label={t('p7.cs.batchSize')} value={f.broadcast.batchSize} min={1} onChange={(v) => setF({ ...f, broadcast: { ...f.broadcast, batchSize: v } })} />
          <NumField label={t('p7.cs.batchInterval')} value={f.broadcast.batchIntervalSeconds} onChange={(v) => setF({ ...f, broadcast: { ...f.broadcast, batchIntervalSeconds: v } })} />
          <NumField label={t('p7.cs.editWindow')} value={f.chat.editWindowMinutes} onChange={(v) => setF({ ...f, chat: { ...f.chat, editWindowMinutes: v } })} />
        </section>
      </fieldset>
      {editable ? <button className="btn btn-primary" disabled={badCap || save.isPending}>{t('common.save')}</button> : <p className="text-sm text-muted">{t('p7.cs.readOnly')}</p>}
    </form>
  );
}

function NumField({ label, value, onChange, min = 0 }: { label: string; value: number; onChange(v: number): void; min?: number }) {
  return <Field label={label}><input type="number" className="input" min={min} value={value} onChange={(e) => onChange(Math.max(min, Math.floor(Number(e.target.value) || 0)))} /></Field>;
}

function Rates() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const err = useCommError();
  const label = useLabel();
  const q = useQuery({ queryKey: ['comm', 'rates'], queryFn: () => as<Rate[]>(api.GET('/comm/rates')) });
  const [channel, setChannel] = useState<Channel>('sms');
  const [category, setCategory] = useState<string>('*');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(todayIst());
  const paise = toPaise(amount);
  const add = useMutation({
    mutationFn: () => as(api.POST('/comm/rates', { body: body({ channel, category, paise: paise!, effectiveFrom: from }) })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['comm', 'rates'] }); setAmount(''); toast({ text: t('p6.saved'), tone: 'ok' }, 3000); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{t('p7.cs.ratesHint')}</p>
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p7.cs.rates')}>
        <thead><tr><th>{t('p7.f.channel')}</th><th>{t('p7.f.category')}</th><th className="text-right">{t('p7.cs.perMessage')}</th><th>{t('p6.f.from')}</th><th>{t('p7.cs.source')}</th></tr></thead>
        <tbody>{(q.data ?? []).map((r) => (
          <tr key={`${r.channel}:${r.category}:${r.effectiveFrom}:${r.source}`}><td>{label('channel', r.channel)}</td><td>{r.category === '*' ? t('p7.cs.anyCategory') : label('category', r.category)}</td>
            <td className="text-right tabular-nums">{formatINR(r.paise)}</td><td>{formatDate(r.effectiveFrom)}{r.effectiveTo ? ` – ${formatDate(r.effectiveTo)}` : ''}</td>
            <td className="space-x-1">{r.source === 'firm' ? <span className="text-xs">{t('p7.cs.firmRate')}</span> : <span className="text-xs">{t('p7.cs.cardRate')}</span>} {r.source === 'card' && <FlagBadge kind={r.verified ? 'verified' : 'unverified'} />}
              {r.note && <span className="block text-xs text-muted">{r.note}</span>}</td></tr>
        ))}</tbody>
      </table></div>
      {can('settings', 'edit') && <form className="card flex flex-wrap items-end gap-2 p-3" onSubmit={(e) => { e.preventDefault(); if (typeof paise === 'number') add.mutate(); }}>
        <Field label={t('p7.f.channel')}><select className="input" value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>{CHANNELS.map((c) => <option key={c} value={c}>{label('channel', c)}</option>)}</select></Field>
        <Field label={t('p7.f.category')}><select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="*">{t('p7.cs.anyCategory')}</option>{CATEGORIES.map((c) => <option key={c} value={c}>{label('category', c)}</option>)}</select></Field>
        <Field label={t('p7.cs.rateRupees')} error={amount && typeof paise !== 'number' ? t('p7.cs.badAmount') : null}><input className="input w-28" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label={t('p7.cs.effectiveFrom')}><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <button className="btn btn-primary" disabled={typeof paise !== 'number' || add.isPending}>{t('p7.cs.addRate')}</button>
      </form>}
    </div>
  );
}

const CONNECT: Array<{ key: string; provider: 'google' | 'microsoft' | 'mock'; purpose: 'mail' | 'calendar' }> = [
  { key: 'gmail', provider: 'google', purpose: 'mail' }, { key: 'outlook', provider: 'microsoft', purpose: 'mail' },
  { key: 'gcal', provider: 'google', purpose: 'calendar' }, { key: 'outlookCal', provider: 'microsoft', purpose: 'calendar' },
];

function Connections() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const err = useCommError();
  const label = useLabel();
  const q = useQuery({ queryKey: ['comm', 'connections'], queryFn: () => as<Connection[]>(api.GET('/comm/connections')) });
  const start = useMutation({
    mutationFn: async (c: { provider: string; purpose: string }) => {
      // The response sets an httpOnly binding cookie (D103), so this must be a credentialed request before the redirect.
      const tokens = useSession.getState().tokens;
      const res = await fetch(`${apiBase()}/comm/connections`, { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', ...(tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}) }, body: JSON.stringify(c) });
      const j = await res.json().catch(() => ({})) as { authUrl?: string; message?: string; code?: string };
      if (!res.ok || !j.authUrl) throw Object.assign(new Error(j.message ?? `HTTP ${res.status}`), { code: j.code, status: res.status });
      return { authUrl: j.authUrl };
    },
    onSuccess: (r) => { location.assign(r.authUrl); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => as(api.DELETE('/comm/connections/{id}', { params: { path: { id } } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['comm', 'connections'] }); toast({ text: t('p7.conn.revoked'), tone: 'ok' }, 3000); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const sync = useMutation({
    mutationFn: (id: string) => as<Record<string, number>>(api.POST('/comm/connections/{id}/sync', { params: { path: { id } } })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['comm', 'connections'] }); toast({ text: t('p7.conn.synced', { summary: Object.entries(r).map(([k, v]) => `${k} ${v}`).join(', ') }), tone: 'ok' }, 5000); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{t('p7.conn.hint')}</p>
      {can('communication', 'create') && <div className="flex flex-wrap gap-2">
        {CONNECT.map((c) => <button key={c.key} className="btn" disabled={start.isPending} onClick={() => start.mutate({ provider: c.provider, purpose: c.purpose })}>{t(`p7.conn.connect.${c.key}` as 'p7.conn.connect.gmail')}</button>)}
      </div>}
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p7.cs.connections')}>
        <thead><tr><th>{t('p7.conn.provider')}</th><th>{t('p7.conn.purpose')}</th><th>{t('p7.conn.account')}</th><th>{t('p6.f.status')}</th><th>{t('p7.conn.lastSync')}</th><th /></tr></thead>
        <tbody>{(q.data ?? []).map((c) => (
          <tr key={c.id}><td>{label('provider', c.provider)} {c.provider === 'mock' && <FlagBadge kind="mock" />}</td><td>{label('purpose', c.purpose)}</td><td>{c.accountEmail ?? '—'}</td>
            <td><StatusBadge status={c.status} family="cstatus" />{c.lastError && <span className="block text-xs text-overdue">{c.lastError}</span>}</td>
            <td>{c.lastSyncAt ? formatDateTime(c.lastSyncAt) : t('common.never')}</td>
            <td className="space-x-1 whitespace-nowrap text-right">
              {c.status === 'active' && <button className="btn" disabled={sync.isPending} onClick={() => sync.mutate(c.id)}>{t('p7.conn.syncNow')}</button>}
              <button className="btn btn-danger" onClick={() => revoke.mutate(c.id)}>{t('p7.conn.revoke')}</button></td></tr>
        ))}</tbody>
      </table></div>
      {!q.isLoading && !q.data?.length && <p className="text-sm text-muted">{t('p7.conn.none')}</p>}
    </div>
  );
}
