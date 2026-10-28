import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { Money } from './shared';

/** Done tasks with no billing outcome, with the rate-table suggestion; "create draft" bills one client's tasks. */
export function UnbilledReport() {
  const t = useT();
  const can = useCan();
  const go = useRoute((s) => s.go);
  const qc = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [client, setClient] = useState<PickedClient | null>(null);
  const query = { from: from || undefined, to: to || undefined, clientId: client?.id };
  const q = useQuery({ queryKey: ['billing', 'unbilled', query], queryFn: () => unwrap(api.GET('/billing/unbilled', { params: { query } })) });
  const items = q.data?.items ?? [];
  const byClient = new Map<string, typeof items>();
  for (const i of items) byClient.set(i.clientId ?? '', [...(byClient.get(i.clientId ?? '') ?? []), i]);
  const draft = useMutation({
    mutationFn: (clientId: string) => unwrap(api.POST('/billing/invoices', { body: { clientId, lines: (byClient.get(clientId) ?? []).map((u) => ({
      description: u.title ?? '', serviceTypeId: u.serviceTypeId ?? null, qty: 1, ratePaise: u.suggestedPaise ?? 0, taskIds: [u.taskId!] })) } })),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['billing'] }); go(`billing/${(r as { id: string }).id}`); },
    onError: (e) => toast({ text: (e as Error).message, tone: 'error' }),
  });
  return (
    <div className="space-y-3">
      <div className="card grid gap-2 p-3 sm:grid-cols-4">
        <Field label={t('bill.f.from')}><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('bill.f.to')}><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <div className="sm:col-span-2"><ClientPicker label={t('bill.f.client')} value={client} onChange={setClient} /></div>
      </div>
      <p role="status" className="text-sm text-muted">{t('bill.unbilledSummary', { count: q.data?.count ?? 0 })} <Money p={q.data?.suggestedTotalPaise ?? 0} /></p>
      {q.data && !items.length && <p className="card p-6 text-muted">{t('bill.unbilledEmpty')}</p>}
      {[...byClient.entries()].map(([cid, rows]) => (
        <section key={cid} className="card p-3">
          <header className="mb-2 flex items-center gap-2">
            <h2 className="font-semibold">{rows[0]?.clientName}</h2>
            <Money className="text-muted" p={rows.reduce((s, r) => s + (r.suggestedPaise ?? 0), 0)} />
            {can('billing', 'create') && <button className="btn ml-auto" disabled={draft.isPending} onClick={() => draft.mutate(cid)}>{t('bill.createDraftFor', { name: rows[0]?.clientName ?? '' })}</button>}
          </header>
          <table className="table w-full">
            <thead><tr><th>{t('bill.task')}</th><th>{t('bill.period')}</th><th>{t('bill.completedOn')}</th><th className="text-right">{t('bill.suggested')}</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.taskId}><td>{r.title}{r.retainer && <span className="ml-1 text-xs text-muted">{t('bill.retainer')}</span>}</td><td>{r.periodKey ?? '—'}</td><td>{r.completedOn ?? '—'}</td>
                <td className="text-right">{r.suggestedPaise === null || r.suggestedPaise === undefined ? <span className="text-due-soon">{t('bill.noRate')}</span> : <Money p={r.suggestedPaise} />}</td></tr>
            ))}</tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
