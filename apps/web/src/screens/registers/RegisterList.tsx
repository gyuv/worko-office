import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { formatDate } from '@worko/i18n';
import { CheckCircle2, Plus, Printer } from 'lucide-react';
import { useState } from 'react';
import { Tabs } from '../../components/Dialog';
import { fetchBlob, openBlob, todayIst, useDebounced } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { api, unwrap } from '../../lib/session';
import { NewEntryDialog } from './NewEntryDialog';

export type Kind = 'inward' | 'outward';
type Entry = Schemas['RegisterEntry'];

/** Inward/outward register list; firm-wide on the Registers screen, or scoped to one client in Client 360. */
export function RegisterList({ clientId, clientName, filters }: { clientId?: string; clientName?: string; filters?: boolean }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>('inward');
  const [q, setQ] = useState('');
  const [pending, setPending] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const list = useQuery({
    queryKey: ['registers', kind, { clientId, q: dq, pending, from, to }],
    queryFn: () => unwrap(api.GET('/registers/{kind}', { params: { path: { kind }, query: { clientId, q: dq || undefined, pending: pending ? 'true' : undefined, from: from || undefined, to: to || undefined } } })),
    placeholderData: (p) => p,
  });
  const close = useMutation({
    mutationFn: (e: Entry) => unwrap(api.PATCH('/registers/{kind}/{id}', { params: { path: { kind, id: e.id } }, body: kind === 'inward' ? { returned_on: todayIst() } : { received_back_on: todayIst() } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['registers'] }),
  });
  const print = async (e: Entry) => {
    setErr('');
    try { openBlob((await fetchBlob(`/registers/${kind}/${e.id}/receipt.pdf`)).blob); } catch { setErr(t('reg.printFailed')); }
  };
  const isPending = (e: Entry) => (kind === 'inward' ? e.returnable && !e.returned_on : e.to_be_received_back && !e.received_back_on);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs label={t('nav.registers')} tabs={[['inward', t('reg.inward')], ['outward', t('reg.outward')]]} value={kind} onChange={(k) => { setKind(k); setCreated(null); }} />
        {can('registers', 'create') && <button className="btn btn-primary ml-auto" onClick={() => setCreating(true)}><Plus size={14} aria-hidden /> {t(kind === 'inward' ? 'reg.newInward' : 'reg.newOutward')}</button>}
      </div>
      {filters && (
        <div className="flex flex-wrap items-end gap-2">
          <input type="search" aria-label={t('common.search')} placeholder={t('reg.searchPlaceholder')} className="input max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="text-sm">{t('reg.from')} <input type="date" className="input w-40" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-sm">{t('reg.to')} <input type="date" className="input w-40" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} /> {t(kind === 'inward' ? 'reg.pendingReturn' : 'reg.pendingReceipt')}</label>
        </div>
      )}
      <div aria-live="polite">
        {created && <p role="status" className="text-done">{t('reg.created', { number: created })}</p>}
        {err && <p role="alert" className="text-overdue">{err}</p>}
      </div>
      {list.data && !list.data.items.length ? <p className="card p-6 text-muted">{t('reg.empty')}</p> : (
        <div className="card overflow-auto">
          <table className="table w-full">
            <thead><tr><th>{t('reg.number')}</th><th>{t('reg.date')}</th>{!clientId && <th>{t('docs.client')}</th>}<th>{kind === 'inward' ? t('reg.fromName') : t('reg.toName')}</th><th>{t('reg.mode')}</th><th>{t('reg.description')}</th><th>{t('reg.status')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
            <tbody>
              {(list.data?.items ?? []).map((e) => (
                <tr key={e.id}>
                  <td className="font-mono">{e.number}</td>
                  <td>{formatDate((kind === 'inward' ? e.received_on : e.sent_on) ?? e.created_at ?? '')}</td>
                  {!clientId && <td>{e.client_id ? <a className="underline" href={`#/clients/${e.client_id}`}>{e.client_name}</a> : e.client_name}</td>}
                  <td>{kind === 'inward' ? e.from_name : e.to_name}<div className="text-xs text-muted">{kind === 'inward' ? e.from_phone : e.to_phone}</div></td>
                  <td className="capitalize">{e.mode}{e.tracking_no ? <div className="text-xs text-muted">{e.courier_name} {e.tracking_no}</div> : null}</td>
                  <td>{e.description}{!!e.items?.length && <div className="text-xs text-muted">{e.items.map((i) => `${i.qty ?? 1}× ${i.description}${i.original ? ` (${t('reg.original')})` : ''}`).join(', ')}</div>}</td>
                  <td>{isPending(e) ? <span className="text-overdue">{t(kind === 'inward' ? 'reg.awaitingReturn' : 'reg.awaitingReceipt')}{e.due_back ? ` · ${formatDate(e.due_back)}` : ''}</span>
                    : (e.returned_on || e.received_back_on) ? <span className="text-done">{t(kind === 'inward' ? 'reg.returnedOn' : 'reg.receivedOn', { date: formatDate((e.returned_on ?? e.received_back_on)!) })}</span> : '—'}</td>
                  <td className="whitespace-nowrap text-right">
                    {isPending(e) && can('registers', 'edit') && <button className="btn" onClick={() => close.mutate(e)}><CheckCircle2 size={14} aria-hidden /> {t(kind === 'inward' ? 'reg.markReturned' : 'reg.markReceived')}</button>}
                    <button className="btn ml-1" aria-label={t('reg.printReceipt', { number: e.number })} onClick={() => void print(e)}><Printer size={14} aria-hidden /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewEntryDialog kind={kind} client={clientId ? { id: clientId, name: clientName ?? '' } : null}
        onClose={() => setCreating(false)} onCreated={(n) => { setCreating(false); setCreated(n); void qc.invalidateQueries({ queryKey: ['registers'] }); }} />}
    </div>
  );
}
