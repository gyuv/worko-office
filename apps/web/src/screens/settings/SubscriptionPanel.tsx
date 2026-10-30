import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@worko/domain';
import { formatDate, formatDateTime } from '@worko/i18n';
import { useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { api, unwrap } from '../../lib/session';

type Usage = { seatsUsed: number; seatLimit: number | null; storageBytes: number; storageLimitBytes: number | null; messages: number; aiCalls: number; aiCostPaise: number };
type Invoice = { id: string; number: string; issueDate: string; dueDate: string; periodStart: string; periodEnd: string; totalPaise: number; status: string; paymentUrl: string | null };
type Plan = { key: string; name: string; seats: number | null; prices: Array<{ cycle: string; pricePaise: number }> };
type Sub = { subscription: { plan: string; subStatus: string; trialEndsOn: string | null; periodStart: string | null; periodEnd: string | null };
  usage: Usage; features: Record<string, boolean>; invoices: Invoice[]; plans: Plan[]; upgradeRequests: Array<{ id: string; planKey: string; cycle: string; status: string; createdAt: string }> };
export type Grant = { id: string; status: string; reason: string; adminName: string; requestedWrite: boolean; durationMinutes: number; writeConsent: boolean; expiresAt: string | null; requestedAt: string };

export const bytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/** Settings → Subscription: plan, status, seats/usage, modules, Worko invoices (pay links), plan-change requests, support-access consent. */
export function SubscriptionPanel() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['subscription'], queryFn: async () => (await unwrap(api.GET('/subscription'))) as unknown as Sub });
  const [plan, setPlan] = useState(''); const [cycle, setCycle] = useState<'monthly' | 'annual'>('monthly'); const [note, setNote] = useState('');
  const upgrade = useMutation({
    mutationFn: () => unwrap(api.POST('/subscription/upgrade-requests', { body: { planKey: plan, cycle, note: note || undefined } })),
    onSuccess: () => { toast({ text: t('p12a.sub.requested'), tone: 'ok' }, 3000); setNote(''); void qc.invalidateQueries({ queryKey: ['subscription'] }); },
    onError: (e) => toast({ text: (e as Error).message, tone: 'error' }),
  });
  if (q.isLoading || !q.data) return <p className="text-muted">{t('common.loading')}</p>;
  const { subscription: s, usage: u, invoices, plans, features } = q.data;
  const status = s.subStatus as 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled';
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t('p12a.sub.title')}</h1>
        <span data-testid="sub-status" className="rounded bg-surface-alt px-1.5 py-0.5 text-xs">{t(`p12a.sub.status.${status}`)}</span>
      </header>
      {status === 'past_due' && <p role="alert" className="card border-overdue p-3 text-sm">{t('p12a.sub.pastDue')}</p>}
      <section className="card space-y-1 p-3 text-sm">
        <p>{t('p12a.sub.plan', { plan: plans.find((p) => p.key === s.plan)?.name ?? s.plan })}</p>
        {status === 'trial' && s.trialEndsOn && <p>{t('p12a.sub.trialEnds', { date: formatDate(s.trialEndsOn) })}</p>}
        {s.periodStart && s.periodEnd && <p>{t('p12a.sub.period', { from: formatDate(s.periodStart), to: formatDate(s.periodEnd) })}</p>}
      </section>
      <section className="card space-y-1 p-3 text-sm" aria-label={t('p12a.sub.usage')}>
        <h2 className="font-semibold">{t('p12a.sub.usage')}</h2>
        <p>{t('p12a.pl.seats', { used: u.seatsUsed, limit: u.seatLimit ?? t('p12a.pl.unlimited') })}</p>
        <p>{t('p12a.pl.storage', { used: bytes(u.storageBytes) })}{u.storageLimitBytes ? ` / ${bytes(u.storageLimitBytes)}` : ''}</p>
        <p>{t('p12a.pl.messages', { n: u.messages })}</p>
        <p>{t('p12a.pl.ai', { n: u.aiCalls, cost: formatINR(u.aiCostPaise) })}</p>
        <h3 className="pt-2 font-semibold">{t('p12a.sub.modules')}</h3>
        <ul className="flex flex-wrap gap-2">{Object.entries(features).map(([k, v]) => <li key={k} className="rounded bg-surface-alt px-1.5 py-0.5 text-xs">{k}: {v ? t('p12a.sub.on') : t('p12a.sub.off')}</li>)}</ul>
      </section>
      <section className="card p-3 text-sm" aria-label={t('p12a.sub.invoices')}>
        <h2 className="mb-2 font-semibold">{t('p12a.sub.invoices')}</h2>
        {invoices.length === 0 ? <p className="text-muted">{t('p12a.sub.noInvoices')}</p> : (
          <table className="w-full text-left"><tbody>
            {invoices.map((i) => (
              <tr key={i.id} className="border-t border-border">
                <td className="py-1">{i.number}</td><td>{formatDate(i.periodStart)} – {formatDate(i.periodEnd)}</td><td className="text-right">{formatINR(i.totalPaise)}</td>
                <td className="pl-2">{i.status === 'paid' ? t('p12a.sub.paid') : <>{t('p12a.sub.due', { date: formatDate(i.dueDate) })} {i.paymentUrl && <a className="btn ml-2" href={i.paymentUrl} target="_blank" rel="noreferrer">{t('p12a.sub.pay')}</a>}</>}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </section>
      {can('settings', 'edit') && (
        <section className="card space-y-2 p-3 text-sm" aria-label={t('p12a.sub.upgrade')}>
          <h2 className="font-semibold">{t('p12a.sub.upgrade')}</h2>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label={t('p12a.pl.col.plan')}>
              <select className="input" value={plan} onChange={(e) => setPlan(e.target.value)}>
                <option value="" />
                {plans.map((p) => <option key={p.key} value={p.key}>{p.name}{p.prices.filter((x) => x.cycle === cycle).slice(-1).map((x) => ` — ${t(cycle === 'monthly' ? 'p12a.sub.perMonth' : 'p12a.sub.perYear', { price: formatINR(x.pricePaise) })}`)}</option>)}
              </select>
            </Field>
            <Field label={t('p12a.sub.cycle')}>
              <select className="input" value={cycle} onChange={(e) => setCycle(e.target.value as 'monthly' | 'annual')}><option value="monthly">{t('p12a.sub.monthly')}</option><option value="annual">{t('p12a.sub.annual')}</option></select>
            </Field>
            <Field label={t('p12a.sub.note')}><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
          </div>
          <button className="btn" disabled={!plan || upgrade.isPending} onClick={() => upgrade.mutate()}>{t('p12a.sub.send')}</button>
          {q.data.upgradeRequests.length > 0 && <p className="text-muted">{t('p12a.sub.requests')}: {q.data.upgradeRequests.map((r) => `${r.planKey} (${r.cycle}, ${r.status})`).join(' · ')}</p>}
        </section>
      )}
      <SupportAccess />
    </div>
  );
}

/** Support-access consent: a partner approves (time-boxed; write only if asked and ticked), anyone allowed revokes. */
export function SupportAccess() {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe().data;
  const isPartner = !!me?.roles.includes('partner');
  const q = useQuery({ queryKey: ['impersonation'], queryFn: async () => (await unwrap(api.GET('/impersonation/grants'))) as unknown as Grant[] });
  const [open, setOpen] = useState<Grant | null>(null);
  const act = useMutation({
    mutationFn: async (x: { id: string; op: 'approve' | 'deny' | 'revoke'; body?: { writeConsent: boolean; minutes: number } }) => {
      const params = { path: { id: x.id } };
      if (x.op === 'approve') return unwrap(api.POST('/impersonation/grants/{id}/approve', { params, body: x.body! }));
      if (x.op === 'deny') return unwrap(api.POST('/impersonation/grants/{id}/deny', { params }));
      return unwrap(api.POST('/impersonation/grants/{id}/revoke', { params }));
    },
    onSuccess: () => { setOpen(null); void qc.invalidateQueries({ queryKey: ['impersonation'] }); },
    onError: (e) => toast({ text: (e as Error).message, tone: 'error' }),
  });
  const grants = q.data ?? [];
  return (
    <section className="card space-y-2 p-3 text-sm" aria-label={t('p12a.imp.title')}>
      <h2 className="font-semibold">{t('p12a.imp.title')}</h2>
      {grants.length === 0 ? <p className="text-muted">{t('p12a.imp.none')}</p> : (
        <ul className="space-y-2">
          {grants.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2">
              <span>{t('p12a.imp.from', { name: g.adminName, mode: t(g.requestedWrite ? 'p12a.imp.write' : 'p12a.imp.read'), minutes: g.durationMinutes })} — “{g.reason}”</span>
              <span className="rounded bg-surface-alt px-1.5 py-0.5 text-xs">{t(`p12a.imp.status.${g.status as 'requested'}`, { until: g.expiresAt ? formatDateTime(g.expiresAt) : '' })}</span>
              {g.status === 'requested' && (isPartner
                ? <><button className="btn" onClick={() => setOpen(g)}>{t('p12a.imp.approve')}</button><button className="btn" onClick={() => act.mutate({ id: g.id, op: 'deny' })}>{t('p12a.imp.deny')}</button></>
                : <span className="text-muted">{t('p12a.imp.partnerOnly')}</span>)}
              {(g.status === 'approved' || g.status === 'requested') && <button className="btn" onClick={() => act.mutate({ id: g.id, op: 'revoke' })}>{t('p12a.imp.revoke')}</button>}
            </li>
          ))}
        </ul>
      )}
      {open && <ConsentDialog grant={open} onClose={() => setOpen(null)} onApprove={(body) => act.mutate({ id: open.id, op: 'approve', body })} />}
    </section>
  );
}

function ConsentDialog({ grant, onClose, onApprove }: { grant: Grant; onClose(): void; onApprove(b: { writeConsent: boolean; minutes: number }): void }) {
  const t = useT();
  const [write, setWrite] = useState(false); const [minutes, setMinutes] = useState(grant.durationMinutes);
  return (
    <Dialog title={t('p12a.imp.consentTitle')} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>{t('p12a.imp.consentBody')}</p>
        <p className="text-muted">“{grant.reason}” — {grant.adminName}</p>
        <Field label={t('p12a.imp.minutes')}><input className="input" type="number" min={5} max={grant.durationMinutes} value={minutes} onChange={(e) => setMinutes(Math.max(5, Math.min(grant.durationMinutes, Number(e.target.value) || 5)))} /></Field>
        {grant.requestedWrite && <label className="flex items-center gap-2"><input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />{t('p12a.imp.writeConsent')}</label>}
        <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn" onClick={() => onApprove({ writeConsent: write, minutes })}>{t('p12a.imp.approve')}</button></div>
      </div>
    </Dialog>
  );
}
