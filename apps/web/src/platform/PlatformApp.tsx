import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR, SAAS_FEATURES } from '@worko/domain';
import { formatDate, formatDateTime } from '@worko/i18n';
import { useMemo, useState, type FormEvent } from 'react';
import { Field, Tabs } from '../components/Dialog';
import { I18nProvider, useT } from '../lib/i18n';
import { apiBase, webTokenStorage } from '../lib/platform';
import { bytes } from '../screens/settings/SubscriptionPanel';
import { IMPERSONATION_KEY } from './banner';

const KEY = 'worko.platform';
/** Platform tokens live in sessionStorage only (closing the tab signs out); they are never valid on firm routes (D178). */
const store = {
  get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set: (t: string | null) => { try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch { /* private mode */ } },
};

async function pfetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const tok = store.get();
  const r = await fetch(`${apiBase()}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  if (r.status === 401 && tok) { store.set(null); location.reload(); }
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw Object.assign(new Error(data?.message ?? `HTTP ${r.status}`), { status: r.status, code: data?.code });
  return data as T;
}

type TenantRow = { id: string; name: string; slug: string; plan: string; status: string; subStatus: string; createdAt: string };
type Detail = {
  tenant: TenantRow & { seatLimit: number | null; featureOverrides: Record<string, boolean>; suspendedReason: string | null; trialEndsOn: string | null; periodEnd: string | null };
  usage: { seatsUsed: number; seatLimit: number | null; storageBytes: number; messages: number; aiCalls: number; aiCostPaise: number };
  features: Record<string, boolean>; invoices: Array<{ id: string; number: string; totalPaise: number; status: string; dueDate: string }>;
  grants: Array<{ id: string; status: string; reason: string; requestedWrite: boolean; expiresAt: string | null }>;
  upgradeRequests: Array<{ id: string; planKey: string; cycle: string; status: string }>;
};
type PlanRow = { key: string; name: string; seats: number | null; storageGb: number | null; modules: Record<string, boolean>; prices: Array<{ id: string; cycle: string; pricePaise: number; effectiveFrom: string; unverified: boolean }> };

/** `#/platform` — the super-admin console: its own login (password + TOTP), never the firm session. */
export function PlatformRoot() {
  const qc = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }), []);
  const [tok, setTok] = useState(store.get());
  return (
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <main className="mx-auto max-w-6xl space-y-4 p-4">{tok ? <Console onSignOut={() => { void pfetch('/platform/auth/logout', { method: 'POST' }).catch(() => undefined); store.set(null); setTok(null); }} /> : <Login onDone={(t) => { store.set(t); setTok(t); }} />}</main>
      </QueryClientProvider>
    </I18nProvider>
  );
}

function Login({ onDone }: { onDone(t: string): void }) {
  const t = useT();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [totp, setTotp] = useState(''); const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(null);
    try { onDone((await pfetch<{ accessToken: string }>('/platform/auth/login', { method: 'POST', body: { email, password, totp: totp || undefined } })).accessToken); } catch (x) { setError((x as Error).message || t('p12a.pl.error')); }
  };
  return (
    <form onSubmit={submit} className="card mx-auto max-w-sm space-y-3 p-4" aria-label={t('p12a.pl.signIn')}>
      <h1 className="text-lg font-semibold">{t('p12a.pl.title')}</h1>
      <p className="text-sm text-muted">{t('p12a.pl.mfaHint')}</p>
      <Field label={t('p12a.pl.email')}><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
      <Field label={t('p12a.pl.password')}><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
      <Field label={t('p12a.pl.totp')}><input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" value={totp} onChange={(e) => setTotp(e.target.value)} required /></Field>
      {error && <p role="alert" className="text-sm text-overdue">{error}</p>}
      <button className="btn w-full">{t('p12a.pl.signIn')}</button>
    </form>
  );
}

function Console({ onSignOut }: { onSignOut(): void }) {
  const t = useT();
  const [view, setView] = useState<'tenants' | 'plans' | 'audit'>('tenants');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <header className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold">{t('p12a.pl.title')}</h1><button className="btn ml-auto" onClick={onSignOut}>{t('p12a.pl.signOut')}</button></header>
      <Tabs label={t('p12a.pl.title')} value={view} onChange={(v) => { setView(v); setOpen(null); }} tabs={[['tenants', t('p12a.pl.tenants')], ['plans', t('p12a.pl.plans')], ['audit', t('p12a.pl.audit')]]} />
      {view === 'tenants' && (open ? <TenantDetail id={open} onBack={() => setOpen(null)} /> : <Tenants onOpen={setOpen} />)}
      {view === 'plans' && <Plans />}
      {view === 'audit' && <Audit />}
    </>
  );
}

function Tenants({ onOpen }: { onOpen(id: string): void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['p', 'tenants', q], queryFn: () => pfetch<TenantRow[]>(`/platform/tenants?q=${encodeURIComponent(q)}`) });
  return (
    <section className="space-y-2">
      <input className="input max-w-sm" aria-label={t('p12a.pl.search')} placeholder={t('p12a.pl.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <table className="card w-full text-left text-sm"><thead><tr><th className="p-2">{t('p12a.pl.col.firm')}</th><th>{t('p12a.pl.col.plan')}</th><th>{t('p12a.pl.col.status')}</th><th>{t('p12a.pl.col.sub')}</th><th>{t('p12a.pl.col.created')}</th></tr></thead>
        <tbody>{(list.data ?? []).map((r) => (
          <tr key={r.id} className="cursor-pointer border-t border-border hover:bg-surface-alt" onClick={() => onOpen(r.id)}>
            <td className="p-2">{r.name} <span className="text-muted">({r.slug})</span></td><td>{r.plan}</td><td className={r.status === 'suspended' ? 'text-overdue' : ''}>{r.status}</td><td>{r.subStatus}</td><td>{formatDate(r.createdAt)}</td>
          </tr>))}</tbody>
      </table>
    </section>
  );
}

function TenantDetail({ id, onBack }: { id: string; onBack(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['p', 'tenant', id], queryFn: () => pfetch<Detail>(`/platform/tenants/${id}`) });
  const plans = useQuery({ queryKey: ['p', 'plans'], queryFn: () => pfetch<PlanRow[]>('/platform/plans') });
  const [reason, setReason] = useState(''); const [plan, setPlan] = useState(''); const [seats, setSeats] = useState('');
  const [impReason, setImpReason] = useState(''); const [impWrite, setImpWrite] = useState(false); const [impMin, setImpMin] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const call = useMutation({ mutationFn: (x: { path: string; method?: string; body?: unknown }) => pfetch<unknown>(x.path, { method: x.method ?? 'POST', body: x.body ?? {} }),
    onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: ['p'] }); }, onError: (e) => setError((e as Error).message) });
  const start = useMutation({
    mutationFn: (grantId: string) => pfetch<{ accessToken: string; tenantId: string; userId: string; grantId: string; expiresAt: string; write: boolean }>(`/platform/tenants/${id}/impersonations/${grantId}/start`, { method: 'POST', body: {} }),
    onSuccess: (s) => {
      // Open the firm app with the impersonation token; the firm UI shows a banner from /me.impersonation.
      try { sessionStorage.setItem(IMPERSONATION_KEY, JSON.stringify({ grantId: s.grantId, tenantId: s.tenantId, expiresAt: s.expiresAt })); } catch { /* ignore */ }
      webTokenStorage.save({ accessToken: s.accessToken, refreshToken: '', expiresIn: 900, sessionId: s.grantId, userId: s.userId, tenantId: s.tenantId });
      location.hash = '#/home'; location.reload();
    },
    onError: (e) => setError((e as Error).message),
  });
  if (!d.data) return <p className="text-muted">{t('common.loading')}</p>;
  const { tenant: tn, usage: u } = d.data;
  return (
    <section className="space-y-3 text-sm">
      <button className="btn" onClick={onBack}>← {t('p12a.pl.back')}</button>
      <h2 className="text-lg font-semibold">{tn.name} <span className="text-muted">({tn.slug})</span></h2>
      <p>{tn.plan} · {tn.subStatus}{tn.trialEndsOn ? ` · trial ${formatDate(tn.trialEndsOn)}` : ''}{tn.periodEnd ? ` · period end ${formatDate(tn.periodEnd)}` : ''}</p>
      {tn.status === 'suspended' && <p role="status" className="card border-overdue p-2">{t('p12a.pl.suspended', { reason: tn.suspendedReason ?? '' })}</p>}
      {error && <p role="alert" className="text-overdue">{error}</p>}
      <div className="card space-y-1 p-3"><h3 className="font-semibold">{t('p12a.pl.usage')}</h3>
        <p>{t('p12a.pl.seats', { used: u.seatsUsed, limit: u.seatLimit ?? t('p12a.pl.unlimited') })} · {t('p12a.pl.storage', { used: bytes(u.storageBytes) })} · {t('p12a.pl.messages', { n: u.messages })} · {t('p12a.pl.ai', { n: u.aiCalls, cost: formatINR(u.aiCostPaise) })}</p></div>
      <div className="card space-y-2 p-3">
        <h3 className="font-semibold">{t('p12a.pl.flags')}</h3><p className="text-muted">{t('p12a.pl.flagsHint')}</p>
        <ul className="flex flex-wrap gap-3">{SAAS_FEATURES.map((f) => {
          const over = tn.featureOverrides?.[f];
          return (<li key={f} className="flex items-center gap-1">
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!d.data.features[f]} onChange={(e) => call.mutate({ path: `/platform/tenants/${id}/flags`, method: 'PUT', body: { overrides: { [f]: e.target.checked } } })} />{f}</label>
            {over !== undefined && <button className="text-xs underline" title={t('p12a.pl.clear')} onClick={() => call.mutate({ path: `/platform/tenants/${id}/flags`, method: 'PUT', body: { overrides: { [f]: null } } })}>({t('p12a.pl.override')} ×)</button>}
          </li>);
        })}</ul>
      </div>
      <div className="card grid gap-2 p-3 sm:grid-cols-3">
        <Field label={t('p12a.pl.col.plan')}><select className="input" value={plan} onChange={(e) => setPlan(e.target.value)}><option value="" />{(plans.data ?? []).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></Field>
        <Field label={t('p12a.pl.seatOverride')}><input className="input" type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} /></Field>
        <button className="btn self-end" disabled={!plan} onClick={() => call.mutate({ path: `/platform/tenants/${id}/plan`, method: 'PUT', body: { planKey: plan, seatLimit: seats ? Number(seats) : null } })}>{t('p12a.pl.assign')}</button>
      </div>
      <div className="card flex flex-wrap items-end gap-2 p-3">
        {tn.status === 'suspended'
          ? <button className="btn" onClick={() => call.mutate({ path: `/platform/tenants/${id}/reactivate` })}>{t('p12a.pl.reactivate')}</button>
          : <><Field label={t('p12a.pl.reason')}><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <button className="btn text-overdue" disabled={reason.trim().length < 3} onClick={() => call.mutate({ path: `/platform/tenants/${id}/suspend`, body: { reason } })}>{t('p12a.pl.suspend')}</button></>}
        <button className="btn" onClick={() => call.mutate({ path: `/platform/tenants/${id}/lifecycle/run` })}>{t('p12a.pl.runLifecycle')}</button>
      </div>
      <div className="card p-3"><h3 className="font-semibold">{t('p12a.sub.invoices')}</h3>
        <ul>{d.data.invoices.map((i) => <li key={i.id}>{i.number} · {formatINR(i.totalPaise)} · {i.status} {i.status === 'issued' && <button className="btn ml-2" onClick={() => call.mutate({ path: `/platform/tenants/${id}/invoices/${i.id}/mark-paid` })}>{t('p12a.pl.markPaid')}</button>}</li>)}</ul>
        {d.data.upgradeRequests.length > 0 && <p className="text-muted">{t('p12a.sub.requests')}: {d.data.upgradeRequests.map((r) => `${r.planKey}/${r.cycle} (${r.status})`).join(' · ')}</p>}
      </div>
      <div className="card space-y-2 p-3"><h3 className="font-semibold">{t('p12a.pl.imp')}</h3>
        <ul>{d.data.grants.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center gap-2">“{g.reason}” · {g.status}{g.expiresAt ? ` · ${formatDateTime(g.expiresAt)}` : ''}
            {g.status === 'requested' && <span className="text-muted">{t('p12a.pl.impPending')}</span>}
            {g.status === 'approved' && <><button className="btn" onClick={() => start.mutate(g.id)}>{t('p12a.pl.impStart')}</button><button className="btn" onClick={() => call.mutate({ path: `/platform/tenants/${id}/impersonations/${g.id}/end` })}>{t('p12a.pl.impEnd')}</button></>}
          </li>))}</ul>
        <div className="grid gap-2 sm:grid-cols-4">
          <Field label={t('p12a.pl.impReason')}><input className="input" value={impReason} onChange={(e) => setImpReason(e.target.value)} /></Field>
          <Field label={t('p12a.pl.impMinutes')}><input className="input" type="number" min={5} max={240} value={impMin} onChange={(e) => setImpMin(Number(e.target.value) || 30)} /></Field>
          <label className="flex items-center gap-1 self-end"><input type="checkbox" checked={impWrite} onChange={(e) => setImpWrite(e.target.checked)} />{t('p12a.pl.impWrite')}</label>
          <button className="btn self-end" disabled={impReason.trim().length < 10} onClick={() => call.mutate({ path: `/platform/tenants/${id}/impersonations`, body: { reason: impReason, write: impWrite, minutes: impMin } })}>{t('p12a.pl.impRequest')}</button>
        </div>
      </div>
    </section>
  );
}

function Plans() {
  const t = useT();
  const q = useQuery({ queryKey: ['p', 'plans'], queryFn: () => pfetch<PlanRow[]>('/platform/plans') });
  return (
    <ul className="space-y-2 text-sm">{(q.data ?? []).map((p) => (
      <li key={p.key} className="card p-3"><strong>{p.name}</strong> <span className="text-muted">({p.key})</span> · seats {p.seats ?? t('p12a.pl.unlimited')} · {p.storageGb ?? '∞'} GB
        <div className="text-xs">{Object.entries(p.modules).filter(([, v]) => v).map(([k]) => k).join(', ')}</div>
        <ul className="text-xs">{p.prices.map((x) => <li key={x.id}>{t('p12a.pl.price', { cycle: x.cycle, price: formatINR(x.pricePaise), from: formatDate(x.effectiveFrom) })}{x.unverified ? ` (${t('p12a.pl.unverified')})` : ''}</li>)}</ul>
      </li>))}</ul>
  );
}

function Audit() {
  const t = useT();
  const q = useQuery({ queryKey: ['p', 'audit'], queryFn: () => pfetch<Array<{ seq: number; at: string; action: string; tenantId: string | null; entity: string }>>('/platform/audit?limit=200') });
  const [v, setV] = useState<string | null>(null);
  const verify = async () => { const r = await pfetch<{ ok: boolean; checked: number; brokenAt: number | null }>('/platform/audit/verify'); setV(r.ok ? t('p12a.pl.chainOk', { n: r.checked }) : t('p12a.pl.chainBroken', { seq: r.brokenAt ?? 0 })); };
  return (
    <section className="space-y-2 text-sm">
      <button className="btn" onClick={() => void verify()}>{t('p12a.pl.verify')}</button>{v && <span className="ml-2">{v}</span>}
      <table className="card w-full text-left"><tbody>{(q.data ?? []).map((r) => <tr key={r.seq} className="border-t border-border"><td className="p-1">#{r.seq}</td><td>{formatDateTime(r.at)}</td><td>{r.action}</td><td className="font-mono text-xs">{r.tenantId?.slice(0, 8) ?? ''}</td></tr>)}</tbody></table>
    </section>
  );
}
