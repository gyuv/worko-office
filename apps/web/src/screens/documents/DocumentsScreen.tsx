import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Tabs } from '../../components/Dialog';
import { useDebounced } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { CATEGORIES } from './DocumentsPanel';
import { DocumentTable } from './DocumentTable';

/** Firm-wide document search across everything the user can see, plus the trash. */
export function DocumentsScreen() {
  const t = useT();
  const [view, setView] = useState<'all' | 'trash'>('all');
  const [q, setQ] = useState('');
  const [fy, setFy] = useState('');
  const [category, setCategory] = useState('');
  const [client, setClient] = useState<PickedClient | null>(null);
  const dq = useDebounced(q.trim(), 300);
  const docs = useQuery({
    queryKey: ['documents', { q: dq, fy, category, clientId: client?.id, trashed: view === 'trash' }],
    queryFn: () => unwrap(api.GET('/documents', { params: { query: { q: dq || undefined, fy: fy || undefined, category: category || undefined, clientId: client?.id, trashed: view === 'trash' ? 'true' : undefined, limit: 200 } } })),
    placeholderData: (p) => p,
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t('nav.documents')}</h1>
        <span className="text-sm text-muted" aria-live="polite">{docs.data ? t('docs.count', { count: docs.data.total }) : ''}</span>
      </div>
      <Tabs label={t('nav.documents')} tabs={[['all', t('docs.all')], ['trash', t('docs.trash')]]} value={view} onChange={(k) => setView(k as 'all' | 'trash')} />
      <div className="grid gap-2 sm:grid-cols-[2fr_7rem_10rem_minmax(12rem,1fr)] sm:items-end">
        <input type="search" aria-label={t('docs.search')} placeholder={t('docs.search')} className="input" value={q} onChange={(e) => setQ(e.target.value)} />
        <input aria-label={t('docs.fy')} placeholder="2026-27" className="input" value={fy} onChange={(e) => setFy(e.target.value)} />
        <select aria-label={t('docs.category')} className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t('docs.allCategories')}</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <ClientPicker label={t('docs.client')} value={client} onChange={setClient} />
      </div>
      <DocumentTable docs={docs.data?.items ?? []} loading={docs.isLoading} trashed={view === 'trash'} showClient />
    </div>
  );
}
