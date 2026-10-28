import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@worko/i18n';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api, unwrap } from '../../lib/session';
import { as, type Reimbursable } from '../hr/api';
import { useP6Error } from '../time/shared';
import { Money } from './shared';

type Item = Reimbursable['items'][number];

/** Approved billable expense lines not yet recovered (D94), with a link-to-invoice action. */
export function ReimbursableReport() {
  const t = useT();
  const can = useCan();
  const [client, setClient] = useState<PickedClient | null>(null);
  const [linking, setLinking] = useState<Item | null>(null);
  const q = useQuery({ queryKey: ['hr', 'reimbursable', client?.id ?? ''], queryFn: () => as<Reimbursable>(api.GET('/hr/expenses/reimbursable', { params: { query: { clientId: client?.id } } })) });
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-2">
      <div className="card max-w-md p-3"><ClientPicker label={t('p6.f.client')} value={client} onChange={setClient} /></div>
      <p className="text-sm text-muted" role="status">{t('p6.reimb.total', { count: items.length })} <Money p={q.data?.totalPaise ?? 0} /></p>
      {q.data && !items.length ? <p className="card p-6 text-muted">{t('p6.reimb.none')}</p> : (
        <div className="card overflow-auto"><table className="table w-full" aria-label={t('p6.reimb.title')}>
          <thead><tr><th>{t('p6.f.client')}</th><th>{t('p6.f.date')}</th><th>{t('p6.reimb.suggested')}</th><th>{t('p6.f.person')}</th><th className="text-right">{t('p6.exp.approved')}</th><th /></tr></thead>
          <tbody>{items.map((x) => (
            <tr key={x.id}><td>{x.clientName}</td><td>{formatDate(x.spentOn)}</td><td>{x.suggestedLine.description}</td><td>{x.claimantName}</td>
              <td className="text-right"><Money p={x.approvedPaise} /></td>
              <td className="text-right">{can('billing', 'edit') && x.clientId && <button className="btn" onClick={() => setLinking(x)}>{t('p6.reimb.link')}</button>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="text-xs text-muted">{t('p6.reimb.hint')}</p>
      {linking && <LinkDialog item={linking} onClose={() => setLinking(null)} />}
    </div>
  );
}

function LinkDialog({ item, onClose }: { item: Item; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const [invoiceId, setInvoiceId] = useState('');
  const [lineId, setLineId] = useState('');
  const invoices = useQuery({ queryKey: ['billing', 'invoices', { clientId: item.clientId, reimb: true }],
    queryFn: () => unwrap(api.GET('/billing/invoices', { params: { query: { clientId: item.clientId!, kind: 'invoice', limit: 50 } } })) });
  const inv = useQuery({ queryKey: ['billing', 'invoice', invoiceId], enabled: !!invoiceId, queryFn: () => unwrap(api.GET('/billing/invoices/{id}', { params: { path: { id: invoiceId } } })) });
  const lines = (inv.data?.lines ?? []).filter((l) => l.reimbursement && l.id && l.amountPaise === item.approvedPaise);
  const m = useMutation({
    mutationFn: () => as(api.POST('/hr/expenses/lines/{id}/link', { params: { path: { id: item.id } }, body: { invoiceLineId: lineId } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['hr', 'reimbursable'] }); toast({ text: t('p6.reimb.linked'), tone: 'ok' }, 3000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p6.reimb.link')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (lineId) m.mutate(); }}>
        <p className="text-sm">{item.suggestedLine.description} · <Money p={item.approvedPaise} /></p>
        <Field label={t('p6.reimb.invoice')}><select className="input" value={invoiceId} onChange={(e) => { setInvoiceId(e.target.value); setLineId(''); }}>
          <option value="">—</option>
          {(invoices.data?.items ?? []).filter((i) => i.status !== 'cancelled').map((i) => <option key={i.id} value={i.id}>{i.number ?? t('bill.draftNo')} · {i.issueDate ?? ''}</option>)}
        </select></Field>
        {invoiceId && inv.data && (lines.length ? (
          <Field label={t('p6.reimb.line')}><select className="input" value={lineId} onChange={(e) => setLineId(e.target.value)}>
            <option value="">—</option>{lines.map((l) => <option key={l.id} value={l.id!}>{l.description}</option>)}</select></Field>
        ) : <p className="text-sm text-due-soon">{t('p6.reimb.noLine')}</p>)}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!lineId || m.isPending}>{t('p6.reimb.link')}</button></div>
      </form>
    </Dialog>
  );
}
