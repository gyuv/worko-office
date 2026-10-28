import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useT } from '../lib/i18n';

/** Modal dialog: focuses the first field, traps Tab, closes on Escape, restores focus on close. */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  const t = useT();
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = box.current;
    const first = el?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea,[data-autofocus]') ?? el?.querySelector<HTMLElement>('button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); }
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const [a, z] = [f[0]!, f[f.length - 1]!];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    el?.addEventListener('keydown', onKey);
    return () => { el?.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-auto bg-black/30 p-4 pt-[8vh]" onMouseDown={onClose}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={id} onMouseDown={(e) => e.stopPropagation()}
        className={`card w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} shadow-xl`}>
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h2 id={id} className="font-semibold">{title}</h2>
          <button type="button" className="rounded p-1 text-muted hover:text-fg" aria-label={t('common.close')} onClick={onClose}><X size={16} /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, error, hint }: { label: string; children: ReactNode; error?: string | null; hint?: ReactNode }) {
  return (
    <div>
      <label className="block">
        <span className="label">{label}</span>
        {children}
      </label>
      {error && <span role="alert" className="mt-0.5 block text-xs text-overdue">{error}</span>}
      {!error && hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
    </div>
  );
}

export function Tabs<K extends string>({ tabs, value, onChange, label }: { tabs: Array<[K, string]>; value: K; onChange(k: K): void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b border-border"
      onKeyDown={(e) => {
        const i = tabs.findIndex(([k]) => k === value);
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) { const n = tabs[(i + d + tabs.length) % tabs.length]![0]; onChange(n); (e.currentTarget.querySelector(`[data-k="${n}"]`) as HTMLElement | null)?.focus(); }
      }}>
      {tabs.map(([k, l]) => (
        <button key={k} data-k={k} role="tab" type="button" aria-selected={value === k} tabIndex={value === k ? 0 : -1} onClick={() => onChange(k)}
          className={`-mb-px border-b-2 px-3 py-1.5 ${value === k ? 'border-primary font-medium' : 'border-transparent text-muted hover:text-fg'}`}>{l}</button>
      ))}
    </div>
  );
}
