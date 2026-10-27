import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@worko/i18n';
import { Laptop, Monitor, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n';
import { useMe } from '../lib/me';
import { api, unwrap } from '../lib/session';

const icons = { web: Monitor, desktop: Laptop, android: Smartphone } as const;

export function SecurityScreen() {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe().data;
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => unwrap(api.GET('/auth/sessions')) });
  const act = useMutation({
    mutationFn: ({ id, wipe }: { id: string; wipe: boolean }) =>
      unwrap(api.POST(wipe ? '/auth/sessions/{id}/wipe' : '/auth/sessions/{id}/revoke', { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  const active = (sessions.data ?? []).filter((s) => !s.revokedAt);

  return (
    <div className="max-w-3xl space-y-6">
      <section className="card">
        <h2 className="border-b border-border px-4 py-2 font-semibold">{t('security.sessions')}</h2>
        <ul>
          {active.map((s) => {
            const Icon = icons[s.platform as keyof typeof icons] ?? Monitor;
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 last:border-0">
                <Icon size={18} aria-hidden />
                <div className="min-w-48 flex-1">
                  <div className="font-medium">{s.label ?? s.platform} {s.current && <span className="text-xs text-done">· {t('security.thisDevice')}</span>}</div>
                  <div className="text-xs text-muted">{t('security.lastSeen', { when: s.lastSeenAt ? relativeTime(s.lastSeenAt) : t('common.never') })} · {s.ip}</div>
                </div>
                {!s.current && <div className="flex gap-2">
                  <button className="btn" onClick={() => act.mutate({ id: s.id, wipe: false })}>{t('security.revoke')}</button>
                  <button className="btn btn-danger" onClick={() => confirm(t('security.wipeConfirm', { device: s.label ?? s.platform })) && act.mutate({ id: s.id, wipe: true })}>{t('security.wipe')}</button>
                </div>}
              </li>
            );
          })}
        </ul>
      </section>
      <section className="card p-4">
        <h2 className="mb-2 font-semibold">{t('security.twoFactor')}: {me?.totpEnabled ? t('security.twoFactorOn') : t('security.twoFactorOff')}</h2>
        {!me?.totpEnabled && <TotpSetup />}
      </section>
      <ExtensionPairing firm={me?.firmSlug ?? ''} />
    </div>
  );
}

function TotpSetup() {
  const t = useT();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const setup = useMutation({ mutationFn: () => unwrap(api.POST('/auth/totp/setup')) });
  const enable = useMutation({
    mutationFn: () => unwrap(api.POST('/auth/totp/enable', { body: { code } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  if (!setup.data) return <button className="btn btn-primary" onClick={() => setup.mutate()}>{t('security.enable2fa')}</button>;
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}>
      <p className="text-muted">{t('security.scan')}</p>
      <code className="block select-all rounded bg-surface-alt p-2 font-mono">{setup.data.secret}</code>
      <div className="flex gap-2">
        <input aria-label={t('auth.totp')} className="input max-w-40" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
        <button className="btn btn-primary" disabled={enable.isPending}>{t('common.save')}</button>
      </div>
      {enable.isError && <p role="alert" className="text-overdue">{t('auth.invalid')}</p>}
    </form>
  );
}

/** One-time pairing code for the browser extension (vault autofill). */
function ExtensionPairing({ firm }: { firm: string }) {
  const t = useT();
  const pair = useMutation({ mutationFn: () => unwrap(api.POST('/vault/extension/pair-code')) });
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!pair.data) return;
    const end = Date.now() + pair.data.expiresInSeconds * 1000;
    const tick = () => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pair.data]);
  return (
    <section className="card space-y-2 p-4">
      <h2 className="font-semibold">{t('ext.title')}</h2>
      <p className="text-muted">{t('ext.help')}</p>
      {pair.data && left > 0 ? (
        <div className="space-y-1" aria-live="polite">
          <div>{t('ext.firm')}: <code className="font-mono">{firm}</code></div>
          <div>{t('ext.code')}: <code className="select-all rounded bg-surface-alt px-2 py-1 font-mono text-lg tracking-widest">{pair.data.code}</code></div>
          <div className="text-sm text-muted">{t('ext.expires', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}</div>
        </div>
      ) : (
        <>
          {pair.data && <p role="status" className="text-sm text-muted">{t('ext.expired')}</p>}
          <button className="btn btn-primary" disabled={pair.isPending} onClick={() => pair.mutate()}>{t('ext.connect')}</button>
        </>
      )}
      {pair.isError && <p role="alert" className="text-overdue">{t('common.error')}</p>}
    </section>
  );
}
