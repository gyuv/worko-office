import { useEffect, useState, type ReactNode } from 'react';
import { LogOut, Mail, Moon, Search, Smartphone, Sun, WifiOff } from 'lucide-react';
import { useT } from '../lib/i18n';
import { useMe, useCan, useFeature, useIntegration } from '../lib/me';
import { useRoute, type Route } from '../lib/router';
import { useTheme } from '../lib/theme';
import { usePrefs } from '../lib/prefs';
import { useOnline } from '../lib/useOnline';
import { AnnouncementBanner } from './AnnouncementBanner';
import { CommandPalette } from './CommandPalette';
import { BellButton, SyncIndicator, Toasts } from './SyncIndicator';
import { NAV, type NavItem } from './nav';
import { StepUpDialog } from './StepUpDialog';
import { TimerWidget } from '../screens/time/TimerWidget';

/** Sidebar sections: everything is "Menu" except the account/admin pages under "General". */
const GENERAL: Route[] = ['notifications', 'team', 'appearance', 'security', 'settings', 'audit'];

export const initials = (name: string | undefined) =>
  (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '·';

/** Browser "install app" prompt (Chrome/Edge/Android), captured once so the sidebar card can offer it. */
type InstallEvent = Event & { prompt(): Promise<void> };
function useInstallPrompt() {
  const [ev, setEv] = useState<InstallEvent | null>(null);
  useEffect(() => {
    const on = (e: Event) => { e.preventDefault(); setEv(e as InstallEvent); };
    addEventListener('beforeinstallprompt', on);
    return () => removeEventListener('beforeinstallprompt', on);
  }, []);
  return ev ? async () => { await ev.prompt(); setEv(null); } : null;
}

function NavLink({ n, active }: { n: NavItem; active: boolean }) {
  const t = useT();
  return (
    <li className="relative">
      {active && <span aria-hidden className="absolute -left-3 top-1.5 h-6 w-1 rounded-r-full bg-primary" />}
      <a href={`#/${n.route}`} aria-current={active ? 'page' : undefined}
        className={`nav-link flex items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors duration-200 ${active ? 'bg-primary-soft font-semibold text-fg' : 'text-muted hover:bg-surface-alt hover:text-fg'}`}>
        <n.icon size={17} aria-hidden className={active ? 'text-primary' : ''} /> <span className="truncate">{t(n.label)}</span>
      </a>
    </li>
  );
}

export function Shell({ children, onSignOut }: { children: ReactNode; onSignOut(): void }) {
  const t = useT();
  const { route, go } = useRoute();
  const me = useMe().data;
  const can = useCan();
  const online = useOnline();
  const { pref } = useTheme();
  const prefs = usePrefs((x) => x.prefs);
  const toggle = () => { const dark = pref === 'dark' || (pref === 'system' && matchMedia?.('(prefers-color-scheme: dark)').matches); void usePrefs.getState().update({ theme: dark ? 'light' : 'dark' }); };
  const install = useInstallPrompt();

  // "g then x" navigation shortcuts (desktop keyboard-first).
  useEffect(() => {
    let pending = false; let timer: ReturnType<typeof setTimeout>;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey) return;
      if (pending) {
        const hit = NAV.find((n) => n.shortcut === `g ${e.key}`);
        if (hit) go(hit.route);
        pending = false;
      } else if (e.key === 'g') { pending = true; clearTimeout(timer); timer = setTimeout(() => (pending = false), 1000); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [go]);

  const hidden = new Set(prefs.hiddenModules ?? []);
  const feature = useFeature();
  const integration = useIntegration();
  const visible = NAV.filter((n) => (!n.perm || can(...n.perm)) && (!n.feature || feature(n.feature)) && (!n.integration || integration(n.integration))
    && (n.route === 'home' || n.route === 'appearance' || !hidden.has(n.route)));
  const menu = visible.filter((n) => !GENERAL.includes(n.route));
  const general = visible.filter((n) => GENERAL.includes(n.route));

  return (
    <div className="flex h-full">
      <nav aria-label="Main" className="hidden w-60 shrink-0 flex-col p-3 md:flex">
        <div className="glass flex h-full flex-col rounded-2xl">
          <div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
            <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full border-[3px] border-primary">
              <span className="breathe h-3 w-3 rounded-full bg-primary" />
            </span>
            <div className="min-w-0">
              <div className="text-lg font-bold leading-tight">{t('app.name')}</div>
              <div className="truncate text-xs text-muted">{me?.firmName}</div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            <div className="px-2.5 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t('shell.menu')}</div>
            <ul className="space-y-0.5">{menu.map((n) => <NavLink key={n.route} n={n} active={route === n.route} />)}</ul>
            <div className="px-2.5 pb-1.5 pt-5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{t('shell.general')}</div>
            <ul className="space-y-0.5">
              {general.map((n) => <NavLink key={n.route} n={n} active={route === n.route} />)}
              <li>
                <button className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-muted transition-colors hover:bg-surface-alt hover:text-fg" onClick={onSignOut}>
                  <LogOut size={17} aria-hidden /> {t('common.signOut')}
                </button>
              </li>
            </ul>
          </div>
          <div className="p-3">
            <div className="relative overflow-hidden rounded-2xl bg-primary-strong p-4 text-white">
              <svg aria-hidden className="drift pointer-events-none absolute inset-0 h-full w-[200%] opacity-30" viewBox="0 0 400 100" preserveAspectRatio="none">
                {[0, 1, 2, 3, 4, 5].map((i) => <path key={i} d={`M0 ${30 + i * 12} Q50 ${10 + i * 12} 100 ${30 + i * 12} T200 ${30 + i * 12} T300 ${30 + i * 12} T400 ${30 + i * 12}`} fill="none" stroke="#4ade80" strokeWidth="1" />)}
              </svg>
              <Smartphone size={18} aria-hidden className="relative" />
              <div className="relative mt-2 font-semibold leading-snug">{t('shell.app.title')}</div>
              <div className="relative mt-0.5 text-xs text-white/70">{t('shell.app.body')}</div>
              {install && <button className="relative mt-3 w-full rounded-full bg-primary py-1.5 text-sm font-semibold text-primary-fg hover:opacity-90" onClick={() => void install()}>{t('shell.app.install')}</button>}
            </div>
          </div>
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass m-3 mb-0 flex items-center gap-2 rounded-2xl px-3 py-2.5 md:ml-0">
          <button className="flex h-10 flex-1 items-center gap-2 rounded-full bg-surface-alt px-4 text-left text-muted transition-colors hover:text-fg md:max-w-md" onClick={() => dispatchEvent(new Event('worko:palette'))}>
            <Search size={16} aria-hidden className="shrink-0" /> <span className="truncate">{t('palette.placeholder')}</span>
            <kbd className="ml-auto hidden rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-semibold sm:block">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden md:contents"><TimerWidget /><SyncIndicator /></span>
            <a className="icon-btn hidden sm:inline-flex" href="#/chat" aria-label={t('p7.nav.chat')}><Mail size={16} aria-hidden /></a>
            <BellButton />
            <button className="icon-btn hidden sm:inline-flex" aria-label={t('palette.toggleTheme')} onClick={toggle}>{pref === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
            <a href="#/security" className="ml-1 hidden items-center gap-2.5 rounded-full py-0.5 pl-0.5 pr-2 hover:bg-surface-alt lg:flex">
              <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent text-sm font-bold text-white">{initials(me?.name)}</span>
              <span className="min-w-0 leading-tight"><span className="block truncate font-semibold">{me?.name}</span><span className="block truncate text-xs text-muted">{me?.email}</span></span>
            </a>
          </div>
        </header>
        <AnnouncementBanner />
        {!online && (
          <div role="status" className="mx-3 mt-2 flex items-center gap-2 rounded-xl bg-surface-alt px-4 py-1.5 text-sm"><WifiOff size={14} aria-hidden /> {t('common.offline')}</div>
        )}
        <main className="min-h-0 flex-1 overflow-auto p-3 md:pl-0"><div key={route} className="page">{children}</div></main>
        <nav aria-label="Main" className="glass grid grid-cols-5 rounded-t-2xl md:hidden">
          {NAV.filter((n) => ['home', 'tasks', 'clients', 'notifications', 'security'].includes(n.route) && (!n.perm || can(...n.perm))).map((n) => (
            <a key={n.route} href={`#/${n.route}`} className={`flex flex-col items-center py-2 text-xs ${route === n.route ? 'text-primary' : 'text-muted'}`}>
              <n.icon size={18} aria-hidden /> {t(n.label)}
            </a>
          ))}
        </nav>
      </div>
      <CommandPalette onSignOut={onSignOut} />
      <Toasts />
      <StepUpDialog />
    </div>
  );
}
