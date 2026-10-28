import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { INVOICE_STATUSES } from '@worko/domain';
import { Download, Plus } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { isUuid, useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { AgeingReport } from './AgeingReport';
import { AutoBillingWizard, RetainersWizard } from './AutoBilling';
import { InvoiceView, NewInvoice } from './InvoiceView';
import { download, Money, StatusBadge, useEntities } from './shared';
import { UnbilledReport } from './UnbilledReport';
import { ReimbursableReport } from './ReimbursableReport';

type View = 'invoices' | 'unbilled' | 'auto' | 'retainers' | 'ageing' | 'reimbursable';
const VIEWS: View[] = ['invoices', 'unbilled', 'auto', 'retainers', 'ageing', 'reimbursable'];

export function BillingRoute() {
  const params = useRoute((s) => s.params);
  if (isUuid(params[0])) return <InvoiceView key={params[0]} id={params[0]} />;
  if (params[0] === 'new') return <NewInvoice />;
  return <BillingScreen view={(VIEWS as string[]).includes(params[0] ?? '') ? ((params[0] ?? 'invoices') as View) : 'invoices'} />;
}

function BillingScreen({ view }: { view: View }) {
  const t = useT();
  const can = useCan();
  const go = useRoute((s) => s.go);
  const tabs: Array<[View, string]> = [
    ['invoices', t('bill.tab.invoices')], ['unbilled', t('bill.tab.unbilled')],
    ...(can('billing', 'create') ? [['auto', t('bill.tab.auto')] as [View, string], ['retainers', t('bill.tab.retainers')] as [View, string]] : []),
    ['ageing', t('bill.tab.ageing')], ['reimbursable', t('p6.reimb.title')],
  ];
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t('nav.billing')}</h1>
        {can('billing', 'create') && <button className="btn btn-primary ml-auto" onClick={() => go('billing/new')}><Plus size={14} aria-hidden /> {t('bill.newInvoice')}</button>}
      </header>
      <Tabs label={t('nav.billing')} tabs={tabs} value={view} onChange={(v) => go(`billing/${v}`)} />
      {view === 'invoices' && <InvoiceList />}
      {view === 'unbilled' && <UnbilledReport />}
      {view === 'auto' && <AutoBillingWizard />}
      {view === 'retainers' && <RetainersWizard />}
      {view === 'ageing' && <AgeingReport />}
      {view === 'reimbursable' && <ReimbursableReport />}
    </div>
  );
}

const PAGE = 100;

function InvoiceList() {
  const t = useT();
  const can = useCan();
  const entities = useEntities().data ?? [];
  const [status, setStatus] = useState('');
  const [client, setClient] = useState<PickedClient | null>(null);
  const [entityId, setEntityId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const query = { kind: undefined, status: status || undefined, clientId: client?.id, from: from || undefined, to: to || undefined, overdueAsOf: overdue ? todayIst() : undefined, q: q || undefined, limit: PAGE, offset };
  const list = useQuery({ queryKey: ['billing', 'invoices', query], queryFn: () => unwrap(api.GET('/billing/invoices', { params: { query } })), placeholderData: keepPreviousData });
  // The API has no entity filter; narrow the page client-side.
  const items = (list.data?.items ?? []).filter((i) => !entityId || i.entityId === entityId);
  const total = items.reduce((s, i) => s + (i.status === 'cancelled' ? 0 : i.totalPaise), 0);
  const balance = items.reduce((s, i) => s + (i.status === 'cancelled' || i.status === 'draft' ? 0 : i.balancePaise), 0);
  const reset = () => setOffset(0);
  const exportReg = async (format: 'csv' | 'xlsx') => {
    try { await download(`/billing/invoices/export?format=${format}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`, `invoices.${format}`); }
    catch { toast({ text: t('bill.exportFailed'), tone: 'error' }); }
  };
  return (
    <div className="space-y-3">
      <div className="card grid gap-2 p-3 sm:grid-cols-3 lg:grid-cols-7">
        <Field label={t('bill.f.search')}><input className="input" value={q} onChange={(e) => { setQ(e.target.value); reset(); }} /></Field>
        <Field label={t('bill.f.status')}>
          <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); reset(); }}>
            <option value="">{t('tasks.f.any')}</option>
            {INVOICE_STATUSES.map((s) => <option key={s} value={s}>{t(`bill.status.${s}`)}</option>)}
          </select>
        </Field>
        <div className="lg:col-span-2"><ClientPicker label={t('bill.f.client')} value={client} onChange={(c) => { setClient(c); reset(); }} /></div>
        <Field label={t('bill.f.entity')}>
          <select className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            <option value="">{t('tasks.f.any')}</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label={t('bill.f.from')}><input type="date" className="input" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} /></Field>
        <Field label={t('bill.f.to')}><input type="date" className="input" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} /></Field>
        <label className="flex items-center gap-2"><input type="checkbox" checked={overdue} onChange={(e) => { setOverdue(e.target.checked); reset(); }} /> {t('bill.f.overdue')}</label>
        {can('billing', 'export') && <div className="flex items-end gap-2 lg:col-span-2">
          <button className="btn" onClick={() => void exportReg('csv')}><Download size={14} aria-hidden /> CSV</button>
          <button className="btn" onClick={() => void exportReg('xlsx')}><Download size={14} aria-hidden /> XLSX</button>
        </div>}
      </div>
      <p className="text-sm text-muted" role="status">
        {t('bill.listTotals', { count: items.length, total: list.data?.total ?? 0 })} · {t('bill.totalLabel')} <Money p={total} /> · {t('bill.balanceLabel')} <Money p={balance} />
      </p>
      {list.isError && <p role="alert" className="text-overdue">{t('common.error')}</p>}
      {list.data && !items.length ? <p className="card p-6 text-muted">{t('bill.empty')}</p> : (
        <div className="card overflow-auto">
          <table className="table w-full">
            <thead><tr><th>{t('bill.number')}</th><th>{t('bill.client')}</th><th>{t('bill.issueDate')}</th><th>{t('bill.dueDate')}</th><th>{t('bill.status')}</th><th className="text-right">{t('bill.total')}</th><th className="text-right">{t('bill.balance')}</th></tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.id}>
                <td><a className="underline" href={`#/billing/${i.id}`}>{i.number ?? t('bill.draftNo')}</a>{i.kind !== 'invoice' && <span className="ml-1 text-xs text-muted">{t(`bill.kind.${i.kind}`)}</span>}</td>
                <td>{i.clientName}</td><td>{i.issueDate ?? '—'}</td>
                <td className={i.dueDate && i.dueDate < todayIst() && i.balancePaise > 0 && i.status !== 'draft' && i.status !== 'cancelled' ? 'text-overdue' : ''}>{i.dueDate ?? '—'}</td>
                <td><StatusBadge status={i.status} /></td>
                <td className="text-right"><Money p={i.totalPaise} /></td><td className="text-right"><Money p={i.balancePaise} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {(list.data?.total ?? 0) > PAGE && <div className="flex gap-2">
        <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('bill.prev')}</button>
        <button className="btn" disabled={offset + PAGE >= (list.data?.total ?? 0)} onClick={() => setOffset(offset + PAGE)}>{t('bill.next')}</button>
      </div>}
    </div>
  );
}
