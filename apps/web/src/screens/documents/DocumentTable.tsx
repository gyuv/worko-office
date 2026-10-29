import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateTime } from '@worko/i18n';
import { Copy, Download, Eye, EyeOff, FilePlus2, History, Link2, RotateCcw, ScrollText, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { absoluteUrl, multipart } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { useCan } from '../../lib/me';
import { fmtSize, type Doc } from './DocumentsPanel';

async function download(id: string, version?: number) {
  const r = await unwrap(api.POST('/documents/{id}/download-url', { params: { path: { id } }, body: version ? { version } : {} }));
  window.open(absoluteUrl(r.url), '_blank', 'noopener');
}

export function DocumentTable({ docs, loading, trashed, showClient }: { docs: Doc[]; loading?: boolean; trashed?: boolean; showClient?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [dlg, setDlg] = useState<{ kind: 'versions' | 'share' | 'log'; doc: Doc } | null>(null);
  const [versionFor, setVersionFor] = useState<Doc | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['documents'] }); void qc.invalidateQueries({ queryKey: ['doc-tree'] }); };
  const trash = useMutation({ mutationFn: (id: string) => unwrap(api.DELETE('/documents/{id}', { params: { path: { id } } })), onSuccess: refresh });
  const can = useCan();
  const visible = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => unwrap(api.PATCH('/documents/{id}', { params: { path: { id } }, body: { clientVisible: on } })),
    onSuccess: refresh, onError: (e) => setErr((e as Error).message),
  });
  const restore = useMutation({ mutationFn: (id: string) => unwrap(api.POST('/documents/{id}/restore', { params: { path: { id } } })), onSuccess: refresh });
  const newVersion = useMutation({
    mutationFn: ({ doc, f }: { doc: Doc; f: File }) => unwrap(api.POST('/documents', { body: multipart({ file: f, documentId: doc.id, clientId: doc.clientId ?? undefined }) })),
    onSuccess: refresh, onError: (e) => setErr((e as Error).message),
  });

  if (loading) return <p className="text-muted" aria-live="polite">{t('common.loading')}</p>;
  if (!docs.length) return <p className="card p-6 text-muted">{trashed ? t('docs.trashEmpty') : t('docs.empty')}</p>;
  return (
    <div className="card overflow-auto">
      <p aria-live="polite" className="text-sm text-overdue">{err}</p>
      <table className="table w-full">
        <thead><tr><th>{t('docs.name')}</th>{showClient && <th>{t('docs.client')}</th>}<th>{t('docs.fy')}</th><th>{t('docs.category')}</th><th>{t('docs.size')}</th><th>{t('docs.updated')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td><div className="font-medium">{d.name}</div>{d.tags.length > 0 && <div className="text-xs text-muted">{d.tags.join(', ')}</div>}{d.currentVersion > 1 && <span className="text-xs text-muted">v{d.currentVersion}</span>}</td>
              {showClient && <td>{d.clientId ? <a className="underline" href={`#/clients/${d.clientId}`}>{d.clientName}</a> : '—'}</td>}
              <td>{d.fy}</td><td className="capitalize">{d.category}</td><td>{fmtSize(d.size)}</td><td>{formatDate(d.updatedAt)}</td>
              <td className="whitespace-nowrap text-right">
                {trashed
                  ? <button className="btn" onClick={() => restore.mutate(d.id)}><RotateCcw size={14} aria-hidden /> {t('docs.restore')}</button>
                  : <>
                    <IconBtn label={t('docs.download', { name: d.name })} onClick={() => void download(d.id).catch((e: Error) => setErr(e.message))}><Download size={14} /></IconBtn>
                    {d.clientId && can('documents', 'edit') && (() => { const on = !!(d as Doc & { clientVisible?: boolean }).clientVisible; return (
                      <IconBtn label={t(on ? 'p9.doc.hideFromClient' : 'p9.doc.showToClient', { name: d.name })} pressed={on} onClick={() => visible.mutate({ id: d.id, on: !on })}>{on ? <Eye size={14} /> : <EyeOff size={14} />}</IconBtn>); })()}
                    <IconBtn label={t('docs.newVersion', { name: d.name })} onClick={() => { setVersionFor(d); file.current?.click(); }}><FilePlus2 size={14} /></IconBtn>
                    <IconBtn label={t('docs.versions', { name: d.name })} onClick={() => setDlg({ kind: 'versions', doc: d })}><History size={14} /></IconBtn>
                    <IconBtn label={t('docs.share', { name: d.name })} onClick={() => setDlg({ kind: 'share', doc: d })}><Link2 size={14} /></IconBtn>
                    <IconBtn label={t('docs.accessLog', { name: d.name })} onClick={() => setDlg({ kind: 'log', doc: d })}><ScrollText size={14} /></IconBtn>
                    <IconBtn label={t('docs.trashIt', { name: d.name })} onClick={() => trash.mutate(d.id)} danger><Trash2 size={14} /></IconBtn>
                  </>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <input ref={file} type="file" hidden aria-hidden tabIndex={-1} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && versionFor) newVersion.mutate({ doc: versionFor, f }); }} />
      {dlg?.kind === 'versions' && <VersionsDialog doc={dlg.doc} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'share' && <ShareDialog doc={dlg.doc} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'log' && <AccessLogDialog doc={dlg.doc} onClose={() => setDlg(null)} />}
    </div>
  );
}

function IconBtn({ label, onClick, children, danger, pressed }: { label: string; onClick(): void; children: React.ReactNode; danger?: boolean; pressed?: boolean }) {
  return <button className={`rounded p-1.5 hover:bg-surface-alt ${danger ? 'text-overdue' : pressed ? 'text-primary' : 'text-muted hover:text-fg'}`} aria-label={label} aria-pressed={pressed} title={label} onClick={onClick}>{children}</button>;
}

function VersionsDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const t = useT();
  const q = useQuery({ queryKey: ['doc-versions', doc.id], queryFn: () => unwrap(api.GET('/documents/{id}/versions', { params: { path: { id: doc.id } } })) });
  return (
    <Dialog title={t('docs.versionsOf', { name: doc.name })} onClose={onClose}>
      <ul className="divide-y divide-border">
        {(q.data ?? []).map((v) => (
          <li key={v.version} className="flex items-center gap-2 py-1.5">
            <span className="w-10 font-medium">v{v.version}</span>
            <span className="flex-1 text-sm text-muted">{formatDateTime(v.createdAt)} · {fmtSize(v.size)}{v.uploadedBy ? ` · ${v.uploadedBy}` : ''}{v.note ? ` · ${v.note}` : ''}</span>
            <button className="btn" onClick={() => void download(doc.id, v.version)}><Download size={14} aria-hidden /> {t('docs.downloadShort')}</button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function ShareDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [hours, setHours] = useState(72);
  const [password, setPassword] = useState('');
  const [maxDl, setMaxDl] = useState('');
  const [copied, setCopied] = useState(false);
  const shares = useQuery({ queryKey: ['shares', doc.id], queryFn: () => unwrap(api.GET('/documents/{id}/shares', { params: { path: { id: doc.id } } })) });
  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/documents/{id}/shares', { params: { path: { id: doc.id } }, body: { expiresInHours: hours, ...(password ? { password } : {}), ...(maxDl ? { maxDownloads: Number(maxDl) } : {}) } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shares', doc.id] }),
  });
  const revoke = useMutation({ mutationFn: (id: string) => unwrap(api.DELETE('/shares/{id}', { params: { path: { id } } })), onSuccess: () => void qc.invalidateQueries({ queryKey: ['shares', doc.id] }) });
  const url = create.data ? absoluteUrl(create.data.url) : '';
  return (
    <Dialog title={t('docs.shareTitle', { name: doc.name })} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label={t('docs.expiryHours')}><input className="input" type="number" min={1} max={720} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></Field>
          <Field label={t('docs.sharePassword')}><input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label={t('docs.maxDownloads')}><input className="input" type="number" min={1} value={maxDl} onChange={(e) => setMaxDl(e.target.value)} /></Field>
        </div>
        <button className="btn btn-primary" disabled={create.isPending || hours < 1}>{t('docs.createLink')}</button>
      </form>
      {url && (
        <div className="mt-3 flex gap-2" aria-live="polite">
          <input readOnly aria-label={t('docs.link')} className="input font-mono text-xs" value={url} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}><Copy size={14} aria-hidden /> {copied ? t('vault.copiedShort') : t('docs.copy')}</button>
        </div>
      )}
      {!!shares.data?.length && (
        <ul className="mt-3 divide-y divide-border text-sm">
          {shares.data.map((s) => (
            <li key={s.id} className="flex items-center gap-2 py-1">
              <span className="flex-1">{t('docs.shareRow', { expires: formatDateTime(s.expiresAt), downloads: s.downloads, max: s.maxDownloads ?? '∞' })}{s.passwordProtected ? ` · ${t('docs.passwordProtected')}` : ''}{s.revokedAt ? ` · ${t('docs.revoked')}` : ''}</span>
              {!s.revokedAt && <button className="btn btn-danger" onClick={() => revoke.mutate(s.id)}>{t('docs.revoke')}</button>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function AccessLogDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const t = useT();
  const q = useQuery({ queryKey: ['doc-log', doc.id], queryFn: () => unwrap(api.GET('/documents/{id}/access-log', { params: { path: { id: doc.id } } })) });
  return (
    <Dialog title={t('docs.accessLogOf', { name: doc.name })} onClose={onClose}>
      {q.data && !q.data.length && <p className="text-muted">{t('docs.noAccess')}</p>}
      <ul className="divide-y divide-border text-sm">
        {(q.data ?? []).map((a, i) => <li key={i} className="py-1">{formatDateTime(a.at)} · {a.action} · {a.userName ?? (a.shareLinkId ? t('docs.viaShare') : '—')}{a.ip ? ` · ${a.ip}` : ''}</li>)}
      </ul>
    </Dialog>
  );
}
