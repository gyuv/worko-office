import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { Money, useEntities } from './shared';

type Draft = { clientId: string; clientName: string; lines: Array<{ taskId: string; title: string; ratePaise: number }> };
const onErr = (e: unknown) => toast({ text: (e as Error).message, tone: 'error' });

/** Period → preview (one draft per client from done-unbilled tasks priced from the rate tables) → commit. */
export function AutoBillingWizard() {
  const t = useT();
  const qc = useQueryClient();
  const entities = useEntities().data ?? [];
  const [from, setFrom] = useState(`${todayIst().slice(0, 8)}01`);
  const [to, setTo] = useState(todayIst());
  const [entityId, setEntityId] = useState('');
  const body = { from, to, entityId: entityId || null };
  const preview = useMutation({ mutationFn: () => unwrap(api.POST('/billing/auto/preview', { body })), onError: onErr });
  const commit = useMutation({ mutationFn: () => unwrap(api.POST('/billing/auto/commit', { body })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['billing'] }); }, onError: onErr });
  const drafts = (preview.data?.drafts ?? []) as unknown as Draft[];
  return (
    <div className="space-y-3">
      <ol className="flex gap-3 text-sm text-muted"><li className={!preview.data ? 'font-semibold text-fg' : ''}>1. {t('bill.auto.step1')}</li><li className={preview.data && !commit.data ? 'font-semibold text-fg' : ''}>2. {t('bill.auto.step2')}</li><li className={commit.data ? 'font-semibold text-fg' : ''}>3. {t('bill.auto.step3')}</li></ol>
      <form className="card grid gap-2 p-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); commit.reset(); preview.mutate(); }}>
        <Field label={t('bill.f.from')}><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('bill.f.to')}><input type="date" className="input" required value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label={t('bill.entity')}><select className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
          <option value="">{t('bill.defaultEntity')}</option>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <div className="flex items-end"><button className="btn btn-primary" disabled={preview.isPending}>{t('bill.auto.preview')}</button></div>
      </form>
      {preview.data && (
        <div className="space-y-2">
          <p role="status">{t('bill.auto.summary', { invoices: preview.data.invoices ?? 0, tasks: preview.data.tasks ?? 0 })}</p>
          {drafts.map((d) => (
            <details key={d.clientId} className="card p-2">
              <summary className="flex cursor-pointer gap-2"><span className="flex-1">{d.clientName}</span><span className="text-muted">{t('bill.line.tasks', { count: d.lines.length })}</span><Money p={d.lines.reduce((s, l) => s + l.ratePaise, 0)} /></summary>
              <ul className="mt-1 text-sm">{d.lines.map((l) => <li key={l.taskId} className="flex"><span className="flex-1">{l.title}</span><Money p={l.ratePaise} /></li>)}</ul>
            </details>
          ))}
          {!!preview.data.unpriced?.length && <p className="text-sm text-due-soon">{t('bill.auto.unpriced', { count: preview.data.unpriced.length })}</p>}
          {!commit.data && drafts.length > 0 && <button className="btn btn-primary" disabled={commit.isPending} onClick={() => commit.mutate()}>{t('bill.auto.commit', { count: drafts.length })}</button>}
          {commit.data && <p role="status" className="text-done">{t('bill.auto.done', { created: commit.data.created, skipped: commit.data.skipped })} <a className="underline" href="#/billing/invoices">{t('bill.tab.invoices')}</a></p>}
        </div>
      )}
    </div>
  );
}

type RetItem = { clientServiceId: string; clientName: string; serviceName: string; frequency: string; ratePaise: number | null; exists: boolean };

export function RetainersWizard() {
  const t = useT();
  const qc = useQueryClient();
  const [month, setMonth] = useState(todayIst().slice(0, 7));
  const preview = useMutation({ mutationFn: () => unwrap(api.POST('/billing/retainers/preview', { body: { month } })), onError: onErr });
  const commit = useMutation({ mutationFn: () => unwrap(api.POST('/billing/retainers/commit', { body: { month } })), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['billing'] }); }, onError: onErr });
  const items = (preview.data?.items ?? []) as unknown as RetItem[];
  return (
    <div className="space-y-3">
      <form className="card flex flex-wrap items-end gap-2 p-3" onSubmit={(e) => { e.preventDefault(); commit.reset(); preview.mutate(); }}>
        <Field label={t('bill.ret.month')}><input type="month" className="input" required value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <button className="btn btn-primary" disabled={preview.isPending}>{t('bill.auto.preview')}</button>
      </form>
      {preview.data && (
        <div className="space-y-2">
          <p role="status">{t('bill.ret.summary', { count: preview.data.toCreate ?? 0 })}</p>
          <div className="card overflow-auto"><table className="table w-full">
            <thead><tr><th>{t('bill.client')}</th><th>{t('bill.ret.service')}</th><th>{t('bill.ret.frequency')}</th><th className="text-right">{t('bill.ret.rate')}</th><th>{t('bill.status')}</th></tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.clientServiceId}><td>{i.clientName}</td><td>{i.serviceName}</td><td>{i.frequency}</td><td className="text-right"><Money p={i.ratePaise} /></td>
                <td>{i.exists ? t('bill.ret.exists') : i.ratePaise === null ? <span className="text-due-soon">{t('bill.noRate')}</span> : t('bill.ret.willCreate')}</td></tr>
            ))}</tbody>
          </table></div>
          {!commit.data && (preview.data.toCreate ?? 0) > 0 && <button className="btn btn-primary" disabled={commit.isPending} onClick={() => commit.mutate()}>{t('bill.auto.commit', { count: preview.data.toCreate ?? 0 })}</button>}
          {commit.data && <p role="status" className="text-done">{t('bill.auto.done', { created: commit.data.created ?? 0, skipped: commit.data.skipped ?? 0 })}</p>}
        </div>
      )}
    </div>
  );
}
