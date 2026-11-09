import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR, SAAS_FEATURES } from '@worko/domain';
import { formatDate, formatDateTime } from '@worko/i18n';
import { useMemo, useState, type FormEvent } from 'react';
import { Field, Tabs } from '../components/Dialog';
import { I18nProvider, useT } from '../lib/i18n';
import { apiBase, webTokenStorage } from '../lib/platform';
import { bytes } from '../screens/settings/SubscriptionPanel';
import { IMPERSONATION_KEY } from './banner';
import { useCountUp } from '../screens/HomeScreen';

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
  const [view, setView] = useState<'tenants' | 'announcements' | 'plans' | 'audit'>('tenants');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <header className="glass rise flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
        <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full border-[3px] border-primary"><span className="breathe h-3 w-3 rounded-full bg-primary" /></span>
        <h1 className="text-xl font-bold">{t('p12a.pl.title')}</h1>
        <button className="btn ml-auto" onClick={onSignOut}>{t('p12a.pl.signOut')}</button>
      </header>
      <Tabs label={t('p12a.pl.title')} value={view} onChange={(v) => { setView(v); setOpen(null); }} tabs={[['tenants', t('p12a.pl.tenants')], ['announcements', t('p12a.pl.ann')], ['plans', t('p12a.pl.plans')], ['audit', t('p12a.pl.audit')]]} />
      <div key={`${view}:${open ?? ''}`} className="page space-y-4">
        {view === 'tenants' && (open ? <TenantDetail id={open} onBack={() => setOpen(null)} /> : <><Overview onOpen={setOpen} /><Tenants onOpen={setOpen} /></>)}
        {view === 'announcements' && <Announcements />}
        {view === 'plans' && <Plans />}
        {view === 'audit' && <Audit />}
      </div>
    </>
  );
}

type OverviewData = { topFirms: Array<{ id: string; name: string; slug: string; users: number }>; firms: number; active: number; suspended: number; newThisMonth: number; users: number; activeUsers: number; recent: Array<{ id: string; name: string; slug: string; plan: string; createdAt: string }> };

function Stat({ label, value, hero }: { label: string; value: number; hero?: boolean }) {
  const n = useCountUp(value);
  return (
    <div className={`tile tile-hover ${hero ? 'hero' : ''}`}>
      <div className={`text-sm font-semibold ${hero ? 'text-white/90' : 'text-muted'}`}>{label}</div>
      <div className="mt-2 text-[36px] font-bold leading-none tabular-nums">{n}</div>
    </div>
  );
}

function Overview({ onOpen }: { onOpen(id: string): void }) {
  const t = useT();
  const o = useQuery({ queryKey: ['p', 'overview'], queryFn: () => pfetch<OverviewData>('/platform/overview') });
  if (!o.data) return <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((k) => <div key={k} className="skeleton h-24" />)}</div>;
  const d = o.data;
  return (
    <section className="space-y-3" aria-label={t('p12a.pl.overview')}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat hero label={t('p12a.pl.ov.firms')} value={d.firms} />
        <Stat label={t('p12a.pl.ov.active')} value={d.active} />
        <Stat label={t('p12a.pl.ov.suspended')} value={d.suspended} />
        <Stat label={t('p12a.pl.ov.users')} value={d.activeUsers} />
        <Stat label={t('p12a.pl.ov.new')} value={d.newThisMonth} />
      </div>
      {d.topFirms.length > 0 && (
        <div className="card p-4 text-sm">
          <div className="mb-2 font-semibold">{t('p12a.pl.ov.top')}</div>
          <ul className="space-y-2">{d.topFirms.map((f) => {
            const max = Math.max(1, d.topFirms[0]!.users);
            return (
              <li key={f.id}><button className="group flex w-full items-center gap-3 text-left" onClick={() => onOpen(f.id)}>
                <span className="w-56 truncate group-hover:text-primary">{f.name}</span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-alt"><span className="block h-full origin-left rounded-full bg-primary transition-all duration-700" style={{ width: `${Math.max(4, (f.users / max) * 100)}%` }} /></span>
                <span className="w-10 text-right tabular-nums text-muted">{f.users}</span>
              </button></li>
            );
          })}</ul>
        </div>
      )}
      {d.recent.length > 0 && (
        <div className="card flex flex-wrap items-center gap-2 p-3 text-sm">
          <span className="font-semibold">{t('p12a.pl.ov.recent')}</span>
          {d.recent.map((f) => <button key={f.id} className="btn py-1" onClick={() => onOpen(f.id)}>{f.name} <span className="text-muted">({f.slug})</span></button>)}
        </div>
      )}
    </section>
  );
}

function Tenants({ onOpen }: { onOpen(id: string): void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | 'active' | 'suspended'>('');
  const list = useQuery({ queryKey: ['p', 'tenants', q, status], placeholderData: (prev) => prev,
    queryFn: () => pfetch<TenantRow[]>(`/platform/tenants?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`) });
  const activity = useQuery({ queryKey: ['p', 'activity'], queryFn: () => pfetch<Record<string, { users: number; lastActive: string | null }>>('/platform/activity') });
  const ago = (iso: string | null) => {
    if (!iso) return t('p12a.pl.never');
    const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    return m < 60 ? t('p12a.pl.minAgo', { n: Math.max(1, m) }) : m < 1440 ? t('p12a.pl.hAgo', { n: Math.round(m / 60) }) : t('p12a.pl.dAgo', { n: Math.round(m / 1440) });
  };
  const exportCsv = () => {
    const rows = [['Firm', 'Firm ID', 'Plan', 'Status', 'Subscription', 'Created'], ...(list.data ?? []).map((r) => [r.name, r.slug, r.plan, r.status, r.subStatus, r.createdAt.slice(0, 10)])];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `firms-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input max-w-sm" aria-label={t('p12a.pl.search')} placeholder={t('p12a.pl.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex gap-1" role="group" aria-label={t('p12a.pl.filter')}>
          {([['', t('p12a.pl.filterAll')], ['active', t('p12a.pl.filterActive')], ['suspended', t('p12a.pl.filterSuspended')]] as const).map(([k, label]) => (
            <button key={k} className={`btn ${status === k ? 'btn-primary' : ''}`} aria-pressed={status === k} onClick={() => setStatus(k)}>{label}</button>
          ))}
        </div>
        <button className="btn ml-auto" onClick={exportCsv} disabled={!list.data?.length}>{t('p12a.pl.exportCsv')}</button>
        {!creating && <button className="btn btn-primary" onClick={() => { setCreating(true); setDone(null); }}>+ {t('p12a.pl.newFirm')}</button>}
      </div>
      {done && <p role="status" className="card p-2">{t('p12a.pl.created', { slug: done })}</p>}
      {creating && <CreateFirm onCancel={() => setCreating(false)} onCreated={(slug) => { setCreating(false); setDone(slug); }} />}
      <table className="table card w-full overflow-hidden text-left text-sm"><thead><tr><th className="p-2">{t('p12a.pl.col.firm')}</th><th>{t('p12a.pl.col.plan')}</th><th>{t('p12a.pl.col.status')}</th><th>{t('p12a.pl.col.sub')}</th><th>{t('p12a.pl.col.users')}</th><th>{t('p12a.pl.col.lastActive')}</th><th>{t('p12a.pl.col.created')}</th></tr></thead>
        <tbody>{(list.data ?? []).map((r) => (
          <tr key={r.id} className="cursor-pointer border-t border-border hover:bg-surface-alt" onClick={() => onOpen(r.id)}>
            <td className="p-2">{r.name} <span className="text-muted">({r.slug})</span></td><td>{r.plan}</td><td className={r.status === 'suspended' ? 'text-overdue' : ''}>{r.status}</td><td>{r.subStatus}</td><td className="tabular-nums">{activity.data?.[r.id]?.users ?? '…'}</td><td className="text-muted">{activity.data ? ago(activity.data[r.id]?.lastActive ?? null) : '…'}</td><td>{formatDate(r.createdAt)}</td>
          </tr>))}</tbody>
      </table>
    </section>
  );
}

function CreateFirm({ onCancel, onCreated }: { onCancel(): void; onCreated(slug: string): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [f, setF] = useState({ firmName: '', slug: '', stateCode: '', seatLimit: '', name: '', email: '', phone: '', password: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => pfetch<{ slug: string }>('/platform/tenants', { method: 'POST', body: {
      firmName: f.firmName, slug: f.slug.trim().toLowerCase(), stateCode: f.stateCode, seatLimit: f.seatLimit ? Number(f.seatLimit) : null,
      admin: { name: f.name, email: f.email, password: f.password, phone: f.phone || undefined } } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['p'] }); onCreated(r.slug); },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <form className="card space-y-2 p-3 text-sm" aria-label={t('p12a.pl.newFirm')} onSubmit={(e) => { e.preventDefault(); setError(null); create.mutate(); }}>
      <h2 className="font-semibold">{t('p12a.pl.newFirm')}</h2>
      <p className="text-muted">{t('p12a.pl.newFirmHint')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={t('p12a.pl.firmName')}><input className="input" value={f.firmName} onChange={set('firmName')} required minLength={2} /></Field>
        <Field label={t('p12a.pl.firmId')}><input className="input" value={f.slug} onChange={set('slug')} required pattern="[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?" title={t('p12a.pl.firmIdHint')} placeholder="rao-associates" /></Field>
        <Field label={t('p12a.pl.state')}><input className="input" value={f.stateCode} onChange={set('stateCode')} required pattern="\d{2}" inputMode="numeric" placeholder="33" /></Field>
        <Field label={t('p12a.pl.userLimit')}><input className="input" type="number" min={1} value={f.seatLimit} onChange={set('seatLimit')} /></Field>
        <Field label={t('p12a.pl.adminName')}><input className="input" value={f.name} onChange={set('name')} required /></Field>
        <Field label={t('p12a.pl.adminEmail')}><input className="input" type="email" value={f.email} onChange={set('email')} required /></Field>
        <Field label={t('p12a.pl.adminPhone')}><input className="input" value={f.phone} onChange={set('phone')} /></Field>
        <Field label={t('p12a.pl.adminPassword')}><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required minLength={8} /></Field>
      </div>
      {error && <p role="alert" className="text-overdue">{error}</p>}
      <div className="flex gap-2"><button className="btn" disabled={create.isPending}>{t('p12a.pl.create')}</button><button type="button" className="btn" onClick={onCancel}>{t('p12a.pl.cancel')}</button></div>
    </form>
  );
}

type FirmUser = { id: string; name: string; email: string; status: string; roles: string[]; lockedUntil: string | null; lastSignIn: string | null };

function FirmUsers({ id }: { id: string }) {
  const t = useT();
  const users = useQuery({ queryKey: ['p', 'tenant-users', id], queryFn: () => pfetch<FirmUser[]>(`/platform/tenants/${id}/users`) });
  const [resetFor, setResetFor] = useState<string | null>(null); const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const reset = useMutation({
    mutationFn: (userId: string) => pfetch(`/platform/tenants/${id}/users/${userId}/reset-password`, { method: 'POST', body: { password: pw } }),
    onSuccess: () => { setResetFor(null); setPw(''); setMsg(t('p12a.pl.pwReset')); void users.refetch(); }, onError: (e) => setMsg((e as Error).message),
  });
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (x: { id: string; status: 'active' | 'disabled' }) => pfetch(`/platform/tenants/${id}/users/${x.id}/status`, { method: 'POST', body: { status: x.status } }),
    onSuccess: (_r, x) => { setMsg(x.status === 'active' ? t('p12a.pl.enabled') : t('p12a.pl.disabled')); void users.refetch(); void qc.invalidateQueries({ queryKey: ['p', 'tenant', id] }); },
    onError: (e) => setMsg((e as Error).message),
  });
  return (
    <div className="card space-y-2 p-3"><h3 className="font-semibold">{t('p12a.pl.users')} ({users.data?.length ?? 0})</h3>
      {msg && <p role="status">{msg}</p>}
      <ul className="space-y-1">{(users.data ?? []).map((u) => (
        <li key={u.id} className="flex flex-wrap items-center gap-2 border-t border-border pt-1">
          <span><strong>{u.name}</strong> · {u.email} · {u.roles.join(', ')} · <span className={u.status === 'active' ? '' : 'text-overdue'}>{u.status}</span>
            {u.lockedUntil && new Date(u.lockedUntil) > new Date() ? <span className="text-overdue"> · {t('p12a.pl.locked')}</span> : null}
            <span className="text-muted"> · {u.lastSignIn ? t('p12a.pl.lastSignIn', { at: formatDateTime(u.lastSignIn) }) : t('p12a.pl.never')}</span></span>
          {resetFor === u.id
            ? <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); reset.mutate(u.id); }}>
                <input className="input" type="password" autoComplete="new-password" aria-label={t('p12a.pl.newPassword')} placeholder={t('p12a.pl.newPassword')} value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required />
                <button className="btn">{t('p12a.pl.save')}</button><button type="button" className="btn" onClick={() => setResetFor(null)}>{t('p12a.pl.cancel')}</button></form>
            : <span className="ml-auto flex gap-1">
                <button className="btn" onClick={() => { setResetFor(u.id); setPw(''); setMsg(null); }}>{t('p12a.pl.resetPw')}</button>
                <button className={`btn ${u.status === 'active' ? 'btn-danger' : ''}`} disabled={toggle.isPending} onClick={() => toggle.mutate({ id: u.id, status: u.status === 'active' ? 'disabled' : 'active' })}>
                  {u.status === 'active' ? t('p12a.pl.disable') : t('p12a.pl.enable')}</button>
              </span>}
        </li>))}</ul>
    </div>
  );
}

function FirmExport({ id, slug }: { id: string; slug: string }) {
  const t = useT();
  const [reason, setReason] = useState(''); const [error, setError] = useState<string | null>(null);
  const exp = useMutation({
    mutationFn: () => pfetch<unknown>(`/platform/tenants/${id}/export`, { method: 'POST', body: { reason } }),
    onSuccess: (data) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `${slug}-export-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setReason('');
    },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <div className="card space-y-2 p-3"><h3 className="font-semibold">{t('p12a.pl.export')}</h3><p className="text-muted">{t('p12a.pl.exportHint')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('p12a.pl.exportReason')}><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <button className="btn" disabled={reason.trim().length < 5 || exp.isPending} onClick={() => { setError(null); exp.mutate(); }}>{exp.isPending ? t('p12a.pl.exporting') : t('p12a.pl.export')}</button>
      </div>
      {error && <p role="alert" className="text-overdue">{error}</p>}
    </div>
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
  const [renaming, setRenaming] = useState<string | null>(null);
  const integ = useQuery({ queryKey: ['p', 'integrations'], queryFn: () => pfetch<Record<string, boolean>>('/platform/integrations') });
  // Modules that need an outside service are only offered once this server is connected to it.
  const connected = (f: string) => !['ai', 'payments', 'whatsapp', 'esign', 'portal'].includes(f) || integ.data?.[f] !== false;
  const timeline = useQuery({ queryKey: ['p', 'timeline', id], queryFn: () => pfetch<Array<{ seq: number; at: string; action: string; diff?: unknown }>>(`/platform/audit?tenantId=${id}&limit=50`) });
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
      {renaming === null
        ? <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">{tn.name} <span className="text-muted">({tn.slug})</span><button className="btn py-0.5 text-xs" onClick={() => setRenaming(tn.name)}>{t('p12a.pl.rename')}</button></h2>
        : <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); call.mutate({ path: `/platform/tenants/${id}/name`, method: 'PUT', body: { name: renaming } }, { onSuccess: () => setRenaming(null) }); }}>
            <input className="input max-w-sm" aria-label={t('p12a.pl.firmName')} value={renaming} onChange={(e) => setRenaming(e.target.value)} minLength={2} required />
            <button className="btn btn-primary">{t('p12a.pl.save')}</button><button type="button" className="btn" onClick={() => setRenaming(null)}>{t('p12a.pl.cancel')}</button></form>}
      <p>{tn.plan} · {tn.subStatus}{tn.subStatus === 'trial' && tn.trialEndsOn ? ` · trial ${formatDate(tn.trialEndsOn)}` : ''}{tn.periodEnd ? ` · period end ${formatDate(tn.periodEnd)}` : ''}</p>
      {tn.status === 'suspended' && <p role="status" className="card border-overdue p-2">{t('p12a.pl.suspended', { reason: tn.suspendedReason ?? '' })}</p>}
      {error && <p role="alert" className="text-overdue">{error}</p>}
      <div className="card space-y-1 p-3"><h3 className="font-semibold">{t('p12a.pl.usage')}</h3>
        <p>{t('p12a.pl.seats', { used: u.seatsUsed, limit: u.seatLimit ?? t('p12a.pl.unlimited') })} · {t('p12a.pl.storage', { used: bytes(u.storageBytes) })} · {t('p12a.pl.messages', { n: u.messages })} · {t('p12a.pl.ai', { n: u.aiCalls, cost: formatINR(u.aiCostPaise) })}</p></div>
      <FirmUsers id={id} />
      <div className="card p-3"><h3 className="mb-2 font-semibold">{t('p12a.pl.timeline')}</h3>
        {timeline.data?.length ? <ol className="relative space-y-2 border-l-2 border-border pl-4">{timeline.data.map((x) => (
          <li key={x.seq} className="relative"><span aria-hidden className="absolute -left-[22px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
            <span className="font-medium">{x.action.replace(/^platform\./, '').replace(/_/g, ' ')}</span> <span className="text-muted">· {formatDateTime(x.at)}</span></li>
        ))}</ol> : <p className="text-muted">{t('p12a.pl.noTimeline')}</p>}
      </div>
      <FirmExport id={id} slug={tn.slug} />
      <div className="card space-y-2 p-3">
        <h3 className="font-semibold">{t('p12a.pl.flags')}</h3><p className="text-muted">{t('p12a.pl.flagsHint')}</p>
        <ul className="flex flex-wrap gap-3">{SAAS_FEATURES.filter((f) => connected(f)).map((f) => {
          const over = tn.featureOverrides?.[f];
          return (<li key={f} className="flex items-center gap-1">
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!d.data.features[f]} onChange={(e) => call.mutate({ path: `/platform/tenants/${id}/flags`, method: 'PUT', body: { overrides: { [f]: e.target.checked } } })} />{f}</label>
            {over !== undefined && <button className="text-xs underline" title={t('p12a.pl.clear')} onClick={() => call.mutate({ path: `/platform/tenants/${id}/flags`, method: 'PUT', body: { overrides: { [f]: null } } })}>({t('p12a.pl.override')} ×)</button>}
          </li>);
        })}</ul>
        {SAAS_FEATURES.some((f) => !connected(f)) && <p className="text-xs text-muted">{t('p12a.pl.notConnected', { list: SAAS_FEATURES.filter((f) => !connected(f)).join(', ') })}</p>}
      </div>
      <div className="card grid gap-2 p-3 sm:grid-cols-3">
        <Field label={t('p12a.pl.col.plan')}><select className="input" value={plan || tn.plan} onChange={(e) => setPlan(e.target.value)}>{(plans.data ?? []).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></Field>
        <Field label={t('p12a.pl.seatOverride')}><input className="input" type="number" min={1} placeholder={tn.seatLimit ? String(tn.seatLimit) : ''} value={seats} onChange={(e) => setSeats(e.target.value)} /></Field>
        <button className="btn self-end" onClick={() => call.mutate({ path: `/platform/tenants/${id}/plan`, method: 'PUT', body: { planKey: plan || tn.plan, seatLimit: seats ? Number(seats) : null } })}>{t('p12a.pl.assign')}</button>
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

type AnnRow = { id: string; tenantId: string | null; firmName: string | null; title: string; body: string; level: 'info' | 'warning' | 'critical'; startsAt: string; endsAt: string | null; active: boolean; createdAt: string };

function Announcements() {
  const t = useT();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['p', 'announcements'], queryFn: () => pfetch<AnnRow[]>('/platform/announcements') });
  const firms = useQuery({ queryKey: ['p', 'tenants', '', ''], queryFn: () => pfetch<TenantRow[]>('/platform/tenants') });
  const [f, setF] = useState({ title: '', body: '', level: 'info' as AnnRow['level'], tenantId: '', endsAt: '' });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => pfetch('/platform/announcements', { method: 'POST', body: { title: f.title, body: f.body || undefined, level: f.level, tenantId: f.tenantId || null, endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null } }),
    onSuccess: () => { setF({ title: '', body: '', level: 'info', tenantId: '', endsAt: '' }); setError(null); void qc.invalidateQueries({ queryKey: ['p', 'announcements'] }); },
    onError: (e) => setError((e as Error).message),
  });
  const toggle = useMutation({ mutationFn: (x: { id: string; active: boolean }) => pfetch(`/platform/announcements/${x.id}/active`, { method: 'PUT', body: { active: x.active } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['p', 'announcements'] }) });
  const live = (a: AnnRow) => a.active && (!a.endsAt || Date.parse(a.endsAt) > Date.now());
  const dot = { info: 'bg-primary', warning: 'bg-amber-500', critical: 'bg-red-600' } as const;
  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
      <form className="card h-fit space-y-3 p-4 text-sm" onSubmit={(e) => { e.preventDefault(); create.mutate(); }} aria-label={t('p12a.pl.annNew')}>
        <h2 className="text-base font-semibold">{t('p12a.pl.annNew')}</h2>
        <Field label={t('p12a.pl.annTitle')}><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} maxLength={140} /></Field>
        <Field label={t('p12a.pl.annBody')}><textarea className="input min-h-20" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} maxLength={1000} /></Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('p12a.pl.annLevel')}><select className="input" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value as AnnRow['level'] })}>
            <option value="info">{t('p12a.pl.annInfo')}</option><option value="warning">{t('p12a.pl.annWarning')}</option><option value="critical">{t('p12a.pl.annCritical')}</option></select></Field>
          <Field label={t('p12a.pl.annTo')}><select className="input" value={f.tenantId} onChange={(e) => setF({ ...f, tenantId: e.target.value })}>
            <option value="">{t('p12a.pl.annAll')}</option>{(firms.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        </div>
        <Field label={t('p12a.pl.annEnds')}><input className="input" type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></Field>
        {error && <p role="alert" className="text-overdue">{error}</p>}
        <button className="btn btn-primary" disabled={create.isPending}>{t('p12a.pl.annPublish')}</button>
      </form>
      <div className="card p-4 text-sm">
        <h2 className="mb-3 text-base font-semibold">{t('p12a.pl.ann')}</h2>
        {!list.data?.length ? <p className="text-muted">{t('p12a.pl.annNone')}</p> : (
          <ul className="space-y-2">{list.data.map((a) => (
            <li key={a.id} className={`flex items-start gap-3 rounded-xl border border-border p-3 ${live(a) ? '' : 'opacity-60'}`}>
              <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dot[a.level]}`} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{a.title}</div>
                {a.body && <div className="text-muted">{a.body}</div>}
                <div className="mt-1 text-xs text-muted">{a.firmName ?? t('p12a.pl.annAll')} · {formatDateTime(a.createdAt)}{a.endsAt ? ` → ${formatDateTime(a.endsAt)}` : ''} · {live(a) ? t('p12a.pl.annLive') : t('p12a.pl.annEnded')}</div>
              </div>
              <button className="btn py-1" onClick={() => toggle.mutate({ id: a.id, active: !a.active })}>{a.active ? t('p12a.pl.annEnd') : t('p12a.pl.annResume')}</button>
            </li>
          ))}</ul>
        )}
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
