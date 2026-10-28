import { useMutation } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { ArrowLeft, UploadCloud } from 'lucide-react';
import { useState } from 'react';
import { multipart } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';

type Preview = Schemas['ImportPreview'];
const FIELDS = ['', 'name', 'tradeName', 'fileNo', 'entityType', 'pan', 'gstin', 'tan', 'cin', 'email', 'phone', 'address', 'city', 'state', 'pin', 'contactName', 'contactPhone', 'tags', 'status', 'notes'];

/** Upload → preview (editable mapping) → choose rows → commit → result. */
export function ImportWizard() {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const preview = useMutation({
    mutationFn: ({ f, mapping }: { f: File; mapping?: Record<string, string> }) =>
      unwrap(api.POST('/clients/import/preview', { body: multipart({ file: f, mapping: mapping ? JSON.stringify(mapping) : undefined }) })),
    onSuccess: (p: Preview) => setSelected(new Set(p.rows.filter((r) => r.data && !r.errors.length).map((r) => r.row))),
  });
  const commit = useMutation({
    mutationFn: (rows: Schemas['ClientCreate'][]) => unwrap(api.POST('/clients/import/commit', { body: { rows } })),
  });
  const p = preview.data;
  const pick = (f: File) => { setFile(f); commit.reset(); preview.mutate({ f }); };
  const chosen = p ? p.rows.filter((r) => r.data && !r.errors.length && selected.has(r.row)) : [];

  return (
    <div className="max-w-6xl space-y-3">
      <a href="#/clients" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> {t('nav.clients')}</a>
      <h1 className="text-xl font-semibold">{t('import.title')}</h1>
      {commit.data ? (
        <section className="card space-y-2 p-4" role="status">
          <p className="text-done">{t('import.created', { count: commit.data.created })}</p>
          {commit.data.failed.length > 0 && <ul className="text-overdue">{commit.data.failed.map((f, i) => <li key={i}>{t('import.failedRow', { n: (f.index ?? 0) + 1 })}: {f.error}</li>)}</ul>}
          <a className="btn" href="#/clients">{t('clients.backToList')}</a>
        </section>
      ) : (
        <>
          <label className="card flex cursor-pointer flex-col items-center gap-1 border-dashed p-6 text-center"
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) pick(f); }}>
            <UploadCloud size={22} aria-hidden className="text-muted" />
            <span>{file ? file.name : t('import.choose')}</span>
            <input type="file" accept=".xlsx,.csv" className="sr-only" aria-label={t('import.choose')} onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} />
          </label>
          <div aria-live="polite">
            {preview.isPending && <p className="text-muted">{t('common.loading')}</p>}
            {preview.isError && <p role="alert" className="text-overdue">{(preview.error as Error).message}</p>}
          </div>
          {p && file && (
            <>
              <div className="flex flex-wrap gap-2 text-sm">
                <span className="rounded bg-surface-alt px-2 py-0.5">{t('import.total', { count: p.summary.total })}</span>
                <span className="rounded bg-surface-alt px-2 py-0.5 text-done">{t('import.valid', { count: p.summary.valid })}</span>
                <span className="rounded bg-surface-alt px-2 py-0.5 text-overdue">{t('import.errors', { count: p.summary.withErrors })}</span>
                <span className="rounded bg-surface-alt px-2 py-0.5">{t('import.warnings', { count: p.summary.withWarnings })}</span>
              </div>
              <details className="card p-3" open>
                <summary className="font-medium">{t('import.mapping')}</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {p.headers.map((h) => (
                    <label key={h} className="flex items-center gap-2 text-sm"><span className="w-32 truncate" title={h}>{h}</span>
                      <select aria-label={t('import.mapFor', { header: h })} className="input" value={p.mapping[h] ?? ''}
                        onChange={(e) => preview.mutate({ f: file, mapping: { ...p.mapping, [h]: e.target.value } })}>
                        {FIELDS.map((f) => <option key={f} value={f}>{f || t('import.ignore')}</option>)}
                      </select></label>
                  ))}
                </div>
              </details>
              <div className="card max-h-[50vh] overflow-auto">
                <table className="table w-full">
                  <thead><tr><th><span className="sr-only">{t('import.include')}</span></th><th>#</th><th>{t('clients.name')}</th><th>PAN</th><th>{t('import.issues')}</th></tr></thead>
                  <tbody>
                    {p.rows.map((r) => {
                      const ok = !!r.data && !r.errors.length;
                      return (
                        <tr key={r.row}>
                          <td><input type="checkbox" aria-label={t('import.includeRow', { n: r.row })} disabled={!ok} checked={ok && selected.has(r.row)}
                            onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(r.row)) n.delete(r.row); else n.add(r.row); return n; })} /></td>
                          <td>{r.row}</td><td>{r.data?.name}</td><td className="font-mono">{r.data?.pan}</td>
                          <td>
                            {r.errors.map((e) => <span key={e} className="mr-1 rounded bg-surface-alt px-1.5 text-xs text-overdue">{e}</span>)}
                            {r.warnings.map((w) => <span key={w} className="mr-1 rounded bg-surface-alt px-1.5 text-xs text-due-soon">{w}</span>)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2">
                <button className="btn btn-primary" disabled={!chosen.length || commit.isPending} onClick={() => commit.mutate(chosen.map((r) => r.data!))}>{t('import.commit', { count: chosen.length })}</button>
                {commit.isError && <span role="alert" className="text-overdue">{(commit.error as Error).message}</span>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
