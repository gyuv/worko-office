import { create } from 'zustand';
import { useT } from '../lib/i18n';

export type Toast = { id: number; text: string; tone?: 'error' | 'ok'; action?: { label: string; run(): void } };
type S = { toasts: Toast[]; push(t: Omit<Toast, 'id'>, ms?: number): number; dismiss(id: number): void };
let seq = 0;

/** Screen-level toasts (server rule errors, bulk-edit undo). */
export const useToasts = create<S>((set, get) => ({
  toasts: [],
  push(t, ms = 8000) {
    const id = ++seq;
    set({ toasts: [...get().toasts, { ...t, id }] });
    if (ms > 0) setTimeout(() => get().dismiss(id), ms);
    return id;
  },
  dismiss(id) { set({ toasts: get().toasts.filter((x) => x.id !== id) }); },
}));
export const toast = (t: Omit<Toast, 'id'>, ms?: number) => useToasts.getState().push(t, ms);

export function ToastHost() {
  const t = useT();
  const { toasts, dismiss } = useToasts();
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-16 left-1/2 z-50 flex w-96 max-w-[90vw] -translate-x-1/2 flex-col gap-2 md:bottom-4">
      {toasts.map((x) => (
        <div key={x.id} role={x.tone === 'error' ? 'alert' : 'status'} className={`card pointer-events-auto flex items-center gap-2 p-3 text-sm shadow-lg ${x.tone === 'error' ? 'border-overdue' : ''}`}>
          <span className={`flex-1 ${x.tone === 'error' ? 'text-overdue' : ''}`}>{x.text}</span>
          {x.action && <button className="btn" onClick={() => { dismiss(x.id); x.action!.run(); }}>{x.action.label}</button>}
          <button className="text-xs text-muted" onClick={() => dismiss(x.id)}>{t('common.close')}</button>
        </div>
      ))}
    </div>
  );
}
