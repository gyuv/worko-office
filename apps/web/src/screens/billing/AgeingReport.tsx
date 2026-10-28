import { useQuery } from '@tanstack/react-query';
import { AGEING_BUCKETS } from '@worko/domain';
import { Fragment, useState } from 'react';
import { Field } from '../../components/Dialog';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { ageingCheck } from './logic';
import { Money } from './shared';

export function AgeingReport() {
  const t = useT();
  const [asOf, setAsOf] = useState(todayIst());
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['billing', 'ageing', asOf], queryFn: () => unwrap(api.GET('/billing/ageing', { params: { query: { asOf } } })) });
  const d = q.data;
  const check = d ? ageingCheck(d.clients, d.totals) : null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('bill.ageing.asOf')}><input type="date" className="input" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        {check && <p role="status" className={`text-sm ${check.ok ? 'text-muted' : 'text-overdue'}`}>
          {t('bill.ageing.reconcile')} <Money p={d!.totals.totalPaise ?? 0} /> · {t('bill.ageing.sumBalances')} <Money p={check.sumOfBalances} /> · {t('bill.ageing.sumBuckets')} <Money p={check.sumOfBuckets} />
          {!check.ok && ` · ${t('bill.ageing.mismatch')}`}</p>}
      </div>
      {d && !d.clients.length ? <p className="card p-6 text-muted">{t('bill.ageing.empty')}</p> : d && (
        <div className="card overflow-auto">
          <table className="table w-full">
            <thead><tr><th>{t('bill.client')}</th>{AGEING_BUCKETS.map((b) => <th key={b} className="text-right">{t(`bill.ageing.${b}`)}</th>)}<th className="text-right">{t('bill.balance')}</th><th className="text-right">{t('bill.advance')}</th></tr></thead>
            <tbody>{d.clients.map((c) => (
              <Fragment key={c.clientId}>
                <tr>
                  <td><button className="underline" aria-expanded={open === c.clientId} onClick={() => setOpen(open === c.clientId ? null : c.clientId ?? null)}>{c.clientName}</button></td>
                  {AGEING_BUCKETS.map((b) => <td key={b} className="text-right"><Money p={c.buckets?.[b] ?? 0} /></td>)}
                  <td className="text-right font-medium"><Money p={c.totalPaise ?? 0} /></td><td className="text-right text-muted"><Money p={c.advancePaise ?? 0} /></td>
                </tr>
                {open === c.clientId && <tr><td colSpan={AGEING_BUCKETS.length + 3}><ClientInvoices clientId={c.clientId!} /></td></tr>}
              </Fragment>
            ))}</tbody>
            <tfoot><tr className="font-semibold"><td>{t('bill.ageing.total')}</td>{AGEING_BUCKETS.map((b) => <td key={b} className="text-right" data-testid={`ageing-total-${b}`}><Money p={d.totals[b] ?? 0} /></td>)}
              <td className="text-right" data-testid="ageing-total"><Money p={d.totals.totalPaise ?? 0} /></td><td className="text-right"><Money p={d.totals.advancePaise ?? 0} /></td></tr></tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

/** Drill-down / Client 360: a client's open receivables, advances and net. */
export function ClientInvoices({ clientId }: { clientId: string }) {
  const t = useT();
  const q = useQuery({ queryKey: ['billing', 'outstanding', clientId], queryFn: () => unwrap(api.GET('/billing/clients/{id}/outstanding', { params: { path: { id: clientId } } })) });
  const d = q.data;
  if (q.isError) return <p role="alert" className="text-overdue">{t('common.error')}</p>;
  if (!d) return <p className="text-muted">{t('common.loading')}</p>;
  const items = d.items as unknown as Array<{ id: string; kind: string; number: string | null; issueDate: string | null; dueDate: string | null; totalPaise: number; balancePaise: number }>;
  return (
    <div className="space-y-2">
      <p className="text-sm">{t('bill.outstanding')} <Money p={d.outstandingPaise} /> · {t('bill.advance')} <Money p={d.advancePaise} /> · <b>{t('bill.net')} <Money p={d.netPaise} /></b></p>
      {items.length ? <table className="table w-full text-sm">
        <thead><tr><th>{t('bill.number')}</th><th>{t('bill.issueDate')}</th><th>{t('bill.dueDate')}</th><th className="text-right">{t('bill.total')}</th><th className="text-right">{t('bill.balance')}</th></tr></thead>
        <tbody>{items.map((i) => <tr key={i.id}><td><a className="underline" href={`#/billing/${i.id}`}>{i.number}</a></td><td>{i.issueDate}</td>
          <td className={i.dueDate && i.dueDate < todayIst() ? 'text-overdue' : ''}>{i.dueDate}</td><td className="text-right"><Money p={i.totalPaise} /></td><td className="text-right"><Money p={i.balancePaise} /></td></tr>)}</tbody>
      </table> : <p className="text-muted">{t('bill.nothingOpen')}</p>}
    </div>
  );
}
