import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Download, FolderPlus, Plus, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatNumber } from '@worko/i18n';
import { useDebounced, fetchBlob, saveBlob } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { clientsView, useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { Client360 } from './Client360';
import { GroupDialog } from './GroupDialog';
import { ImportWizard } from './ImportWizard';
import { NewClientDialog } from './NewClientDialog';
import { useEntityLabel } from './labels';

export function ClientsRoute() {
  const params = useRoute((s) => s.params);
  const v = clientsView(params);
  if (v.view === 'import') return <ImportWizard />;
  if (v.view === 'detail') return <Client360 key={v.id} id={v.id} />;
  return <ClientsScreen />;
}

const PAGE = 200;
const ROW = 36;
type Status = '' | 'active' | 'inactive' | 'prospect';

export function ClientsScreen() {
  const t = useT();
  const can = useCan();
  const go = useRoute((s) => s.go);
  const entity = useEntityLabel();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<Status>('active');
  const [groupId, setGroupId] = useState('');
  const [dialog, setDialog] = useState<'new' | 'group' | null>(null);
  const [exportError, setExportError] = useState(false);
  useEffect(() => { const o = () => setDialog('new'); addEventListener('worko:new-client', o); return () => removeEventListener('worko:new-client', o); }, []);
  const dq = useDebounced(q.trim(), 300);
  const [limit, setLimit] = useState(PAGE);

  const groups = useQuery({ queryKey: ['client-groups'], queryFn: () => unwrap(api.GET('/client-groups')) });
  const list = useQuery({
    queryKey: ['clients', 'list', dq, status, groupId, limit],
    queryFn: () => unwrap(api.GET('/clients', { params: { query: { q: dq || undefined, status: status || undefined, groupId: groupId || undefined, limit, offset: 0 } } })),
    placeholderData: (prev) => prev,
  });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  const scroller = useRef<HTMLDivElement>(null);
  const rv = useVirtualizer({ count: items.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 12 });
  const vItems = rv.getVirtualItems();
  // Fetch more as the user nears the end (server-side paging keeps 100k-client firms smooth).
  const lastIndex = vItems[vItems.length - 1]?.index ?? -1;
  const fetching = list.isFetching;
  useEffect(() => {
    if (lastIndex >= items.length - 20 && items.length < total && !fetching) setLimit((l) => (l <= items.length ? l + PAGE : l));
  }, [lastIndex, items.length, total, fetching]);

  const exportAs = async (format: 'csv' | 'xlsx') => {
    setExportError(false);
    try { const { blob, filename } = await fetchBlob(`/clients/export?format=${format}`); saveBlob(blob, filename ?? `clients.${format}`); }
    catch { setExportError(true); }
  };

  const cols = 'grid grid-cols-[minmax(12rem,2fr)_6rem_7rem_11rem_9rem_6rem] gap-2';
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold">{t('nav.clients')}</h1>
        <span className="text-sm text-muted" aria-live="polite">{t('clients.count', { count: formatNumber(total) })}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {can('clients', 'create') && <button className="btn" onClick={() => go('clients/import')}><Upload size={14} aria-hidden /> {t('clients.import')}</button>}
          {can('clients', 'export') && <>
            <button className="btn" onClick={() => void exportAs('csv')}><Download size={14} aria-hidden /> CSV</button>
            <button className="btn" onClick={() => void exportAs('xlsx')}><Download size={14} aria-hidden /> XLSX</button>
          </>}
          {can('clients', 'edit') && <button className="btn" onClick={() => setDialog('group')}><FolderPlus size={14} aria-hidden /> {t('clients.newGroup')}</button>}
          {can('clients', 'create') && <button className="btn btn-primary" onClick={() => setDialog('new')}><Plus size={14} aria-hidden /> {t('clients.new')}</button>}
        </div>
      </div>
      {exportError && <p role="alert" className="text-overdue">{t('clients.exportFailed')}</p>}
      <div className="flex flex-wrap gap-2">
        <input type="search" aria-label={t('common.search')} className="input max-w-sm" placeholder={t('clients.searchPlaceholder')} value={q}
          onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} />
        <select aria-label={t('clients.status')} className="input w-36" value={status} onChange={(e) => { setStatus(e.target.value as Status); setLimit(PAGE); }}>
          <option value="">{t('clients.allStatuses')}</option>
          <option value="active">{t('clients.status.active')}</option>
          <option value="inactive">{t('clients.status.inactive')}</option>
          <option value="prospect">{t('clients.status.prospect')}</option>
        </select>
        <select aria-label={t('clients.group')} className="input w-48" value={groupId} onChange={(e) => { setGroupId(e.target.value); setLimit(PAGE); }}>
          <option value="">{t('clients.allGroups')}</option>
          {(groups.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} ({g.clientCount})</option>)}
        </select>
      </div>
      <div className="card flex min-h-0 flex-1 flex-col overflow-hidden" role="table" aria-label={t('nav.clients')} aria-rowcount={total}>
        <div role="row" className={`${cols} border-b border-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted`}>
          <span role="columnheader">{t('clients.name')}</span><span role="columnheader">{t('clients.fileNo')}</span><span role="columnheader">PAN</span>
          <span role="columnheader">GSTIN</span><span role="columnheader">{t('clients.entityType')}</span><span role="columnheader">{t('clients.status')}</span>
        </div>
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto" style={{ minHeight: 200 }}>
          {list.isSuccess && items.length === 0 && <p className="p-6 text-muted">{t('clients.empty')}</p>}
          <div style={{ height: rv.getTotalSize(), position: 'relative' }}>
            {vItems.map((vi) => {
              const c = items[vi.index]!;
              return (
                <a key={c.id} role="row" aria-rowindex={vi.index + 1} href={`#/clients/${c.id}`}
                  className={`${cols} absolute left-0 right-0 items-center border-b border-border px-3 hover:bg-surface-alt`}
                  style={{ top: vi.start, height: ROW }}>
                  <span role="cell" className="truncate font-medium">{c.name}{c.tradeName && <span className="ml-1 text-muted">({c.tradeName})</span>}</span>
                  <span role="cell" className="truncate text-muted">{c.fileNo}</span>
                  <span role="cell" className="font-mono text-xs">{c.pan}</span>
                  <span role="cell" className="font-mono text-xs">{c.primaryGstin}</span>
                  <span role="cell" className="truncate">{entity(c.entityType)}</span>
                  <span role="cell" className="capitalize text-muted">{c.status}</span>
                </a>
              );
            })}
          </div>
        </div>
      </div>
      {dialog === 'new' && <NewClientDialog onClose={() => setDialog(null)} onCreated={(id) => { setDialog(null); go(`clients/${id}`); }} />}
      {dialog === 'group' && <GroupDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
