import { useEffect, useMemo, useRef, useState } from 'react';
import { Moon, LogOut, type LucideIcon } from 'lucide-react';
import { useT } from '../lib/i18n';
import { useRoute } from '../lib/router';
import { useTheme } from '../lib/theme';
import { useCan } from '../lib/me';
import { NAV } from './nav';

type Cmd = { id: string; label: string; hint?: string; run(): void; icon: LucideIcon };

/** Ctrl/Cmd+K palette. Grows into global search (clients, tasks, documents…) as modules land. */
export function CommandPalette({ onSignOut }: { onSignOut(): void }) {
  const t = useT();
  const go = useRoute((s) => s.go);
  const toggleTheme = useTheme((s) => s.toggle);
  const can = useCan();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === 'Escape') setOpen(false);
    };
    const onOpen = () => setOpen(true);
    addEventListener('keydown', onKey); addEventListener('worko:palette', onOpen);
    return () => { removeEventListener('keydown', onKey); removeEventListener('worko:palette', onOpen); };
  }, []);
  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => input.current?.focus()); } }, [open]);

  const cmds = useMemo<Cmd[]>(() => [
    ...NAV.filter((n) => !n.perm || can(...n.perm)).map((n) => ({ id: n.route, label: t('palette.goto', { page: t(n.label) }), hint: n.shortcut, icon: n.icon, run: () => go(n.route) })),
    { id: 'theme', label: t('palette.toggleTheme'), icon: Moon, run: toggleTheme },
    { id: 'signout', label: t('common.signOut'), icon: LogOut, run: onSignOut },
  ], [t, go, toggleTheme, onSignOut, can]);

  const list = cmds.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  if (!open) return null;
  const run = (c?: Cmd) => { if (c) { setOpen(false); c.run(); } };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[12vh]" onMouseDown={() => setOpen(false)}>
      <div role="dialog" aria-modal="true" aria-label={t('palette.placeholder')} className="card w-full max-w-lg overflow-hidden shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} className="w-full border-b border-border bg-surface px-4 py-3 text-lg outline-none" placeholder={t('palette.placeholder')}
          role="combobox" aria-expanded="true" aria-controls="palette-list" value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, list.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === 'Enter') run(list[sel]);
          }} />
        <ul id="palette-list" role="listbox" className="max-h-80 overflow-auto py-1">
          {list.length === 0 && <li className="px-4 py-3 text-muted">{t('palette.empty')}</li>}
          {list.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => run(c)}
              className={`flex cursor-pointer items-center gap-3 px-4 py-2 ${i === sel ? 'bg-surface-alt' : ''}`}>
              <c.icon size={16} /> <span className="flex-1">{c.label}</span>
              {c.hint && <kbd className="text-xs text-muted">{c.hint}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
