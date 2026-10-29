import { formatDateTime } from '@worko/i18n';
import { useState } from 'react';
import { Tabs } from '../../components/Dialog';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { NoAccess } from '../comm/shared';
import { useSuggestions } from './api';
import { AiBadge, SuggestionReview } from './AiParts';
import type { Suggestion } from './logic';

type St = 'pending' | 'approved' | 'rejected';

/** AI suggestions inbox: everything AI produced waits here for a human (D149). */
export function SuggestionsScreen() {
  const t = useT();
  const can = useCan();
  const [st, setSt] = useState<St>('pending');
  const [open, setOpen] = useState<string | null>(null);
  const q = useSuggestions({ status: st });
  if (!can('ai', 'view')) return <NoAccess />;
  const items = q.data ?? [];
  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold">{t('p10.nav.suggestions')}</h1><AiBadge /></header>
      <p className="text-sm text-muted">{t('p10.ai.inboxHint')}</p>
      <Tabs<St> label={t('p10.nav.suggestions')} value={st} onChange={(v) => { setSt(v); setOpen(null); }} tabs={[['pending', t('p10.sst.pending')], ['approved', t('p10.sst.approved')], ['rejected', t('p10.sst.rejected')]]} />
      {q.isLoading && <p className="text-muted">{t('common.loading')}</p>}
      {q.isError && <p role="alert" className="text-overdue">{t('common.error')}</p>}
      {!q.isLoading && !items.length && <p className="card p-4 text-muted">{t('p10.ai.empty')}</p>}
      <ul className="space-y-2">
        {items.map((s: Suggestion) => (
          <li key={s.id} className="card p-3">
            <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
              <span className="font-medium">{t(`p10.kind.${s.kind}` as 'p10.kind.summary')}</span>
              <span className="text-sm text-muted">{s.sources?.find((x) => x.type === 'client')?.label ?? ''}</span>
              {s.ruleId && <span className="rounded bg-surface-alt px-1.5 text-xs">{t('p10.ai.fromRule')}</span>}
              <time className="ml-auto text-xs text-muted" dateTime={s.createdAt}>{formatDateTime(s.createdAt)}</time>
            </button>
            {open === s.id && <div className="mt-3 border-t border-border pt-3"><SuggestionReview s={s} onDone={() => setOpen(null)} /></div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
