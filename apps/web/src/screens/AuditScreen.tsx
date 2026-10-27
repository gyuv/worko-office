import { useMutation, useQuery } from '@tanstack/react-query';
import { formatDateTime } from '@worko/i18n';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useT } from '../lib/i18n';
import { api, unwrap } from '../lib/session';

export function AuditScreen() {
  const t = useT();
  const log = useQuery({ queryKey: ['audit'], queryFn: () => unwrap(api.GET('/audit', { params: { query: { limit: 200 } } })) });
  const verify = useMutation({ mutationFn: () => unwrap(api.GET('/audit/verify')) });
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t('audit.title')}</h1>
        <button className="btn" onClick={() => verify.mutate()}>{t('audit.verify')}</button>
        {verify.data && (verify.data.ok
          ? <span className="flex items-center gap-1 text-done"><ShieldCheck size={16} aria-hidden /> {t('audit.intact', { count: verify.data.checked })}</span>
          : <span className="flex items-center gap-1 text-overdue"><ShieldAlert size={16} aria-hidden /> {t('audit.broken', { seq: verify.data.brokenAt ?? '?' })}</span>)}
      </div>
      <div className="card overflow-auto">
        <table className="table w-full">
          <thead><tr><th>{t('audit.when')}</th><th>{t('audit.who')}</th><th>{t('audit.action')}</th><th>{t('audit.entity')}</th></tr></thead>
          <tbody>
            {(log.data ?? []).map((e) => (
              <tr key={e.seq}>
                <td className="whitespace-nowrap">{formatDateTime(e.at)}</td>
                <td>{e.actorName ?? '—'}</td>
                <td className="font-mono text-xs">{e.action}</td>
                <td className="text-muted">{e.entity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
