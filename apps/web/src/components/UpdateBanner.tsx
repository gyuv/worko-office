import { Download, RefreshCw, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../lib/i18n';
import { desktop, type DesktopUpdateState } from '../lib/platform';

const isMac = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/** Desktop: follow the main-process updater (checked at every start). Web: poll /version.json for a newer deploy. */
export function useAppUpdate() {
  const bridge = desktop()?.updates;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [webNew, setWebNew] = useState(false);
  useEffect(() => {
    if (bridge) { void bridge.get().then(setState).catch(() => undefined); return bridge.onState(setState); }
    if (desktop() || import.meta.env.DEV || import.meta.env.MODE === 'test') return;
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
        const v = (await r.json()) as { build?: string };
        if (!stop && v.build && v.build !== __BUILD_ID__) setWebNew(true);
      } catch { /* offline or not deployed with version.json */ }
    };
    void check();
    const id = setInterval(check, 15 * 60_000);
    const onFocus = () => void check();
    addEventListener('focus', onFocus);
    return () => { stop = true; clearInterval(id); removeEventListener('focus', onFocus); };
  }, [bridge]);
  const check = useCallback(async () => (bridge ? setState(await bridge.check()) : undefined), [bridge]);
  return { bridge, state, webNew, check };
}

export function UpdateBanner() {
  const t = useT();
  const { bridge, state, webNew } = useAppUpdate();
  const [hidden, setHidden] = useState<string | null>(null);
  const key = webNew ? 'web' : state?.phase === 'ready' || state?.phase === 'downloading' ? `${state.phase}:${state.info.version}` : null;
  if (!key || hidden === key) return null;

  let body: React.ReactNode; let action: React.ReactNode = null;
  if (webNew) {
    body = t('update.webNew');
    action = <button className="btn btn-primary py-1.5 text-sm" onClick={() => location.reload()}><RefreshCw size={14} aria-hidden /> {t('update.reload')}</button>;
  } else if (state?.phase === 'downloading') {
    body = (
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <span className="truncate">{t('update.downloading', { version: state.info.version, progress: state.progress })}</span>
        <span className="hidden h-1.5 w-40 overflow-hidden rounded-full bg-surface-alt sm:block" aria-hidden>
          <span className="block h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${state.progress}%` }} />
        </span>
      </span>
    );
  } else if (state?.phase === 'ready') {
    body = <span><b>{t('update.ready', { version: state.info.version })}</b> <span className="text-muted">{isMac() ? t('update.readyMac') : t('update.readyHint')}</span></span>;
    action = <button className="btn btn-primary py-1.5 text-sm" onClick={() => void bridge?.install()}><Download size={14} aria-hidden /> {isMac() ? t('update.openInstaller') : t('update.restart')}</button>;
  }
  return (
    <div role="status" className="float-up glass mx-3 mt-2 flex items-center gap-3 rounded-xl px-4 py-2 text-sm">
      <Sparkles size={16} aria-hidden className="shrink-0 text-primary" />
      <div className="min-w-0 flex-1">{body}</div>
      {action}
      <button className="icon-btn h-8 w-8" aria-label={t('update.later')} title={t('update.later')} onClick={() => setHidden(key)}><X size={14} /></button>
    </div>
  );
}

/** "About & updates" card: version + manual check (desktop) or reload (web). */
export function AboutUpdates() {
  const t = useT();
  const { bridge, state, webNew, check } = useAppUpdate();
  const [busy, setBusy] = useState(false);
  const version = state?.current ?? __APP_VERSION__;
  const msg = !state ? null : state.phase === 'current' ? t('update.current') : state.phase === 'error' ? t('update.failed')
    : state.phase === 'checking' ? t('update.checking') : state.phase === 'downloading' ? t('update.downloading', { version: state.info.version, progress: state.progress })
    : state.phase === 'ready' ? t('update.ready', { version: state.info.version }) : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="pill bg-primary-soft text-primary">{t('update.version', { version })}</span>
        {bridge ? (
          <button className="btn" disabled={busy || state?.phase === 'checking' || state?.phase === 'downloading'} onClick={async () => { setBusy(true); try { await check(); } finally { setBusy(false); } }}>
            <RefreshCw size={14} aria-hidden className={busy ? 'animate-spin' : ''} /> {t('update.check')}
          </button>
        ) : webNew ? <button className="btn btn-primary" onClick={() => location.reload()}><RefreshCw size={14} aria-hidden /> {t('update.reload')}</button> : null}
        {state?.phase === 'ready' && <button className="btn btn-primary" onClick={() => void bridge?.install()}><Download size={14} aria-hidden /> {isMac() ? t('update.openInstaller') : t('update.restart')}</button>}
      </div>
      {msg && <p className="text-sm text-muted" role="status">{msg}</p>}
      <p className="text-sm text-muted">{t('update.auto')}</p>
    </div>
  );
}
