import { useMutation } from '@tanstack/react-query';
import { formatDate } from '@worko/i18n';
import { useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { useRuleMessage } from './shared';

/** Pick a month → preview (to create / already exists) → commit. Idempotent on the server. */
export function AutoCreateWizard({ onClose }: { onClose(): void }) {
  const t = useT();
  const ruleMsg = useRuleMessage();
  const [month, setMonth] = useState(todayIst().slice(0, 7));
  const preview = useMutation({ mutationFn: (m: string) => unwrap(api.POST('/tasks/auto/preview', { body: { month: m } })) });
  const commit = useMutation({ mutationFn: (m: string) => unwrap(api.POST('/tasks/auto/commit', { body: { month: m } })) });
  const p = preview.data;
  return (
    <Dialog title={t('tasks.auto.title')} onClose={onClose} wide>
      <div className="space-y-3">
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); commit.reset(); preview.mutate(month); }}>
          <Field label={t('tasks.auto.month')}><input type="month" className="input w-44" required value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
          <button className="btn" disabled={preview.isPending}>{t('tasks.auto.preview')}</button>
        </form>
        <p className="text-xs text-muted">{t('tasks.auto.hint')}</p>
        {preview.isError && <p role="alert" className="text-overdue">{ruleMsg(preview.error)}</p>}
        {p && !commit.data && (
          <>
            <p role="status" className="font-medium">{t('tasks.auto.summary', { toCreate: p.toCreate, skipped: p.skipped })}</p>
            {p.items.length > 0 && (
              <div className="max-h-80 overflow-auto rounded border border-border">
                <table className="table w-full text-sm">
                  <thead><tr><th>{t('tasks.f.client')}</th><th>{t('tasks.auto.form')}</th><th>{t('tasks.auto.period')}</th><th>{t('tasks.statutoryDue')}</th><th>{t('tasks.actBy')}</th></tr></thead>
                  <tbody>{p.items.map((i) => (
                    <tr key={`${i.clientId}:${i.serviceTypeId}:${i.periodKey}`}><td>{i.clientName}</td><td>{i.form}</td><td>{i.periodLabel}</td><td>{formatDate(i.statutoryDue)}</td><td>{formatDate(i.actBy)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
              <button className="btn btn-primary" disabled={!p.toCreate || commit.isPending} onClick={() => commit.mutate(p.month)}>{t('tasks.auto.commit', { count: p.toCreate })}</button>
            </div>
          </>
        )}
        {commit.isError && <p role="alert" className="text-overdue">{ruleMsg(commit.error)}</p>}
        {commit.data && (
          <div className="space-y-2">
            <p role="status" className="text-done">{t('tasks.auto.done', { created: commit.data.created, skipped: commit.data.skipped })}</p>
            <div className="flex justify-end"><button className="btn btn-primary" onClick={onClose}>{t('common.close')}</button></div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
