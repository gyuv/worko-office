import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { ChevronDown, ChevronRight, Folder, UploadCloud } from 'lucide-react';
import { useId, useRef, useState, type DragEvent } from 'react';
import { Field } from '../../components/Dialog';
import { currentFy, errStatus, multipart } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { DocumentTable } from './DocumentTable';

export const CATEGORIES = ['kyc', 'itr', 'gst', 'tds', 'audit', 'roc', 'bank', 'notice', 'invoice', 'agreement', 'other'] as const;

/** Client 360 → Documents: FY/category tree, drag-and-drop upload, list with versions/shares/trash. */
export function DocumentsPanel({ clientId }: { clientId: string }) {
  const t = useT();
  const [sel, setSel] = useState<{ fy?: string; category?: string }>({});
  const [trashed, setTrashed] = useState(false);
  const tree = useQuery({ queryKey: ['doc-tree', clientId], queryFn: () => unwrap(api.GET('/clients/{id}/document-tree', { params: { path: { id: clientId } } })) });
  const docs = useQuery({
    queryKey: ['documents', { clientId, ...sel, trashed }],
    queryFn: () => unwrap(api.GET('/documents', { params: { query: { clientId, fy: sel.fy, category: sel.category, trashed: trashed ? 'true' : undefined } } })),
  });
  const byFy = new Map<string, Array<{ category: string; count: number }>>();
  for (const n of tree.data ?? []) byFy.set(n.fy, [...(byFy.get(n.fy) ?? []), { category: n.category, count: n.count }]);
  const fys = [...byFy.keys()].sort().reverse();

  return (
    <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
      <nav aria-label={t('docs.folders')} className="card p-2 text-sm">
        <button className={`w-full rounded px-2 py-1 text-left ${!sel.fy && !trashed ? 'bg-surface-alt font-medium' : ''}`} onClick={() => { setSel({}); setTrashed(false); }}>{t('docs.all')}</button>
        <ul>{fys.map((fy) => <FyNode key={fy} fy={fy} cats={byFy.get(fy)!} sel={sel} onSelect={(s) => { setSel(s); setTrashed(false); }} />)}</ul>
        <button className={`mt-1 w-full rounded px-2 py-1 text-left ${trashed ? 'bg-surface-alt font-medium' : 'text-muted'}`} onClick={() => { setTrashed(true); setSel({}); }}>{t('docs.trash')}</button>
      </nav>
      <div className="min-w-0 space-y-3">
        {!trashed && <UploadZone clientId={clientId} defaults={sel} />}
        <DocumentTable docs={docs.data?.items ?? []} loading={docs.isLoading} trashed={trashed} />
      </div>
    </div>
  );
}

function FyNode({ fy, cats, sel, onSelect }: { fy: string; cats: Array<{ category: string; count: number }>; sel: { fy?: string; category?: string }; onSelect(s: { fy?: string; category?: string }): void }) {
  const [open, setOpen] = useState(true);
  const total = cats.reduce((a, c) => a + c.count, 0);
  return (
    <li>
      <div className="flex items-center">
        <button className="p-1 text-muted" aria-expanded={open} aria-label={fy} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        <button className={`flex-1 rounded px-1 py-1 text-left ${sel.fy === fy && !sel.category ? 'bg-surface-alt font-medium' : ''}`} onClick={() => onSelect({ fy })}>FY {fy} <span className="text-muted">({total})</span></button>
      </div>
      {open && <ul className="ml-5">{cats.map((c) => (
        <li key={c.category}><button className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left ${sel.fy === fy && sel.category === c.category ? 'bg-surface-alt font-medium' : ''}`} onClick={() => onSelect({ fy, category: c.category })}>
          <Folder size={12} aria-hidden /> <span className="capitalize">{c.category}</span> <span className="text-muted">({c.count})</span></button></li>
      ))}</ul>}
    </li>
  );
}

/** Drop files here (from the OS file manager, incl. Explorer into Electron) or pick them. */
export function UploadZone({ clientId, defaults }: { clientId: string; defaults: { fy?: string; category?: string } }) {
  const t = useT();
  const qc = useQueryClient();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [fy, setFy] = useState(defaults.fy ?? currentFy());
  const [category, setCategory] = useState(defaults.category ?? 'other');
  const [tags, setTags] = useState('');
  const [status, setStatus] = useState<{ ok: number; errors: string[] } | null>(null);
  const up = useMutation({
    mutationFn: async (files: File[]) => {
      const res = { ok: 0, errors: [] as string[] };
      for (const file of files) {
        try {
          await unwrap(api.POST('/documents', { body: multipart({ file, clientId, fy, category, tags: tags || undefined }) }));
          res.ok++;
        } catch (e) {
          const s = errStatus(e);
          res.errors.push(`${file.name}: ${s === 422 ? t('docs.virus') : s === 400 ? t('docs.typeNotAllowed') : (e as Error).message}`);
        }
      }
      return res;
    },
    onSuccess: (r) => { setStatus(r); void qc.invalidateQueries({ queryKey: ['documents'] }); void qc.invalidateQueries({ queryKey: ['doc-tree', clientId] }); void qc.invalidateQueries({ queryKey: ['client', clientId] }); },
  });
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); const files = [...e.dataTransfer.files]; if (files.length) up.mutate(files); };

  return (
    <div className="card p-3">
      <div className="mb-2 grid gap-2 sm:grid-cols-3">
        <Field label={t('docs.fy')}><input className="input" pattern="\d{4}-\d{2}" value={fy} onChange={(e) => setFy(e.target.value)} /></Field>
        <Field label={t('docs.category')}>
          <input className="input" list={`${id}-cats`} value={category} onChange={(e) => setCategory(e.target.value)} />
          <datalist id={`${id}-cats`}>{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label={t('clients.tags')}><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('clients.tagsHint')} /></Field>
      </div>
      <div onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        data-testid="dropzone"
        className={`flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-4 py-6 text-center ${over ? 'border-primary bg-surface-alt' : 'border-border'}`}>
        <UploadCloud size={22} aria-hidden className="text-muted" />
        <span>{t('docs.dropHere')}</span>
        <button type="button" className="btn" onClick={() => input.current?.click()}>{t('docs.choose')}</button>
        <input ref={input} type="file" multiple hidden aria-label={t('docs.choose')} onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) up.mutate(f); }} />
      </div>
      <div aria-live="polite" className="mt-1 text-sm">
        {up.isPending && <span className="text-muted">{t('docs.uploading')}</span>}
        {status && status.ok > 0 && <span className="text-done">{t('docs.uploaded', { count: status.ok })}</span>}
        {status?.errors.map((e) => <div key={e} role="alert" className="text-overdue">{e}</div>)}
      </div>
    </div>
  );
}

export type Doc = Schemas['Document'];
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
