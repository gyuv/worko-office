import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PORTALS, type Portal } from '@worko/domain';
import { relativeTime } from '@worko/i18n';
import { Copy, Eye, EyeOff, KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { useT } from '../../lib/i18n';
import { api, unwrap } from '../../lib/session';
import { StepUpCancelled, withStepUp } from '../../lib/stepup';

const CLEAR_MS = 30_000;
type Plain = { id: string; username: string; password: string };

/** Vault credentials for one client. Plaintext lives only in component state, never in the query cache. */
export function CredentialsTab({ clientId }: { clientId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['secrets', clientId], queryFn: () => unwrap(api.GET('/vault/secrets', { params: { query: { clientId } } })) });
  const [dialog, setDialog] = useState<{ mode: 'add' } | { mode: 'rotate'; id: string; label: string } | null>(null);
  const [plain, setPlain] = useState<Plain | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { if (!plain) return; const id = setTimeout(() => setPlain(null), CLEAR_MS); return () => clearTimeout(id); }, [plain]);
  useEffect(() => () => setPlain(null), []);

  const del = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/vault/secrets/{id}', { params: { path: { id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['secrets', clientId] }),
  });
  const reveal = (id: string, purpose: 'view' | 'copy') =>
    withStepUp(() => unwrap(api.POST('/vault/secrets/{id}/reveal', { params: { path: { id } }, body: { purpose } })));

  const onView = async (id: string) => {
    setMsg('');
    try { const r = await reveal(id, 'view'); setPlain({ id, username: r.username, password: r.password }); }
    catch (e) { if (!(e instanceof StepUpCancelled)) setMsg(t('client360.revealFailed')); }
  };
  const onCopy = async (id: string) => {
    setMsg('');
    try {
      const r = await reveal(id, 'copy');
      await navigator.clipboard.writeText(r.password);
      setMsg(t('vault.copied'));
      // Best effort: only clear if the clipboard still holds our value (reading may be denied).
      setTimeout(() => {
        void (async () => {
          try { if ((await navigator.clipboard.readText()) !== r.password) return; } catch { /* unreadable: clear anyway */ }
          await navigator.clipboard.writeText('').catch(() => undefined);
        })();
      }, CLEAR_MS);
    } catch (e) { if (!(e instanceof StepUpCancelled)) setMsg(t('vault.copyFailed')); }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{t('vault.help')}</p>
        <button className="btn btn-primary" onClick={() => setDialog({ mode: 'add' })}><Plus size={14} aria-hidden /> {t('vault.add')}</button>
      </div>
      <p aria-live="polite" className="text-sm text-muted">{msg}</p>
      {list.data && !list.data.length && <p className="card p-6 text-muted">{t('vault.empty')}</p>}
      <ul className="card divide-y divide-border">
        {(list.data ?? []).map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
            <KeyRound size={16} aria-hidden className="text-muted" />
            <span className="rounded bg-surface-alt px-1.5 py-0.5 text-xs font-semibold">{s.portal}</span>
            <div className="min-w-40 flex-1">
              <div className="font-medium">{s.label}</div>
              <div className="font-mono text-xs text-muted">
                {plain?.id === s.id ? <>{plain.username} · <span data-testid="secret-password">{plain.password}</span></> : s.usernameHint}
              </div>
              <div className="text-xs text-muted">{s.rotatedAt ? t('vault.rotated', { when: relativeTime(s.rotatedAt) }) : null}</div>
            </div>
            <div className="flex flex-wrap gap-1">
              {s.loginUrl && <a className="btn" href={s.loginUrl} target="_blank" rel="noreferrer">{t('vault.open')}</a>}
              {plain?.id === s.id
                ? <button className="btn" onClick={() => setPlain(null)}><EyeOff size={14} aria-hidden /> {t('client360.hide')}</button>
                : <button className="btn" onClick={() => void onView(s.id)}><Eye size={14} aria-hidden /> {t('client360.reveal')}</button>}
              <button className="btn" onClick={() => void onCopy(s.id)} aria-label={t('vault.copyPassword', { label: s.label })}><Copy size={14} aria-hidden /></button>
              <button className="btn" onClick={() => setDialog({ mode: 'rotate', id: s.id, label: s.label })} aria-label={t('vault.rotate', { label: s.label })}><RotateCw size={14} aria-hidden /></button>
              <button className="btn btn-danger" onClick={() => confirm(t('vault.deleteConfirm', { label: s.label })) && del.mutate(s.id)} aria-label={t('vault.delete', { label: s.label })}><Trash2 size={14} aria-hidden /></button>
            </div>
          </li>
        ))}
      </ul>
      {dialog && <SecretDialog clientId={clientId} target={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function SecretDialog({ clientId, target, onClose }: { clientId: string; target: { mode: 'add' } | { mode: 'rotate'; id: string; label: string }; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [f, setF] = useState({ portal: 'GST' as Portal, label: '', loginUrl: '', username: '', password: '' });
  const save = useMutation({
    mutationFn: () => target.mode === 'add'
      ? unwrap(api.POST('/clients/{id}/secrets', { params: { path: { id: clientId } }, body: { portal: f.portal, label: f.label.trim(), loginUrl: f.loginUrl || null, username: f.username, password: f.password } }))
      : unwrap(api.PATCH('/vault/secrets/{id}', { params: { path: { id: target.id } }, body: { password: f.password, ...(f.username ? { username: f.username } : {}) } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['secrets', clientId] }); void qc.invalidateQueries({ queryKey: ['client', clientId] }); onClose(); },
  });
  const add = target.mode === 'add';
  return (
    <Dialog title={add ? t('vault.add') : t('vault.rotate', { label: target.label })} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} autoComplete="off">
        {add && <>
          <Field label={t('vault.portal')}>
            <select className="input" value={f.portal} onChange={(e) => setF({ ...f, portal: e.target.value as Portal })}>{PORTALS.map((p) => <option key={p}>{p}</option>)}</select>
          </Field>
          <Field label={t('vault.label')}><input className="input" required value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
          <Field label={t('vault.loginUrl')}><input className="input" type="url" value={f.loginUrl} onChange={(e) => setF({ ...f, loginUrl: e.target.value })} /></Field>
        </>}
        <Field label={t('vault.username')}><input className="input" autoComplete="off" required={add} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label={t('auth.password')}><input className="input" type="password" autoComplete="new-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        {save.isError && <p role="alert" className="text-overdue">{(save.error as Error).message}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={save.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}
