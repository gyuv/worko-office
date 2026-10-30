import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR, type PortalGrants } from '@worko/domain';
import { formatDate, formatDateTime, type MessageKey } from '@worko/i18n';
import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { absoluteUrl, openBlob } from '../lib/http';
import { I18nProvider, useT } from '../lib/i18n';
import { type PortalHttpError, portalBlob, portalJson, portalUpload, publicJson, usePortalSession } from './http';
import {
  accentColor, canVerify, codeExpired, esignHref, fmtBytes, otpInitial, otpReducer, portalHref, secondsUntil, validIdentifier, viewAllowed,
  PORTAL_VIEWS, type PortalLoc, type PortalView,
} from './logic';

// ---------- Response shapes (mirror apps/api/src/portal/*) ----------
export type Branding = { firm: string; displayName: string; accent: string; logoUrl: string | null; supportEmail: string | null; supportPhone: string | null; welcomeText: string | null };
type Me = { user: { id: string; name: string; email: string | null; phone: string | null }; clients: Array<{ id: string; name: string; grants: PortalGrants }>; branding: Branding };
type Req = { kind: 'pbc' | 'task'; id: string; title: string; description?: string | null; issue?: string | null; dueDate: string | null; status?: string; rejectionReason?: string | null; periodLabel?: string | null };
type Dashboard = { client: { id: string; name: string }; pendingRequests?: Req[]; outstanding?: { totalPaise: number; invoices: Array<{ id: string; number: string; dueDate: string | null; balancePaise: number }> };
  recentDocuments?: Array<{ id: string; name: string; category: string; fy: string | null; createdAt: string }>; upcomingDueDates?: Array<{ title: string; periodLabel: string | null; dueDate: string }>; pendingSignatures?: number };
type PDoc = { id: string; name: string; category: string; fy: string | null; mime: string; size: number; createdAt: string; fromClient: boolean };
type InvRow = { id: string; kind: string; number: string; status: string; issueDate: string; dueDate: string | null; totalPaise: number; balancePaise: number };
type Invoice = InvRow & { placeOfSupply: string | null; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; payable: boolean; paymentUrl: string | null;
  lines: Array<{ description: string; sac: string | null; qty: number; ratePaise: number; taxPaise: number; totalPaise: number }> };
type Receipt = { id: string; number: string; receivedOn: string; amountPaise: number; tdsPaise: number; mode: string; allocations: Array<{ invoiceNumber: string; amountPaise: number }> };
type Msg = { id: string; direction: 'in' | 'out'; body: string; at: string; from: string };
type Sign = { id: string; title: string; document: string; status: string; signUrl: string };
type Notice = { id: string; authority: string; section: string | null; referenceNo: string | null; title: string; issueDate: string | null; responseDue: string | null; status: string; demandPaise: number };
type Profile = { user: Me['user']; contacts: Array<{ clientId: string; clientName: string; contactId: string | null; name: string | null; email: string | null; phone: string | null; whatsapp: string | null; role: string | null }>;
  consent: Array<{ channel: string; address: string; status: string }>; requests: Array<{ id: string; clientId: string; fields: string[]; status: string; createdAt: string }> };

const isDark = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
const goTo = (href: string) => { if (location.hash !== href) location.hash = href.slice(1); };

/** Entry for `#/portal/{firm}/…` — no staff session involved. */
export function PortalRoot({ loc }: { loc: PortalLoc }) {
  const qc = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }), []);
  return <I18nProvider><QueryClientProvider client={qc}><Portal loc={loc} /></QueryClientProvider></I18nProvider>;
}

function Portal({ loc }: { loc: PortalLoc }) {
  const t = useT();
  const { open, tokens, firm } = usePortalSession();
  useEffect(() => { open(loc.firm); }, [open, loc.firm]);
  const brand = useQuery({ queryKey: ['portal', 'branding', loc.firm], retry: false, queryFn: () => publicJson<Branding>(`/portal/branding/${encodeURIComponent(loc.firm)}`) });
  const style = { '--w-primary': accentColor(brand.data?.accent, isDark()) } as CSSProperties;
  if (firm !== loc.firm) return null;
  return (
    <div style={style} className="min-h-screen bg-bg text-fg">
      {brand.isError ? <main className="mx-auto max-w-md p-4"><p role="alert" className="card p-4">{t('p9.portal.notFound')}</p></main>
        : !brand.data ? <p className="p-4 text-muted" aria-live="polite">{t('common.loading')}</p>
        : tokens ? <PortalShell loc={loc} brand={brand.data} /> : <PortalLogin firm={loc.firm} brand={brand.data} />}
    </div>
  );
}

function BrandHeader({ brand }: { brand: Branding }) {
  return (
    <div className="flex items-center gap-2">
      {brand.logoUrl && <img src={absoluteUrl(brand.logoUrl)} alt="" className="h-8 w-auto max-w-[8rem] object-contain" />}
      <span className="text-lg font-semibold">{brand.displayName}</span>
    </div>
  );
}

// ---------- Sign-in ----------
export function PortalLogin({ firm, brand }: { firm: string; brand: Branding }) {
  const t = useT();
  const setTokens = usePortalSession((s) => s.setTokens);
  const [s, d] = useReducer(otpReducer, otpInitial);
  const [now, setNow] = useState(() => Date.now());
  const ticking = s.step === 'code' || s.retryAt !== null;
  useEffect(() => { if (!ticking) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [ticking]);
  const left = secondsUntil(s.resendAt, now);
  const wait = secondsUntil(s.retryAt, now);
  const expired = codeExpired(s, now);
  const retryAfter = (e: unknown) => Number((e as PortalHttpError).headers?.get('retry-after') ?? '') || null;

  const request = async () => {
    if (!validIdentifier(s.identifier)) { d({ type: 'invalid_identifier' }); return; }
    d({ type: 'submit' });
    try { await publicJson('/portal/auth/otp/request', { method: 'POST', body: { firm, identifier: s.identifier.trim() } }); const n = Date.now(); d({ type: 'sent', now: n }); setNow(n); }
    catch (e) { const n = Date.now(); d({ type: 'failed', phase: 'request', status: (e as PortalHttpError).status ?? 0, now: n, retryAfter: retryAfter(e) }); setNow(n); }
  };
  const verify = async () => {
    d({ type: 'submit' });
    try {
      const tk = await publicJson<Parameters<typeof setTokens>[0]>('/portal/auth/otp/verify', { method: 'POST', body: { firm, identifier: s.identifier.trim(), code: s.code, device: { platform: 'web', label: navigator.userAgent.slice(0, 100) } } });
      d({ type: 'verified' }); setTokens(tk);
    } catch (e) { const n = Date.now(); d({ type: 'failed', phase: 'verify', status: (e as PortalHttpError).status ?? 0, now: n, retryAfter: retryAfter(e) }); setNow(n); }
  };
  const err = s.error === 'throttled'
    ? (wait > 0 ? <p role="alert" className="text-sm text-overdue">{t('p9.otp.err.throttled', { n: wait })}</p> : null)
    : s.error && <p role="alert" className="text-sm text-overdue">{t(`p9.otp.err.${s.error}` as MessageKey)}</p>;
  return (
    <main className="mx-auto max-w-sm space-y-4 p-4 pt-[10vh]">
      <BrandHeader brand={brand} />
      {brand.welcomeText && <p className="text-sm text-muted">{brand.welcomeText}</p>}
      {s.step === 'identify' ? (
        <form className="card space-y-3 p-4" aria-label={t('p9.otp.title')} onSubmit={(e) => { e.preventDefault(); if (!wait) void request(); }}>
          <h1 className="text-xl font-semibold">{t('p9.otp.title')}</h1>
          <label className="block"><span className="label">{t('p9.otp.identifier')}</span>
            <input className="input" value={s.identifier} onChange={(e) => d({ type: 'identifier', value: e.target.value })} autoComplete="username" inputMode="email" required aria-invalid={s.error === 'invalid_identifier'} /></label>
          <p className="text-xs text-muted">{t('p9.otp.identifierHint')}</p>
          {err}
          <button className="btn btn-primary w-full" disabled={s.busy || !s.identifier.trim() || wait > 0}>{t('p9.otp.send')}</button>
        </form>
      ) : (
        <form className="card space-y-3 p-4" aria-label={t('p9.otp.enterCode')} onSubmit={(e) => { e.preventDefault(); if (canVerify(s, now)) void verify(); }}>
          <h1 className="text-xl font-semibold">{t('p9.otp.enterCode')}</h1>
          <p role="status" className="text-sm">{t('p9.otp.sentNeutral', { id: s.identifier.trim() })}</p>
          <label className="block"><span className="label">{t('p9.otp.code')}</span>
            <input className="input text-center font-mono text-lg tracking-[0.4em]" value={s.code} onChange={(e) => d({ type: 'code', value: e.target.value })} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required /></label>
          {expired && s.error !== 'new_code_needed' ? <p role="alert" className="text-sm text-overdue">{t('p9.otp.err.expired')}</p> : err}
          <button className="btn btn-primary w-full" disabled={!canVerify(s, now)}>{t('p9.otp.verify')}</button>
          <div className="flex items-center justify-between text-sm">
            <button type="button" className="underline" onClick={() => d({ type: 'back' })}>{t('p9.otp.change')}</button>
            {left > 0 || wait > 0 ? <span className="text-muted" aria-live="polite">{t('p9.otp.resendIn', { n: Math.max(left, wait) })}</span>
              : <button type="button" className="underline" disabled={s.busy} onClick={() => void request()}>{t('p9.otp.resend')}</button>}
          </div>
        </form>
      )}
      <p className="text-center text-xs text-muted">{t('p9.otp.privacy')}</p>
    </main>
  );
}

// ---------- Shell ----------
const NAV_LABEL: Record<PortalView, MessageKey> = {
  dashboard: 'p9.pnav.dashboard', documents: 'p9.pnav.documents', requests: 'p9.pnav.requests', invoices: 'p9.pnav.invoices', receipts: 'p9.pnav.receipts',
  messages: 'p9.pnav.messages', esign: 'p9.pnav.esign', notices: 'p9.pnav.notices', profile: 'p9.pnav.profile',
};

function PortalShell({ loc, brand }: { loc: PortalLoc; brand: Branding }) {
  const t = useT();
  const qc = useQueryClient();
  const setTokens = usePortalSession((s) => s.setTokens);
  const me = useQuery({ queryKey: ['portal', 'me'], queryFn: () => portalJson<Me>('/portal/me') });
  const signOut = async () => { await portalJson('/portal/auth/logout', { method: 'POST' }).catch(() => undefined); setTokens(null); qc.clear(); };
  if (me.isError) return <main className="mx-auto max-w-md p-4"><p role="alert" className="card p-4">{t('common.error')}</p></main>;
  if (!me.data) return <p className="p-4 text-muted" aria-live="polite">{t('common.loading')}</p>;
  const clients = me.data.clients;
  const client = clients.find((c) => c.id === loc.clientId) ?? clients[0];
  const header = (
    <header className="sticky top-0 z-10 border-b border-border bg-surface">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2 px-4 py-2">
        <BrandHeader brand={me.data.branding ?? brand} />
        <span className="flex-1" />
        {clients.length > 1 && client && (
          <label className="flex items-center gap-1 text-sm"><span className="sr-only">{t('p9.portal.client')}</span>
            <select className="input w-auto max-w-[12rem]" aria-label={t('p9.portal.client')} value={client.id} onChange={(e) => goTo(portalHref(loc.firm, loc.view === 'profile' ? 'profile' : 'dashboard', { clientId: e.target.value }))}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
        )}
        <button className="btn" onClick={() => void signOut()}>{t('common.signOut')}</button>
      </div>
    </header>
  );
  if (!client) return <>{header}<main className="mx-auto max-w-4xl p-4"><p className="card p-4">{t('p9.portal.noClients')}</p></main></>;
  const views = PORTAL_VIEWS.filter((v) => viewAllowed(v, client.grants));
  const view = views.includes(loc.view) ? loc.view : 'dashboard';
  const href = (v: PortalView, id?: string) => portalHref(loc.firm, v, { clientId: client.id, ...(id ? { id } : {}) });
  const ctx = { firm: loc.firm, clientId: client.id, grants: client.grants, href };
  return (
    <>
      {header}
      <nav aria-label={t('p9.portal.nav')} className="border-b border-border bg-surface">
        <ul className="mx-auto flex max-w-4xl gap-1 overflow-x-auto px-2 py-1">
          {views.map((v) => <li key={v}><a href={href(v)} aria-current={v === view ? 'page' : undefined}
            className={`block whitespace-nowrap rounded px-3 py-2 text-sm ${v === view ? 'bg-primary text-primary-fg' : 'hover:bg-surface-alt'}`}>{t(NAV_LABEL[v])}</a></li>)}
        </ul>
      </nav>
      <main className="mx-auto max-w-4xl space-y-3 p-4" key={client.id}>
        {view === 'dashboard' && <DashboardView {...ctx} />}
        {view === 'documents' && <DocumentsView {...ctx} />}
        {view === 'requests' && <RequestsView {...ctx} />}
        {view === 'invoices' && (loc.id ? <InvoiceDetail {...ctx} id={loc.id} /> : <InvoicesView {...ctx} />)}
        {view === 'receipts' && <ReceiptsView {...ctx} />}
        {view === 'messages' && <MessagesView {...ctx} />}
        {view === 'esign' && <EsignView {...ctx} />}
        {view === 'notices' && <NoticesView {...ctx} />}
        {view === 'profile' && <ProfileView {...ctx} />}
        {(me.data.branding?.supportEmail || me.data.branding?.supportPhone) && (
          <footer className="pt-6 text-center text-xs text-muted">{t('p9.portal.support')} {me.data.branding.supportEmail} {me.data.branding.supportPhone}</footer>
        )}
      </main>
    </>
  );
}

type Ctx = { firm: string; clientId: string; grants: PortalGrants; href(v: PortalView, id?: string): string };
const base = (c: Ctx) => `/portal/clients/${c.clientId}`;
const Money = ({ p }: { p: number }) => <span className="tabular-nums">{formatINR(p)}</span>;
const Section = ({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) => (
  <section className="card space-y-2 p-4" aria-label={title}><div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{title}</h2>{action}</div>{children}</section>
);
function useList<T>(c: Ctx, path: string, extra: Record<string, unknown> = {}) {
  return useQuery({ queryKey: ['portal', c.clientId, path], queryFn: () => portalJson<T>(`${base(c)}${path}`), ...extra });
}
const Loading = () => { const t = useT(); return <p className="text-muted" aria-live="polite">{t('common.loading')}</p>; };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- Dashboard ----------
function DashboardView(c: Ctx) {
  const t = useT();
  const q = useList<Dashboard>(c, '/dashboard');
  if (!q.data) return q.isError ? <p role="alert">{t('common.error')}</p> : <Loading />;
  const d = q.data;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <h1 className="text-xl font-semibold sm:col-span-2">{d.client.name}</h1>
      {d.pendingRequests && <Section title={t('p9.dash.requests', { n: d.pendingRequests.length })} action={<a className="text-sm underline" href={c.href('requests')}>{t('p9.viewAll')}</a>}>
        {d.pendingRequests.length ? <ul className="space-y-1 text-sm">{d.pendingRequests.slice(0, 5).map((r) => <li key={r.id}>{r.title}{r.dueDate && <span className="text-muted"> · {formatDate(r.dueDate)}</span>}</li>)}</ul>
          : <p className="text-sm text-muted">{t('p9.dash.noRequests')}</p>}
      </Section>}
      {d.outstanding && <Section title={t('p9.dash.outstanding')} action={<a className="text-sm underline" href={c.href('invoices')}>{t('p9.viewAll')}</a>}>
        <p className="text-2xl font-semibold" data-testid="outstanding"><Money p={d.outstanding.totalPaise} /></p>
        <ul className="space-y-1 text-sm">{d.outstanding.invoices.slice(0, 5).map((i) => <li key={i.id}><a className="underline" href={c.href('invoices', i.id)}>{i.number}</a> · <Money p={i.balancePaise} />{i.dueDate && <span className="text-muted"> · {t('p9.due', { d: formatDate(i.dueDate) })}</span>}</li>)}</ul>
      </Section>}
      {d.recentDocuments && <Section title={t('p9.dash.recentDocs')} action={<a className="text-sm underline" href={c.href('documents')}>{t('p9.viewAll')}</a>}>
        {d.recentDocuments.length ? <ul className="space-y-1 text-sm">{d.recentDocuments.map((x) => <li key={x.id}>{x.name} <span className="text-muted">· {x.category}{x.fy ? ` · ${x.fy}` : ''}</span></li>)}</ul>
          : <p className="text-sm text-muted">{t('p9.docs.empty')}</p>}
      </Section>}
      {d.upcomingDueDates && <Section title={t('p9.dash.due')}>
        <ul className="space-y-1 text-sm">{d.upcomingDueDates.map((x, i) => <li key={i}>{x.title}{x.periodLabel ? ` (${x.periodLabel})` : ''} · {formatDate(x.dueDate)}</li>)}</ul>
      </Section>}
      {d.pendingSignatures !== undefined && d.pendingSignatures > 0 && <Section title={t('p9.dash.sign', { n: d.pendingSignatures })} action={<a className="text-sm underline" href={c.href('esign')}>{t('p9.viewAll')}</a>}><span /></Section>}
    </div>
  );
}

// ---------- Documents ----------
function DocumentsView(c: Ctx) {
  const t = useT();
  const qc = useQueryClient();
  const [fy, setFy] = useState('');
  const q = useQuery({ queryKey: ['portal', c.clientId, '/documents', fy], queryFn: () => portalJson<PDoc[]>(`${base(c)}/documents${fy ? `?fy=${encodeURIComponent(fy)}` : ''}`) });
  const [err, setErr] = useState<string | null>(null);
  const download = async (id: string) => {
    setErr(null);
    try { const r = await portalJson<{ url: string }>(`${base(c)}/documents/${id}/download-url`, { method: 'POST' }); window.open(absoluteUrl(r.url), '_blank', 'noopener'); }
    catch (e) { setErr(errText(e)); }
  };
  const docs = q.data ?? [];
  const fys = [...new Set(docs.map((d) => d.fy).filter((x): x is string => !!x))].sort().reverse();
  const shared = docs.filter((d) => !d.fromClient); const mine = docs.filter((d) => d.fromClient);
  const table = (rows: PDoc[]) => rows.length ? (
    <ul className="divide-y divide-border">{rows.map((d) => (
      <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
        <div className="min-w-0 flex-1"><div className="truncate font-medium">{d.name}</div><div className="text-xs text-muted">{d.category}{d.fy ? ` · ${d.fy}` : ''} · {fmtBytes(d.size)} · {formatDate(d.createdAt)}</div></div>
        <button className="btn" onClick={() => void download(d.id)} aria-label={t('p9.docs.download', { name: d.name })}>{t('p9.docs.downloadShort')}</button>
      </li>))}</ul>) : <p className="text-sm text-muted">{t('p9.docs.empty')}</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><h1 className="flex-1 text-xl font-semibold">{t('p9.pnav.documents')}</h1>
        <select className="input w-auto" aria-label={t('p9.docs.fy')} value={fy} onChange={(e) => setFy(e.target.value)}><option value="">{t('p9.docs.allFy')}</option>{fys.map((x) => <option key={x}>{x}</option>)}</select></div>
      <UploadBox c={c} onDone={() => void qc.invalidateQueries({ queryKey: ['portal', c.clientId] })} />
      {err && <p role="alert" className="text-sm text-overdue">{err}</p>}
      {!q.data ? <Loading /> : <>
        <Section title={t('p9.docs.shared')}>{table(shared)}</Section>
        <Section title={t('p9.docs.fromClient')}>{table(mine)}</Section>
      </>}
    </div>
  );
}

export function UploadBox({ c, onDone }: { c: Ctx; onDone(): void }) {
  const t = useT();
  const file = useRef<HTMLInputElement>(null);
  const [f, setF] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [pct, setPct] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const go = async () => {
    if (!f) return;
    const fd = new FormData(); fd.append('file', f); if (note.trim()) fd.append('note', note.trim());
    setPct(0); setMsg(null);
    try { await portalUpload(`${base(c)}/documents`, fd, setPct); setMsg({ ok: true, text: t('p9.up.done', { name: f.name }) }); setF(null); setNote(''); if (file.current) file.current.value = ''; onDone(); }
    catch (e) { setMsg({ ok: false, text: t('p9.up.failed', { reason: errText(e) }) }); }
    finally { setPct(null); }
  };
  return (
    <form className="card space-y-2 p-4" aria-label={t('p9.up.title')} onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <h2 className="font-semibold">{t('p9.up.title')}</h2>
      <p className="text-xs text-muted">{t('p9.up.hint')}</p>
      <label className="block"><span className="label">{t('p9.up.file')}</span><input ref={file} type="file" className="block w-full text-sm" onChange={(e) => setF(e.target.files?.[0] ?? null)} /></label>
      <label className="block"><span className="label">{t('p9.up.note')}</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
      {pct !== null && <progress className="w-full" max={100} value={pct} aria-label={t('p9.up.progress')}>{pct}%</progress>}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-done' : 'text-overdue'}`}>{msg.text}</p>}
      <button className="btn btn-primary" disabled={!f || pct !== null}>{t('p9.up.send')}</button>
    </form>
  );
}

// ---------- Requests ----------
function RequestsView(c: Ctx) {
  const t = useT();
  const q = useList<Req[]>(c, '/requests');
  if (!q.data) return <Loading />;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p9.pnav.requests')}</h1>
      {!q.data.length && <p className="card p-4 text-muted">{t('p9.dash.noRequests')}</p>}
      {q.data.map((r) => <RequestCard key={`${r.kind}:${r.id}`} c={c} r={r} />)}
    </div>
  );
}

function RequestCard({ c, r }: { c: Ctx; r: Req }) {
  const t = useT();
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [f, setF] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    const fd = new FormData(); if (message.trim()) fd.append('message', message.trim()); if (f) fd.append('file', f);
    setPct(0); setErr(null);
    try { await portalUpload(`${base(c)}/requests/${r.kind}/${r.id}/respond`, fd, setPct); void qc.invalidateQueries({ queryKey: ['portal', c.clientId] }); }
    catch (e) { setErr(errText(e)); } finally { setPct(null); }
  };
  return (
    <form className="card space-y-2 p-4" aria-label={r.title} onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <div className="flex flex-wrap items-baseline gap-2"><h2 className="flex-1 font-semibold">{r.title}</h2>
        <span className="rounded bg-surface-alt px-1.5 py-0.5 text-xs">{t(r.kind === 'pbc' ? 'p9.req.pbc' : 'p9.req.query')}</span>
        {r.dueDate && <span className="text-xs text-muted">{t('p9.due', { d: formatDate(r.dueDate) })}</span>}</div>
      {(r.description || r.issue) && <p className="whitespace-pre-wrap text-sm">{r.description ?? r.issue}</p>}
      {r.rejectionReason && <p className="text-sm text-due-soon">{t('p9.req.rejected', { reason: r.rejectionReason })}</p>}
      <label className="block"><span className="label">{t('p9.req.reply')}</span><textarea className="input" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} /></label>
      <label className="block"><span className="label">{t('p9.req.attach')}</span><input type="file" className="block w-full text-sm" onChange={(e) => setF(e.target.files?.[0] ?? null)} /></label>
      {pct !== null && <progress className="w-full" max={100} value={pct} aria-label={t('p9.up.progress')} />}
      {err && <p role="alert" className="text-sm text-overdue">{err}</p>}
      <button className="btn btn-primary" disabled={(!message.trim() && !f) || pct !== null}>{t('p9.req.send')}</button>
    </form>
  );
}

// ---------- Invoices / receipts ----------
const INV_STATUS: Record<string, MessageKey> = { issued: 'p9.inv.issued', partially_paid: 'p9.inv.partial', paid: 'p9.inv.paid' };
function InvoicesView(c: Ctx) {
  const t = useT();
  const q = useList<InvRow[]>(c, '/invoices');
  if (!q.data) return <Loading />;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p9.pnav.invoices')}</h1>
      {!q.data.length ? <p className="card p-4 text-muted">{t('p9.inv.empty')}</p> : (
        <ul className="card divide-y divide-border">{q.data.map((i) => (
          <li key={i.id}><a href={c.href('invoices', i.id)} className="flex flex-wrap items-center gap-2 p-3 hover:bg-surface-alt">
            <span className="flex-1 font-medium">{i.number}<span className="block text-xs font-normal text-muted">{formatDate(i.issueDate)}{i.dueDate ? ` · ${t('p9.due', { d: formatDate(i.dueDate) })}` : ''}</span></span>
            <span className="text-sm">{t(INV_STATUS[i.status] ?? 'p9.inv.issued')}</span>
            <span className="text-right"><Money p={i.totalPaise} />{i.balancePaise > 0 && <span className="block text-xs text-due-soon">{t('p9.inv.balance')} <Money p={i.balancePaise} /></span>}</span>
          </a></li>))}</ul>
      )}
    </div>
  );
}

function InvoiceDetail({ id, ...c }: Ctx & { id: string }) {
  const t = useT();
  const q = useList<Invoice>(c, `/invoices/${id}`, { retry: false });
  const [err, setErr] = useState<string | null>(null);
  const pay = useMutation({
    mutationFn: () => portalJson<{ url: string; amountPaise: number; provider?: string }>(`${base(c)}/invoices/${id}/pay`, { method: 'POST' }),
    onSuccess: (r) => { window.location.assign(r.url); }, onError: (e) => setErr(errText(e)),
  });
  if (q.isError) return <p role="alert" className="card p-4">{t('p9.notFound')}</p>;
  if (!q.data) return <Loading />;
  const i = q.data;
  return (
    <div className="space-y-3">
      <a className="text-sm underline" href={c.href('invoices')}>← {t('p9.pnav.invoices')}</a>
      <section className="card space-y-3 p-4" aria-label={i.number}>
        <div className="flex flex-wrap items-baseline gap-2"><h1 className="flex-1 text-xl font-semibold">{i.number}</h1><span>{t(INV_STATUS[i.status] ?? 'p9.inv.issued')}</span></div>
        <p className="text-sm text-muted">{formatDate(i.issueDate)}{i.dueDate ? ` · ${t('p9.due', { d: formatDate(i.dueDate) })}` : ''}</p>
        <div className="overflow-x-auto"><table className="table w-full text-sm">
          <thead><tr><th>{t('p9.inv.item')}</th><th className="text-right">{t('p9.inv.qty')}</th><th className="text-right">{t('p9.inv.amount')}</th></tr></thead>
          <tbody>{i.lines.map((l, k) => <tr key={k}><td>{l.description}{l.sac ? <span className="text-xs text-muted"> · SAC {l.sac}</span> : null}</td><td className="text-right">{l.qty}</td><td className="text-right"><Money p={l.totalPaise} /></td></tr>)}</tbody>
        </table></div>
        <dl className="ml-auto grid max-w-xs grid-cols-2 gap-x-4 text-sm">
          <dt>{t('p9.inv.taxable')}</dt><dd className="text-right"><Money p={i.taxablePaise} /></dd>
          {i.igstPaise > 0 ? <><dt>IGST</dt><dd className="text-right"><Money p={i.igstPaise} /></dd></> : <><dt>CGST</dt><dd className="text-right"><Money p={i.cgstPaise} /></dd><dt>SGST</dt><dd className="text-right"><Money p={i.sgstPaise} /></dd></>}
          <dt className="font-semibold">{t('p9.inv.total')}</dt><dd className="text-right font-semibold"><Money p={i.totalPaise} /></dd>
          <dt>{t('p9.inv.balance')}</dt><dd className="text-right"><Money p={i.balancePaise} /></dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={() => void portalBlob(`${base(c)}/invoices/${id}/pdf`).then(openBlob).catch((e) => setErr(errText(e)))}>{t('p9.inv.pdf')}</button>
          {i.payable && <button className="btn btn-primary" disabled={pay.isPending} onClick={() => pay.mutate()}>{t('p9.inv.pay', { amount: formatINR(i.balancePaise) })}</button>}
        </div>
        {i.payable && <p className="text-xs text-muted">{t('p9.inv.payNote')}</p>}
        {err && <p role="alert" className="text-sm text-overdue">{err}</p>}
      </section>
    </div>
  );
}

function ReceiptsView(c: Ctx) {
  const t = useT();
  const q = useList<Receipt[]>(c, '/receipts');
  if (!q.data) return <Loading />;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p9.pnav.receipts')}</h1>
      {!q.data.length ? <p className="card p-4 text-muted">{t('p9.rcpt.empty')}</p> : <ul className="card divide-y divide-border">{q.data.map((r) => (
        <li key={r.id} className="flex flex-wrap gap-2 p-3"><span className="flex-1"><span className="font-medium">{r.number}</span><span className="block text-xs text-muted">{formatDate(r.receivedOn)} · {r.mode}{r.allocations.length ? ` · ${r.allocations.map((a) => a.invoiceNumber).join(', ')}` : ''}</span></span>
          <span className="text-right"><Money p={r.amountPaise} />{r.tdsPaise > 0 && <span className="block text-xs text-muted">TDS <Money p={r.tdsPaise} /></span>}</span></li>))}</ul>}
    </div>
  );
}

// ---------- Messages (no realtime for portal sessions → polling while open) ----------
export const MESSAGE_POLL_MS = 15_000;
function MessagesView(c: Ctx) {
  const t = useT();
  const qc = useQueryClient();
  const q = useList<Msg[]>(c, '/messages', { refetchInterval: MESSAGE_POLL_MS });
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => portalJson(`${base(c)}/messages`, { method: 'POST', body: { body: text.trim() } }),
    onSuccess: () => { setText(''); void qc.invalidateQueries({ queryKey: ['portal', c.clientId, '/messages'] }); },
  });
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [q.data?.length]);
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p9.pnav.messages')}</h1>
      <ul className="card max-h-[60vh] space-y-2 overflow-auto p-3" aria-live="polite" aria-label={t('p9.msg.thread')}>
        {!q.data ? <li><Loading /></li> : !q.data.length ? <li className="text-sm text-muted">{t('p9.msg.empty')}</li>
          : q.data.map((m) => <li key={m.id} className={`max-w-[85%] rounded p-2 text-sm ${m.direction === 'in' ? 'ml-auto bg-primary text-primary-fg' : 'bg-surface-alt'}`}>
            <div className="whitespace-pre-wrap">{m.body}</div><div className="mt-0.5 text-xs opacity-75">{m.from} · {formatDateTime(m.at)}</div></li>)}
        <li ref={end} aria-hidden />
      </ul>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate(); }}>
        <label className="flex-1"><span className="sr-only">{t('p9.msg.compose')}</span><textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} placeholder={t('p9.msg.compose')} /></label>
        <button className="btn btn-primary self-end" disabled={!text.trim() || send.isPending}>{t('p9.msg.send')}</button>
      </form>
      {send.isError && <p role="alert" className="text-sm text-overdue">{errText(send.error)}</p>}
    </div>
  );
}

function EsignView(c: Ctx) {
  const t = useT();
  const q = useList<Sign[]>(c, '/esign');
  if (!q.data) return <Loading />;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p9.pnav.esign')}</h1>
      {!q.data.length ? <p className="card p-4 text-muted">{t('p9.sign.empty')}</p> : <ul className="card divide-y divide-border">{q.data.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-2 p-3"><span className="flex-1"><span className="font-medium">{s.document}</span><span className="block text-xs text-muted">{s.title}</span></span>
          <a className="btn btn-primary" href={esignHref(s.signUrl)}>{t('p9.sign.open')}</a></li>))}</ul>}
    </div>
  );
}

function NoticesView(c: Ctx) {
  const t = useT();
  const q = useList<Notice[]>(c, '/notices');
  if (!q.data) return <Loading />;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p9.pnav.notices')}</h1>
      {!q.data.length ? <p className="card p-4 text-muted">{t('p9.notice.empty')}</p> : <ul className="card divide-y divide-border">{q.data.map((n) => (
        <li key={n.id} className="p-3"><div className="font-medium">{n.title}</div><div className="text-xs text-muted">{[n.section, n.referenceNo, n.issueDate && formatDate(n.issueDate)].filter(Boolean).join(' · ')}</div>
          {n.responseDue && <div className="text-sm">{t('p9.notice.respondBy', { d: formatDate(n.responseDue) })}</div>}{n.demandPaise > 0 && <div className="text-sm">{t('p9.notice.demand')} <Money p={n.demandPaise} /></div>}</li>))}</ul>}
    </div>
  );
}

// ---------- Profile & consent ----------
const FIELDS = ['name', 'email', 'phone', 'whatsapp', 'role'] as const;
const CHANNELS = ['email', 'whatsapp', 'sms'] as const;
function ProfileView(c: Ctx) {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['portal', 'profile'], queryFn: () => portalJson<Profile>('/portal/profile') });
  const contact = q.data?.contacts.find((x) => x.clientId === c.clientId);
  const [changes, setChanges] = useState<Partial<Record<(typeof FIELDS)[number], string>>>({});
  const req = useMutation({
    mutationFn: () => portalJson('/portal/profile/requests', { method: 'POST', body: { clientId: c.clientId, changes: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v?.trim() || null])) } }),
    onSuccess: () => { setChanges({}); void qc.invalidateQueries({ queryKey: ['portal', 'profile'] }); },
  });
  const consent = useMutation({
    mutationFn: (b: { channel: string; status: 'opted_in' | 'opted_out' }) => portalJson('/portal/consent', { method: 'PUT', body: { clientId: c.clientId, ...b } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['portal', 'profile'] }),
  });
  if (!q.data) return <Loading />;
  const statusOf = (ch: string) => q.data.consent.find((x) => x.channel === ch)?.status ?? 'unknown';
  const dirty = Object.values(changes).some((v) => v !== undefined);
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p9.pnav.profile')}</h1>
      <Section title={t('p9.prof.details')}>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (dirty) req.mutate(); }}>
          {FIELDS.map((f) => (
            <label key={f} className="block"><span className="label">{t(`p9.prof.f.${f}` as MessageKey)}</span>
              <input className="input" value={changes[f] ?? contact?.[f] ?? ''} onChange={(e) => setChanges((s) => ({ ...s, [f]: e.target.value }))} /></label>
          ))}
          <p className="text-xs text-muted">{t('p9.prof.hint')}</p>
          {req.isSuccess && <p role="status" className="text-sm text-done">{t('p9.prof.requested')}</p>}
          {req.isError && <p role="alert" className="text-sm text-overdue">{errText(req.error)}</p>}
          <button className="btn btn-primary" disabled={!dirty || req.isPending}>{t('p9.prof.request')}</button>
        </form>
      </Section>
      <Section title={t('p9.prof.requests')}>
        {!q.data.requests.length ? <p className="text-sm text-muted">{t('p9.prof.noRequests')}</p> : <ul className="space-y-1 text-sm">{q.data.requests.map((r) => (
          <li key={r.id}>{formatDate(r.createdAt)} · {r.fields.join(', ')} · <strong>{t(`p9.prof.st.${r.status}` as MessageKey)}</strong></li>))}</ul>}
      </Section>
      <Section title={t('p9.consent.title')}>
        <p className="text-xs text-muted">{t('p9.consent.hint')}</p>
        <ul className="space-y-2">{CHANNELS.map((ch) => {
          const st = statusOf(ch);
          return (
            <li key={ch} className="flex flex-wrap items-center gap-2"><span className="w-24 font-medium">{t(`p9.ch.${ch}` as MessageKey)}</span>
              <span className="flex-1 text-sm text-muted">{t(`p9.consent.${st === 'opted_in' ? 'in' : st === 'opted_out' ? 'out' : 'unknown'}` as MessageKey)}</span>
              <button className="btn" aria-pressed={st === 'opted_in'} disabled={consent.isPending} onClick={() => consent.mutate({ channel: ch, status: 'opted_in' })}>{t('p9.consent.optIn')}</button>
              <button className="btn" aria-pressed={st === 'opted_out'} disabled={consent.isPending} onClick={() => consent.mutate({ channel: ch, status: 'opted_out' })}>{t('p9.consent.optOut')}</button>
            </li>
          );
        })}</ul>
      </Section>
    </div>
  );
}
