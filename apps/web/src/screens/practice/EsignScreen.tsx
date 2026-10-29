import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PRODUCT } from '@worko/domain';
import { formatDateTime } from '@worko/i18n';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { errCode, errStatus } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { isUuid, useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { MockBadge } from '../billing/shared';
import { useUsers } from '../tasks/shared';
import { as, body, openDoc, useClientContacts, useClientDocs, useP8Error, useP8Label, type EsignDetail, type EsignRow } from './api';
import { esignSummary, unverifiedProvider } from './logic';

export function EsignScreen() {
  const t = useT();
  const can = useCan();
  const label = useP8Label();
  const params = useRoute((s) => s.params);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['p8', 'esign', status], enabled: can('documents', 'view'),
    queryFn: () => as<{ total: number; items: EsignRow[] }>(api.GET('/esign/requests', { params: { query: (status ? { status } : {}) as never } })) });
  if (!can('documents', 'view')) return <p className="card p-6 text-muted">{t('p8.noAccess')}</p>;
  if (isUuid(params[0])) return <EsignView id={params[0]} />;
  return (
    <div className="space-y-3">
      <header className="flex items-center gap-2"><h1 className="text-xl font-semibold">{t('p8.nav.esign')}</h1>
        {can('documents', 'edit') && <button className="btn btn-primary ml-auto" onClick={() => setCreating(true)}><Plus size={14} aria-hidden /> {t('p8.es.new')}</button>}</header>
      <Field label={t('p8.f.status')}><select className="input w-48" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('p8.all')}</option>
        {['in_progress', 'completed', 'partially_failed', 'cancelled'].map((s) => <option key={s} value={s}>{label('es', s)}</option>)}</select></Field>
      {q.data && !q.data.items.length && <p className="card p-6 text-muted">{t('p8.es.none')}</p>}
      {!!q.data?.items.length && <div className="card overflow-auto"><table className="table w-full" aria-label={t('p8.nav.esign')}>
        <thead><tr><th>{t('p8.f.title')}</th><th>{t('p8.es.items')}</th><th>{t('p8.es.mode')}</th><th>{t('p8.es.provider')}</th><th>{t('p8.f.status')}</th><th>{t('p8.es.created')}</th></tr></thead>
        <tbody>{q.data.items.map((r) => (
          <tr key={r.id}><td><a className="hover:underline" href={`#/esign/${r.id}`}>{r.title}</a>{r.bulk && <span className="ml-1 rounded bg-surface-alt px-1 text-xs">{t('p8.es.bulk')}</span>}</td>
            <td>{r.visibleItems === r.items ? r.items : t('p8.es.visibleOf', { visible: r.visibleItems, total: r.items })}</td><td>{label('mode', r.mode)}</td>
            <td>{r.provider} {unverifiedProvider(r.provider) && <MockBadge />}</td><td>{label('es', r.status)}</td><td>{formatDateTime(r.createdAt)}</td></tr>
        ))}</tbody>
      </table></div>}
      {creating && <NewEsign onClose={() => setCreating(false)} />}
    </div>
  );
}

type SignerPick = { kind: 'contact'; contactId: string; name: string } | { kind: 'staff'; userId: string; name: string };
type ItemDraft = { documentId: string; name: string; clientName: string; version: number; maxVersion: number; signers: SignerPick[] };

/** Build items one client at a time (bulk = many documents, possibly many clients); signers per item, order = list order when sequential. */
function NewEsign({ onClose }: { onClose(): void }) {
  const t = useT();
  const err = useP8Error();
  const qc = useQueryClient();
  const go = useRoute((s) => s.go);
  const { users } = useUsers();
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'parallel' | 'sequential'>('parallel');
  const [client, setClient] = useState<PickedClient | null>(null);
  const docs = (useClientDocs(client?.id ?? null).data ?? []).filter((d) => d.mime === 'application/pdf');
  const contacts = (useClientContacts(client?.id ?? null).data?.contacts ?? []) as Array<{ id: string; name: string }>;
  const [pickDocs, setPickDocs] = useState<string[]>([]);
  const [pickSigners, setPickSigners] = useState<SignerPick[]>([]);
  const [items, setItems] = useState<ItemDraft[]>([]);
  const toggleSigner = (s: SignerPick, on: boolean) => setPickSigners(on ? [...pickSigners, s] : pickSigners.filter((x) => (x.kind === 'contact' ? x.contactId : x.userId) !== (s.kind === 'contact' ? s.contactId : s.userId)));
  const addItems = () => {
    const add = docs.filter((d) => pickDocs.includes(d.id) && !items.some((i) => i.documentId === d.id))
      .map((d) => ({ documentId: d.id, name: d.name, clientName: client!.name, version: d.currentVersion, maxVersion: d.currentVersion, signers: pickSigners }));
    setItems([...items, ...add]); setPickDocs([]);
  };
  const m = useMutation({
    mutationFn: () => as<{ id: string; status: string; items: Array<{ status: string; error: string | null }> }>(api.POST('/esign/requests', { body: body({ title: title.trim(), mode,
      items: items.map((i) => ({ documentId: i.documentId, version: i.version, signers: i.signers.map((s, k) => ({ ...(s.kind === 'contact' ? { kind: 'contact', contactId: s.contactId } : { kind: 'staff', userId: s.userId }), ...(mode === 'sequential' ? { order: k + 1 } : {}) })) })) }) })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['p8', 'esign'] });
      const s = esignSummary(r.items);
      toast({ text: t('p8.es.sentSummary', { total: s.total, failed: s.failed }), tone: s.failed ? 'error' : 'ok' }, 5000);
      go(`esign/${r.id}`);
    },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const isSel = (s: SignerPick) => pickSigners.some((x) => (x.kind === 'contact' ? x.contactId : x.userId) === (s.kind === 'contact' ? s.contactId : s.userId));
  return (
    <Dialog title={t('p8.es.new')} onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (title.trim() && items.length && items.every((i) => i.signers.length)) m.mutate(); }}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('p8.f.title')}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
          <Field label={t('p8.es.mode')}><select className="input" value={mode} onChange={(e) => setMode(e.target.value as 'parallel')}><option value="parallel">{t('p8.mode.parallel')}</option><option value="sequential">{t('p8.mode.sequential')}</option></select></Field>
        </div>
        <fieldset className="space-y-2 rounded border border-border p-2"><legend className="px-1 text-sm">{t('p8.es.addDocs')}</legend>
          <ClientPicker label={t('p8.f.client')} value={client} onChange={(c) => { setClient(c); setPickDocs([]); setPickSigners([]); }} />
          {client && <div className="grid gap-2 sm:grid-cols-2">
            <div><span className="label">{t('p8.es.pdfs')}</span>{!docs.length && <p className="text-sm text-muted">{t('p8.es.noPdfs')}</p>}
              {docs.map((d) => <label key={d.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pickDocs.includes(d.id)} onChange={(e) => setPickDocs(e.target.checked ? [...pickDocs, d.id] : pickDocs.filter((x) => x !== d.id))} /> {d.name} <span className="text-xs text-muted">v{d.currentVersion}</span></label>)}</div>
            <div><span className="label">{t('p8.es.signers')}</span>
              {contacts.map((c) => { const s: SignerPick = { kind: 'contact', contactId: c.id, name: c.name }; return <label key={c.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isSel(s)} onChange={(e) => toggleSigner(s, e.target.checked)} /> {c.name}</label>; })}
              {users.map((u) => { const s: SignerPick = { kind: 'staff', userId: u.id, name: u.name }; return <label key={u.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isSel(s)} onChange={(e) => toggleSigner(s, e.target.checked)} /> {u.name} <span className="text-xs text-muted">({t('p8.dsc.staff')})</span></label>; })}
              {mode === 'sequential' && pickSigners.length > 1 && <p className="text-xs text-muted">{t('p8.es.order')}: {pickSigners.map((s) => s.name).join(' → ')}</p>}</div>
          </div>}
          <button type="button" className="btn" disabled={!pickDocs.length || !pickSigners.length} onClick={addItems}><Plus size={14} aria-hidden /> {t('p8.es.addItems', { count: pickDocs.length })}</button>
        </fieldset>
        {!!items.length && <table className="table w-full" aria-label={t('p8.es.items')}>
          <thead><tr><th>{t('p8.es.document')}</th><th>{t('p8.es.version')}</th><th>{t('p8.es.signers')}</th><th /></tr></thead>
          <tbody>{items.map((i, k) => (
            <tr key={i.documentId}><td>{i.name}<span className="block text-xs text-muted">{i.clientName}</span></td>
              <td><select className="input w-20" aria-label={t('p8.es.version')} value={i.version} onChange={(e) => setItems(items.map((x, j) => (j === k ? { ...x, version: Number(e.target.value) } : x)))}>
                {Array.from({ length: i.maxVersion }, (_, n) => i.maxVersion - n).map((v) => <option key={v} value={v}>v{v}</option>)}</select></td>
              <td className="text-sm">{i.signers.map((s) => s.name).join(mode === 'sequential' ? ' → ' : ', ')}</td>
              <td><button type="button" className="btn" aria-label={t('p8.remove')} onClick={() => setItems(items.filter((_, j) => j !== k))}><Trash2 size={14} /></button></td></tr>
          ))}</tbody>
        </table>}
        {items.length > 1 && <p className="text-sm text-muted">{t('p8.es.bulkNote', { count: items.length })}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!title.trim() || !items.length || m.isPending}>{t('p8.es.send')}</button></div>
      </form>
    </Dialog>
  );
}

function EsignView({ id }: { id: string }) {
  const t = useT();
  const can = useCan();
  const err = useP8Error();
  const label = useP8Label();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p8', 'esign', 'one', id], retry: false, queryFn: () => as<EsignDetail>(api.GET('/esign/requests/{id}', { params: { path: { id } } })) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['p8', 'esign'] });
  const retry = useMutation({ mutationFn: () => as(api.POST('/esign/requests/{id}/retry', { params: { path: { id } } })), onSuccess: refresh, onError: (e) => toast({ text: err(e), tone: 'error' }) });
  const cancel = useMutation({ mutationFn: () => as(api.POST('/esign/requests/{id}/cancel', { params: { path: { id } } })), onSuccess: refresh, onError: (e) => toast({ text: err(e), tone: 'error' }) });
  if (q.isError) return <div role="alert" className="card p-6">{t('p8.notFound')} <a className="underline" href="#/esign">{t('p8.nav.esign')}</a></div>;
  const r = q.data;
  if (!r) return <p className="text-muted">{t('common.loading')}</p>;
  const s = esignSummary(r.items);
  const editable = can('documents', 'edit');
  return (
    <div className="space-y-3">
      <a href="#/esign" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> {t('p8.nav.esign')}</a>
      <header className="flex flex-wrap items-center gap-2"><h1 className="flex-1 text-xl font-semibold">{r.title}</h1>
        <span>{label('es', r.status)}</span><span className="text-sm">{r.provider}</span>{unverifiedProvider(r.provider) && <MockBadge />}</header>
      {unverifiedProvider(r.provider) && <p className="text-sm text-due-soon">{t('p8.es.mockNote')}</p>}
      <p role="status" className="card p-2 text-sm" data-testid="esign-summary">{t('p8.es.summary', { signed: s.signed, total: s.total, failed: s.failed, open: s.open, signers: s.signersSigned, signersTotal: s.signersTotal })}</p>
      {editable && <div className="flex gap-2">
        {s.failed > 0 && r.status !== 'cancelled' && <button className="btn" onClick={() => retry.mutate()} disabled={retry.isPending}>{t('p8.es.retry', { count: s.failed })}</button>}
        {!['completed', 'cancelled'].includes(r.status) && <button className="btn btn-danger" onClick={() => confirm(t('p8.es.cancelConfirm')) && cancel.mutate()}>{t('p8.es.cancel')}</button>}
      </div>}
      <ul className="space-y-2">{r.items.map((i) => (
        <li key={i.id} className="card space-y-1 p-3" data-testid={`item-${i.documentId}`}>
          <div className="flex flex-wrap items-center gap-2"><span className="flex-1 font-medium">{i.documentName} <span className="text-xs text-muted">v{i.documentVersion}</span></span>
            <span className={i.status === 'failed' ? 'text-overdue' : i.status === 'signed' ? 'text-done' : ''}>{label('ei', i.status)}</span></div>
          {i.error && <p className="text-xs text-overdue">{i.error}</p>}
          <ol className="text-sm">{i.signers.map((g) => <li key={g.id}>{r.mode === 'sequential' ? `${g.ord}. ` : ''}{g.name} <span className="text-xs text-muted">({label('skind', g.kind)})</span> — {label('ss', g.status)}
            {g.signedAt && <span className="text-xs text-muted"> · {formatDateTime(g.signedAt)}</span>}{g.maskedId && <span className="font-mono text-xs"> · {g.maskedId}</span>}</li>)}</ol>
          {i.status === 'signed' && <div className="flex gap-2">
            {i.signedVersion && <button className="btn" onClick={() => void openDoc(i.documentId, i.signedVersion!)}>{t('p8.es.downloadSigned', { v: i.signedVersion })}</button>}
            {i.certificateDocumentId && <button className="btn" onClick={() => void openDoc(i.certificateDocumentId!)}>{t('p8.es.certificate')}</button>}</div>}
        </li>
      ))}</ul>
    </div>
  );
}

/** Logged-out signer page: `#/esign/sign/<token>`. Never touches the staff session. */
export function PublicEsign({ token }: { token: string }) {
  const t = useT();
  const [proceeded, setProceeded] = useState(false);
  const q = useQuery({ queryKey: ['esign-link', token], retry: false, queryFn: () => as<{ documentName: string; signerName: string; signingUrl: string | null }>(api.GET('/esign/sign/{token}', { params: { path: { token } } })) });
  const mock = !!q.data?.signingUrl && /\.mock\.invalid\//.test(q.data.signingUrl);
  return (
    <main className="mx-auto min-h-screen max-w-xl space-y-4 bg-bg p-4 text-fg">
      <h1 className="text-xl font-semibold">{t('p8.pub.title')}</h1>
      {q.isError && <p role="alert" className="card p-4">{errCode(q.error) === 'not_your_turn' || errStatus(q.error) === 409 ? t('p8.pub.notYourTurn') : t('p8.pub.invalid')}</p>}
      {!q.data && !q.isError && <p className="text-muted">{t('common.loading')}</p>}
      {q.data && <section className="card space-y-2 p-4" data-testid="esign-public">
        <p>{t('p8.pub.hello', { name: q.data.signerName })}</p>
        <p>{t('p8.pub.doc')}: <b>{q.data.documentName}</b></p>
        {mock && <p className="text-sm text-due-soon"><MockBadge /> {t('p8.pub.mock')}</p>}
        {!proceeded ? <button className="btn btn-primary" disabled={!q.data.signingUrl} onClick={() => { if (mock) setProceeded(true); else window.location.assign(q.data!.signingUrl!); }}>{t('p8.pub.proceed')}</button>
          : <p role="status" data-testid="esign-mock-done" className="text-sm">{t('p8.pub.mockDone')}</p>}
        <p className="text-xs text-muted">{t('p8.pub.privacy')}</p>
      </section>}
      <footer className="pt-6 text-center text-xs text-muted">{PRODUCT.name}</footer>
    </main>
  );
}
