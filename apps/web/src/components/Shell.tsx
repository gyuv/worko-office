import { useEffect, type ReactNode } from 'react';
import { Moon, Search, Sun, WifiOff } from 'lucide-react';
import { useT } from '../lib/i18n';
import { useMe, useCan } from '../lib/me';
import { useRoute } from '../lib/router';
import { useTheme } from '../lib/theme';
import { useOnline } from '../lib/useOnline';
import { CommandPalette } from './CommandPalette';
import { BellButton, SyncIndicator, Toasts } from './SyncIndicator';
import { NAV } from './nav';
import { StepUpDialog } from './StepUpDialog';
import { TimerWidget } from '../screens/time/TimerWidget';

export function Shell({ children, onSignOut }: { children: ReactNode; onSignOut(): void }) {
  const t = useT();
  const { route, go } = useRoute();
  const me = useMe().data;
  const can = useCan();
  const online = useOnline();
  const { pref, toggle } = useTheme();

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

  return (
    <div className="flex h-full">
      <nav aria-label="Main" className="hidden w-52 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="px-4 py-3">
          <div className="text-lg font-semibold">{t('app.name')}</div>
          <div className="truncate text-xs text-muted">{me?.firmName}</div>
        </div>
        <ul className="flex-1 space-y-0.5 px-2">
          {NAV.filter((n) => !n.perm || can(...n.perm)).map((n) => (
            <li key={n.route}>
              <a href={`#/${n.route}`} aria-current={route === n.route ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${route === n.route ? 'bg-surface-alt font-medium' : 'text-muted hover:bg-surface-alt hover:text-fg'}`}>
                <n.icon size={16} aria-hidden /> {t(n.label)}
              </a>
            </li>
          ))}
        </ul>
        <div className="border-t border-border p-3 text-sm">
          <div className="truncate font-medium">{me?.name}</div>
          <button className="text-muted hover:text-fg" onClick={onSignOut}>{t('common.signOut')}</button>
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
          <button className="btn flex-1 justify-start text-muted md:max-w-md" onClick={() => dispatchEvent(new Event('worko:palette'))}>
            <Search size={14} aria-hidden /> {t('palette.placeholder')} <kbd className="ml-auto text-xs">Ctrl K</kbd>
          </button>
          <TimerWidget />
          <SyncIndicator />
          <BellButton />
          <button className="btn" aria-label={t('palette.toggleTheme')} onClick={toggle}>{pref === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</button>
        </header>
        {!online && (
          <div role="status" className="flex items-center gap-2 bg-surface-alt px-4 py-1.5 text-sm"><WifiOff size={14} aria-hidden /> {t('common.offline')}</div>
        )}
        <main className="min-h-0 flex-1 overflow-auto p-4">{children}</main>
        <nav aria-label="Main" className="grid grid-cols-5 border-t border-border bg-surface md:hidden">
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
