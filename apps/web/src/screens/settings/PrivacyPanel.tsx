import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DPDP_REQUEST_KINDS, PRINCIPAL_TYPES, type DpdpRequestKind, type PrincipalType } from '@worko/domain';
import { formatDate, formatDateTime } from '@worko/i18n';
import { useState } from 'react';
import { Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api, unwrap } from '../../lib/session';

type Rule = { key: string; days: number; legalHold: boolean; basis: string; purgeable: boolean };
type Inv = { inventory: Array<{ table: string; principal: string; purpose: string; retention: string; fields: Array<{ name: string; category: string }> }>; retention: Record<string, Rule> };
type Req = { id: string; kind: DpdpRequestKind; principalType: PrincipalType; principalId: string; source: string; status: string; receivedOn: string; dueOn: string; sla: string; details: string | null };
type Step = { table: string; action: 'retain' | 'anonymise'; reason: string; fields: string[] };
type Breach = { id: string; title: string; severity: string; awareAt: string; reportDueAt: string; affectedCount: number; status: string; boardNotifiedAt: string | null; principalsNotifiedAt: string | null };
type View = 'requests' | 'inventory' | 'breaches' | 'retention' | 'consents';
const err = (e: unknown) => toast({ text: (e as Error).message, tone: 'error' });

/** Settings → Privacy: DPDP record-keeping tools (no legal advice). */
export function PrivacyPanel() {
  const t = useT();
  const [view, setView] = useState<View>('requests');
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p12a.pv.title')}</h1>
      <p role="note" className="card border-due-soon p-3 text-sm">{t('p12a.pv.disclaimer')}</p>
      <Tabs<View> label={t('p12a.pv.title')} value={view} onChange={setView} tabs={[['requests', t('p12a.pv.requests')], ['inventory', t('p12a.pv.inventory')], ['breaches', t('p12a.pv.breaches')], ['retention', t('p12a.pv.retention')], ['consents', t('p12a.pv.consents')]]} />
      {view === 'requests' && <Requests />}
      {view === 'inventory' && <Inventory />}
      {view === 'breaches' && <Breaches />}
      {view === 'retention' && <Retention />}
      {view === 'consents' && <Consents />}
    </div>
  );
}

function Inventory() {
  const t = useT();
  const q = useQuery({ queryKey: ['privacy', 'inventory'], queryFn: async () => (await unwrap(api.GET('/privacy/inventory'))) as unknown as Inv });
  if (!q.data) return <p className="text-muted">{t('common.loading')}</p>;
  return (
    <table className="card w-full text-left text-sm"><thead><tr><th className="p-2">{t('p12a.pv.table')}</th><th>{t('p12a.pv.purpose')}</th><th>{t('p12a.pv.fields')}</th><th>{t('p12a.pv.rule')}</th></tr></thead>
      <tbody>{q.data.inventory.map((e) => { const r = q.data.retention[e.retention]!; return (
        <tr key={`${e.table}:${e.principal}`} className="border-t border-border align-top">
          <td className="p-2 font-mono">{e.table}</td><td>{e.purpose}</td><td>{e.fields.map((f) => `${f.name} (${f.category})`).join(', ')}</td>
          <td>{e.retention} · {t('p12a.pv.days', { n: r.days })}{r.legalHold ? ` · ${t('p12a.pv.hold')}` : ''}</td>
        </tr>); })}</tbody>
    </table>
  );
}

function Requests() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['privacy', 'requests'], queryFn: async () => (await unwrap(api.GET('/privacy/requests', { params: { query: {} } }))) as unknown as Req[] });
  const [kind, setKind] = useState<DpdpRequestKind>('access'); const [pt, setPt] = useState<PrincipalType>('client'); const [pid, setPid] = useState(''); const [details, setDetails] = useState('');
  const [plan, setPlan] = useState<Record<string, Step[]>>({}); const [links, setLinks] = useState<Record<string, string>>({});
  const refresh = () => void qc.invalidateQueries({ queryKey: ['privacy'] });
  const create = useMutation({ mutationFn: () => unwrap(api.POST('/privacy/requests', { body: { kind, principalType: pt, principalId: pid.trim(), details: details || undefined } })),
    onSuccess: () => { setPid(''); setDetails(''); refresh(); }, onError: err });
  const move = useMutation({ mutationFn: (x: { id: string; status: string }) => unwrap(api.PATCH('/privacy/requests/{id}', { params: { path: { id: x.id } }, body: { status: x.status } })), onSuccess: refresh, onError: err });
  const exp = useMutation({ mutationFn: async (id: string) => ({ id, r: (await unwrap(api.POST('/privacy/requests/{id}/export', { params: { path: { id } } }))) as unknown as { path: string; expiresAt: string } }),
    onSuccess: ({ id, r }) => { setLinks((l) => ({ ...l, [id]: t('p12a.pv.exportReady', { date: formatDateTime(r.expiresAt), url: `${location.origin}${r.path}` }) })); refresh(); }, onError: err });
  const erase = useMutation({ mutationFn: async (x: { id: string; dryRun: boolean }) => ({ ...x, r: (await unwrap(api.POST('/privacy/requests/{id}/erase', { params: { path: { id: x.id } }, body: { dryRun: x.dryRun } }))) as unknown as { steps: Step[] } }),
    onSuccess: ({ id, dryRun, r }) => { setPlan((p) => ({ ...p, [id]: r.steps })); if (!dryRun) refresh(); }, onError: err });
  const rows = q.data ?? [];
  return (
    <div className="space-y-3">
      {can('settings', 'edit') && (
        <section className="card grid gap-2 p-3 text-sm sm:grid-cols-4" aria-label={t('p12a.pv.newReq')}>
          <Field label={t('p12a.pv.kind')}><select className="input" value={kind} onChange={(e) => setKind(e.target.value as DpdpRequestKind)}>{DPDP_REQUEST_KINDS.map((k) => <option key={k} value={k}>{t(`p12a.pv.kind.${k}`)}</option>)}</select></Field>
          <Field label={t('p12a.pv.principal')}><select className="input" value={pt} onChange={(e) => setPt(e.target.value as PrincipalType)}>{PRINCIPAL_TYPES.map((k) => <option key={k} value={k}>{t(`p12a.pv.pt.${k}`)}</option>)}</select></Field>
          <Field label={t('p12a.pv.principalId')}><input className="input font-mono" value={pid} onChange={(e) => setPid(e.target.value)} placeholder="uuid" /></Field>
          <Field label={t('p12a.pv.details')}><input className="input" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={5000} /></Field>
          <button className="btn sm:col-span-4 sm:justify-self-start" disabled={!/^[0-9a-f-]{36}$/i.test(pid.trim()) || create.isPending} onClick={() => create.mutate()}>{t('p12a.pv.create')}</button>
        </section>
      )}
      {rows.length === 0 ? <p className="text-muted">{t('p12a.pv.none')}</p> : rows.map((r) => {
        const open = !['completed', 'partially_completed', 'rejected'].includes(r.status);
        return (
          <article key={r.id} className="card space-y-1 p-3 text-sm" data-testid="dpdp-request">
            <header className="flex flex-wrap items-center gap-2">
              <strong>{t(`p12a.pv.kind.${r.kind}`)}</strong><span>{t(`p12a.pv.pt.${r.principalType}`)} <span className="font-mono text-xs">{r.principalId.slice(0, 8)}</span></span>
              <span className="rounded bg-surface-alt px-1.5 py-0.5 text-xs">{t(`p12a.pv.st.${r.status as 'received'}`)}</span>
              <span className={`text-xs ${r.sla === 'overdue' ? 'text-overdue' : r.sla === 'due_soon' ? 'text-due-soon' : 'text-muted'}`}>{t(`p12a.pv.sla.${r.sla as 'on_track'}`)} · {t('p12a.pv.due', { date: formatDate(r.dueOn) })}</span>
              {r.source === 'portal' && <span className="text-xs text-muted">{t('p12a.pv.source.portal')}</span>}
            </header>
            {r.details && <p className="text-muted">{r.details}</p>}
            {open && (
              <div className="flex flex-wrap gap-2">
                {r.status === 'received' && can('settings', 'edit') && <button className="btn" onClick={() => move.mutate({ id: r.id, status: 'in_progress' })}>{t('p12a.pv.start')}</button>}
                {r.kind === 'access' && can('settings', 'export') && <button className="btn" onClick={() => exp.mutate(r.id)}>{t('p12a.pv.export')}</button>}
                {r.kind === 'erasure' && can('settings', 'approve') && <>
                  <button className="btn" onClick={() => erase.mutate({ id: r.id, dryRun: true })}>{t('p12a.pv.erasePlan')}</button>
                  {plan[r.id] && <button className="btn text-overdue" onClick={() => { if (confirm(t('p12a.pv.eraseConfirm'))) erase.mutate({ id: r.id, dryRun: false }); }}>{t('p12a.pv.erase')}</button>}
                </>}
                {r.kind !== 'erasure' && can('settings', 'edit') && <button className="btn" onClick={() => move.mutate({ id: r.id, status: 'completed' })}>{t('p12a.pv.complete')}</button>}
                {can('settings', 'edit') && <button className="btn" onClick={() => move.mutate({ id: r.id, status: 'rejected' })}>{t('p12a.pv.reject')}</button>}
              </div>
            )}
            {links[r.id] && <p className="break-all text-xs">{links[r.id]}</p>}
            {plan[r.id] && <ul className="text-xs">{plan[r.id]!.map((s, i) => <li key={i}><strong>{s.action === 'retain' ? t('p12a.pv.retain') : t('p12a.pv.anonymise')}</strong> {s.table}: {s.fields.join(', ')} <span className="text-muted">({s.reason})</span></li>)}</ul>}
          </article>
        );
      })}
    </div>
  );
}

function Breaches() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['privacy', 'breaches'], queryFn: async () => (await unwrap(api.GET('/privacy/breaches'))) as unknown as Breach[] });
  const [title, setTitle] = useState(''); const [desc, setDesc] = useState(''); const [severity, setSeverity] = useState('medium'); const [aware, setAware] = useState(''); const [affected, setAffected] = useState('0');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['privacy', 'breaches'] });
  const create = useMutation({ mutationFn: () => unwrap(api.POST('/privacy/breaches', { body: { title, description: desc || undefined, severity: severity as 'medium', awareAt: new Date(aware).toISOString(), affectedCount: Number(affected) || 0, dataCategories: [] } })),
    onSuccess: () => { setTitle(''); setDesc(''); refresh(); }, onError: err });
  const patch = useMutation({ mutationFn: (x: { id: string; body: Record<string, unknown> }) => unwrap(api.PATCH('/privacy/breaches/{id}', { params: { path: { id: x.id } }, body: x.body })), onSuccess: refresh, onError: err });
  const now = () => new Date().toISOString();
  return (
    <div className="space-y-3">
      {can('settings', 'edit') && (
        <section className="card grid gap-2 p-3 text-sm sm:grid-cols-3" aria-label={t('p12a.pv.newBreach')}>
          <Field label={t('p12a.pv.bTitle')}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
          <Field label={t('p12a.pv.severity')}><select className="input" value={severity} onChange={(e) => setSeverity(e.target.value)}>{['low', 'medium', 'high', 'critical'].map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label={t('p12a.pv.aware')}><input className="input" type="datetime-local" value={aware} onChange={(e) => setAware(e.target.value)} /></Field>
          <Field label={t('p12a.pv.affected')}><input className="input" type="number" min={0} value={affected} onChange={(e) => setAffected(e.target.value)} /></Field>
          <Field label={t('p12a.pv.bDesc')}><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <button className="btn self-end" disabled={title.trim().length < 3 || !aware || create.isPending} onClick={() => create.mutate()}>{t('p12a.pv.newBreach')}</button>
        </section>
      )}
      {(q.data ?? []).length === 0 ? <p className="text-muted">{t('p12a.pv.noBreaches')}</p> : (q.data ?? []).map((b) => (
        <article key={b.id} className="card space-y-1 p-3 text-sm">
          <header className="flex flex-wrap items-center gap-2"><strong>{b.title}</strong><span className="rounded bg-surface-alt px-1.5 py-0.5 text-xs">{b.severity} · {b.status}</span>
            <span className="text-xs text-muted">{t('p12a.pv.reportDue', { at: formatDateTime(b.reportDueAt) })} · {t('p12a.pv.affected')}: {b.affectedCount}</span></header>
          <p className="text-xs">{t('p12a.pv.boardNotified')}: {b.boardNotifiedAt ? formatDateTime(b.boardNotifiedAt) : '—'} · {t('p12a.pv.principalsNotified')}: {b.principalsNotifiedAt ? formatDateTime(b.principalsNotifiedAt) : '—'}</p>
          {can('settings', 'edit') && b.status !== 'closed' && (
            <div className="flex flex-wrap gap-2">
              {!b.boardNotifiedAt && <button className="btn" onClick={() => patch.mutate({ id: b.id, body: { boardNotifiedAt: now() } })}>{t('p12a.pv.markBoard')}</button>}
              {!b.principalsNotifiedAt && <button className="btn" onClick={() => patch.mutate({ id: b.id, body: { principalsNotifiedAt: now(), principalsNotifiedCount: b.affectedCount } })}>{t('p12a.pv.markPrincipals')}</button>}
              <button className="btn" onClick={() => patch.mutate({ id: b.id, body: { status: 'closed' } })}>{t('p12a.pv.close')}</button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function Retention() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['privacy', 'settings'], queryFn: async () => (await unwrap(api.GET('/privacy/settings'))) as unknown as { effectiveRetention: Record<string, Rule> } });
  const [days, setDays] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ dryRun: boolean; counts: Record<string, number> } | null>(null);
  const save = useMutation({ mutationFn: (x: { key: string; days: number }) => unwrap(api.PUT('/privacy/settings', { body: { retention: { [x.key]: { days: x.days } } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['privacy', 'settings'] }), onError: err });
  const purge = useMutation({ mutationFn: async (dryRun: boolean) => (await unwrap(api.POST('/privacy/purge', { body: { dryRun } }))) as unknown as { dryRun: boolean; counts: Record<string, number> },
    onSuccess: setResult, onError: err });
  if (!q.data) return <p className="text-muted">{t('common.loading')}</p>;
  return (
    <div className="space-y-3 text-sm">
      <table className="card w-full text-left"><tbody>
        {Object.values(q.data.effectiveRetention).map((r) => (
          <tr key={r.key} className="border-t border-border">
            <td className="p-2 font-mono">{r.key}</td><td>{r.basis}{r.legalHold ? ` · ${t('p12a.pv.hold')}` : ''}</td>
            <td>{can('settings', 'edit')
              ? <span className="flex items-center gap-1"><input aria-label={r.key} className="input w-24" type="number" min={1} value={days[r.key] ?? String(r.days)} onChange={(e) => setDays((d) => ({ ...d, [r.key]: e.target.value }))} />
                <button className="btn" onClick={() => save.mutate({ key: r.key, days: Number(days[r.key] ?? r.days) })}>{t('p12a.pv.saveDays')}</button></span>
              : t('p12a.pv.days', { n: r.days })}</td>
          </tr>
        ))}
      </tbody></table>
      {can('settings', 'approve') && (
        <section className="card space-y-2 p-3">
          <p className="text-muted">{t('p12a.pv.purgeHint')}</p>
          <div className="flex gap-2"><button className="btn" onClick={() => purge.mutate(true)}>{t('p12a.pv.dryRun')}</button>
            <button className="btn text-overdue" disabled={!result?.dryRun} onClick={() => purge.mutate(false)}>{t('p12a.pv.runPurge')}</button></div>
          {result && <ul>{Object.entries(result.counts).map(([k, n]) => <li key={k}>{result.dryRun ? t('p12a.pv.wouldPurge', { key: k, n }) : `${k}: ${t('p12a.pv.purged', { n })}`}</li>)}</ul>}
        </section>
      )}
    </div>
  );
}

function Consents() {
  const t = useT();
  const q = useQuery({ queryKey: ['privacy', 'consents'], queryFn: async () => (await unwrap(api.GET('/privacy/consents', { params: { query: {} } }))) as unknown as Array<{ id: string; channel: string; addressMasked: string; clientName: string | null; status: string; optedInSource: string | null; updatedAt: string }> });
  return (
    <table className="card w-full text-left text-sm"><thead><tr><th className="p-2">{t('p12a.pv.masked')}</th><th>{t('p12a.pv.consentStatus')}</th><th>{t('p12a.pv.source')}</th></tr></thead>
      <tbody>{(q.data ?? []).map((c) => (
        <tr key={c.id} className="border-t border-border"><td className="p-2">{c.channel} · {c.addressMasked} {c.clientName && <span className="text-muted">({c.clientName})</span>}</td><td>{c.status}</td><td>{c.optedInSource ?? '—'} · {formatDate(c.updatedAt)}</td></tr>
      ))}</tbody>
    </table>
  );
}
