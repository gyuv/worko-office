import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RECEIPT_MODES } from '@worko/domain';
import { Download, FileDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api, unwrap } from '../../lib/session';
import { paiseToInput, parseRupees, planAllocation, type OpenInvoice } from './logic';
import { download, Money, openPdf, RupeeInput } from './shared';

const onErr = (e: unknown) => toast({ text: (e as Error).message, tone: 'error' });

export function ReceiptsScreen() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const [client, setClient] = useState<PickedClient | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [recording, setRecording] = useState(false);
  const query = { clientId: client?.id, from: from || undefined, to: to || undefined, limit: 200 };
  const list = useQuery({ queryKey: ['receipts', query], queryFn: () => unwrap(api.GET('/billing/receipts', { params: { query } })), placeholderData: keepPreviousData });
  const apply = useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/billing/receipts/{id}/apply', { params: { path: { id } }, body: {} })),
    onSuccess: (r) => { toast({ text: t('rcpt.applied', { count: r.allocations?.length ?? 0 }), tone: 'ok' }); void qc.invalidateQueries({ queryKey: ['receipts'] }); void qc.invalidateQueries({ queryKey: ['billing'] }); },
    onError: onErr,
  });
  const items = list.data?.items ?? [];
  const exportReg = async (format: 'csv' | 'xlsx') => {
    try { await download(`/billing/receipts/export?format=${format}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`, `receipts.${format}`); }
    catch { toast({ text: t('bill.exportFailed'), tone: 'error' }); }
  };
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t('nav.receipts')}</h1>
        <div className="ml-auto flex gap-2">
          {can('receipts', 'export') && <><button className="btn" onClick={() => void exportReg('csv')}><Download size={14} aria-hidden /> CSV</button>
            <button className="btn" onClick={() => void exportReg('xlsx')}><Download size={14} aria-hidden /> XLSX</button></>}
          {can('receipts', 'create') && <button className="btn btn-primary" onClick={() => setRecording(true)}><Plus size={14} aria-hidden /> {t('rcpt.record')}</button>}
        </div>
      </header>
      <div className="card grid gap-2 p-3 sm:grid-cols-4">
        <div className="sm:col-span-2"><ClientPicker label={t('bill.f.client')} value={client} onChange={setClient} /></div>
        <Field label={t('bill.f.from')}><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('bill.f.to')}><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <p className="text-sm text-muted" role="status">{t('rcpt.totals', { count: list.data?.total ?? 0 })} <Money p={items.reduce((s, r) => s + r.amountPaise, 0)} /> · {t('bill.tds')} <Money p={items.reduce((s, r) => s + r.tdsPaise, 0)} /></p>
      {list.data && !items.length ? <p className="card p-6 text-muted">{t('rcpt.empty')}</p> : (
        <div className="card overflow-auto"><table className="table w-full">
          <thead><tr><th>{t('bill.number')}</th><th>{t('rcpt.date')}</th><th>{t('bill.client')}</th><th>{t('rcpt.mode')}</th><th className="text-right">{t('rcpt.amount')}</th><th className="text-right">{t('bill.tds')}</th><th className="text-right">{t('rcpt.allocated')}</th><th className="text-right">{t('bill.advance')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
          <tbody>{items.map((r) => (
            <tr key={r.id}>
              <td>{r.number}</td><td>{r.receivedOn}</td><td>{r.clientName}</td><td>{t(`rcpt.mode.${r.mode}` as 'rcpt.mode.cash')}{r.source === 'gateway' ? ' · online' : ''}</td>
              <td className="text-right"><Money p={r.amountPaise} /></td><td className="text-right">{r.tdsPaise ? <><Money p={r.tdsPaise} /> <span className="text-xs text-muted">{r.tdsSection}</span></> : '—'}</td>
              <td className="text-right"><Money p={r.allocatedPaise} /></td><td className="text-right"><Money p={r.unallocatedPaise} /></td>
              <td className="whitespace-nowrap text-right">
                {r.unallocatedPaise > 0 && can('receipts', 'edit') && <button className="btn" disabled={apply.isPending} onClick={() => apply.mutate(r.id)}>{t('rcpt.applyAdvance')}</button>}
                {can('receipts', 'print') && <button className="btn ml-1" aria-label={t('rcpt.pdfFor', { number: r.number })} onClick={() => void openPdf(`/billing/receipts/${r.id}/pdf`).catch(onErr)}><FileDown size={14} /></button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {recording && <RecordReceiptDialog onClose={() => setRecording(false)} onDone={() => { setRecording(false); void qc.invalidateQueries({ queryKey: ['receipts'] }); void qc.invalidateQueries({ queryKey: ['billing'] }); }} />}
    </div>
  );
}

export function RecordReceiptDialog({ onClose, onDone, initialClient }: { onClose(): void; onDone(): void; initialClient?: PickedClient }) {
  const t = useT();
  const [client, setClient] = useState<PickedClient | null>(initialClient ?? null);
  const [receivedOn, setReceivedOn] = useState(todayIst());
  const [amount, setAmount] = useState('');
  const [tds, setTds] = useState('');
  const [tdsSection, setTdsSection] = useState('');
  const [mode, setMode] = useState<(typeof RECEIPT_MODES)[number]>('bank');
  const [reference, setReference] = useState('');
  const [allocMode, setAllocMode] = useState<'fifo' | 'manual' | 'advance'>('fifo');
  const [manual, setManual] = useState<Record<string, string>>({});
  const open = useQuery({ queryKey: ['billing', 'outstanding', client?.id], enabled: !!client,
    queryFn: () => unwrap(api.GET('/billing/clients/{id}/outstanding', { params: { path: { id: client!.id } } })) });
  const items: OpenInvoice[] = ((open.data?.items ?? []) as unknown as Array<{ id: string; number: string | null; dueDate: string | null; balancePaise: number }>)
    .map((i) => ({ id: i.id, number: i.number, dueDate: i.dueDate, balancePaise: i.balancePaise }));
  const amountP = parseRupees(amount); const tdsP = tds ? parseRupees(tds) : 0;
  const manualP = Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, v ? parseRupees(v) ?? 0 : 0]));
  const plan = amountP !== null && tdsP !== null
    ? allocMode === 'advance' ? { allocations: [], advancePaise: amountP, advanceTdsPaise: tdsP, errors: [] as string[] } : planAllocation(amountP, tdsP, items, allocMode === 'manual' ? manualP : undefined)
    : null;
  const tdsNeedsSection = (tdsP ?? 0) > 0 && !tdsSection.trim();
  const save = useMutation({
    mutationFn: () => unwrap(api.POST('/billing/receipts', { body: {
      clientId: client!.id, receivedOn, amountPaise: amountP!, tdsPaise: tdsP ?? 0, tdsSection: tdsSection.trim() || null, mode, reference: reference || null,
      ...(allocMode === 'fifo' ? {} : { allocations: allocMode === 'advance' ? [] : plan!.allocations }) } })),
    onSuccess: (r) => { toast({ text: t('rcpt.recorded', { number: r.number }), tone: 'ok' }); onDone(); }, onError: onErr,
  });
  const valid = !!client && amountP !== null && tdsP !== null && (amountP > 0 || (tdsP ?? 0) > 0) && !tdsNeedsSection && !!plan && !plan.errors.length;
  return (
    <Dialog title={t('rcpt.record')} onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2"><ClientPicker label={t('bill.client')} value={client} onChange={(c) => { setClient(c); setManual({}); }} /></div>
          <Field label={t('rcpt.date')}><input type="date" className="input" required value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} /></Field>
          <Field label={t('rcpt.amount')}><RupeeInput label={t('rcpt.amount')} required value={amount} onChange={setAmount} /></Field>
          <Field label={t('rcpt.mode')}><select className="input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            {RECEIPT_MODES.map((m) => <option key={m} value={m}>{t(`rcpt.mode.${m}`)}</option>)}</select></Field>
          <Field label={t('rcpt.reference')}><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
          <Field label={t('rcpt.tdsAmount')}><RupeeInput label={t('rcpt.tdsAmount')} value={tds} onChange={setTds} /></Field>
          <Field label={t('rcpt.tdsSection')} error={tdsNeedsSection ? t('rcpt.tdsSectionRequired') : null} hint={t('rcpt.tdsSectionHint')}>
            <input className="input" value={tdsSection} onChange={(e) => setTdsSection(e.target.value)} /></Field>
        </div>
        {client && (
          <fieldset className="space-y-2">
            <legend className="label">{t('rcpt.allocation')}</legend>
            <div className="flex flex-wrap gap-3 text-sm">
              {(['fifo', 'manual', 'advance'] as const).map((m) => <label key={m} className="flex items-center gap-1"><input type="radio" name="alloc" checked={allocMode === m}
                onChange={() => { setAllocMode(m); if (m === 'manual' && plan) setManual(Object.fromEntries(planAllocation(amountP ?? 0, tdsP ?? 0, items).allocations.map((a) => [a.invoiceId, paiseToInput(a.amountPaise)]))); }} /> {t(`rcpt.alloc.${m}`)}</label>)}
            </div>
            {items.length ? <table className="table w-full text-sm">
              <thead><tr><th>{t('bill.number')}</th><th>{t('bill.dueDate')}</th><th className="text-right">{t('bill.balance')}</th><th className="text-right">{t('rcpt.cash')}</th><th className="text-right">{t('bill.tds')}</th></tr></thead>
              <tbody>{items.map((i) => {
                const a = plan?.allocations.find((x) => x.invoiceId === i.id);
                return <tr key={i.id}><td>{i.number}</td><td>{i.dueDate}</td><td className="text-right"><Money p={i.balancePaise} /></td>
                  <td className="text-right">{allocMode === 'manual'
                    ? <RupeeInput label={t('rcpt.cashFor', { number: i.number ?? '' })} value={manual[i.id] ?? ''} onChange={(v) => setManual({ ...manual, [i.id]: v })} />
                    : <Money p={a?.amountPaise ?? 0} />}</td>
                  <td className="text-right"><Money p={a?.tdsPaise ?? 0} /></td></tr>;
              })}</tbody>
            </table> : <p className="text-sm text-muted">{t('bill.nothingOpen')}</p>}
            {plan && <p className="text-sm" role="status" data-testid="advance">{t('rcpt.advanceRemainder')} <Money p={plan.advancePaise} />{plan.advanceTdsPaise ? <> + {t('bill.tds')} <Money p={plan.advanceTdsPaise} /></> : null}</p>}
            {plan?.errors.map((e) => <p key={e} role="alert" className="text-sm text-overdue">{t(`rcpt.err.${e}` as 'rcpt.err.overAllocated')}</p>)}
          </fieldset>
        )}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!valid || save.isPending}>{t('rcpt.save')}</button></div>
      </form>
    </Dialog>
  );
}
