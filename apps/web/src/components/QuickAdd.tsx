import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@worko/i18n';
import { AtSign, Building2, CalendarDays, CornerDownLeft, Flag, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDebounced } from '../lib/http';
import { useT } from '../lib/i18n';
import { useCan, useMe } from '../lib/me';
import { parseQuickTask } from '@worko/domain';
import { api, unwrap } from '../lib/session';
import { istDate } from '../screens/home-logic';
import { useRuleMessage, useUsers } from '../screens/tasks/shared';
import { toast } from './Toast';

export const openQuickAdd = () => dispatchEvent(new Event('worko:quickadd'));

const CHIP = {
  date: { icon: CalendarDays, cls: 'bg-primary-soft text-primary' },
  priority: { icon: Flag, cls: 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100' },
  person: { icon: AtSign, cls: 'bg-violet-100 text-violet-900 dark:bg-violet-900/50 dark:text-violet-100' },
  client: { icon: Building2, cls: 'bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100' },
} as const;

/** One-line task capture, opened with "N" anywhere or the header button. Stays open for rapid entry. */
export function QuickAdd() {
  const can = useCan();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== 'n' || e.ctrlKey || e.metaKey || e.altKey || !el || /INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable) return;
      if (document.querySelector('[role=dialog]')) return;
      e.preventDefault(); setOpen(true);
    };
    addEventListener('worko:quickadd', show); addEventListener('keydown', onKey);
    return () => { removeEventListener('worko:quickadd', show); removeEventListener('keydown', onKey); };
  }, []);
  if (!open || !can('tasks', 'create')) return null;
  return <QuickAddPanel onClose={() => setOpen(false)} />;
}

function QuickAddPanel({ onClose }: { onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe().data;
  const { users } = useUsers();
  const ruleMsg = useRuleMessage();
  const [text, setText] = useState('');
  const [added, setAdded] = useState<{ id: string; title: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const today = istDate(new Date());
  const parsed = useMemo(() => parseQuickTask(text, { today, people: users, me: me ? { id: me.id, name: me.name } : null }), [text, today, users, me]);
  const cq = useDebounced(parsed.clientQuery ?? '', 200);
  const client = useQuery({
    queryKey: ['clients', 'pick', cq], enabled: cq.length > 0, staleTime: 30_000,
    queryFn: () => unwrap(api.GET('/clients', { params: { query: { q: cq, limit: 1 } } })),
  });
  const match = parsed.clientQuery && cq === parsed.clientQuery ? client.data?.items[0] ?? null : null;

  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/tasks', { body: {
      title: parsed.title, client_id: match?.id ?? null, act_by: parsed.actBy, priority: parsed.priority,
      assignee_id: parsed.assignee?.id ?? me?.id ?? null,
    } })),
    onSuccess: (r) => {
      const title = parsed.title;
      setAdded((a) => [{ id: r.id, title }, ...a].slice(0, 5));
      setText('');
      void qc.invalidateQueries({ queryKey: ['dash'] }); void qc.invalidateQueries({ queryKey: ['tasks'] });
      toast({ text: t('quick.added', { title }), tone: 'ok', action: { label: t('quick.open'), run: () => { onClose(); location.hash = `#/tasks/${r.id}`; } } }, 4000);
      input.current?.focus();
    },
  });
  const blocked = !parsed.title || create.isPending || (!!parsed.clientQuery && !match && cq === parsed.clientQuery && !client.isFetching);

  useEffect(() => { input.current?.focus(); }, []);
  const label = (k: 'date' | 'priority' | 'person' | 'client', s: string) =>
    k === 'date' ? formatDate(s) : k === 'priority' ? t(`tasks.priority.${s}` as never) : k === 'client' ? (match?.name ?? s) : s;

  return (
    <div className="fade fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={t('quick.title')} className="glass pop w-full max-w-xl rounded-2xl p-3 shadow-2xl"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (!blocked) create.mutate(); }}>
          <Sparkles size={18} aria-hidden className="ml-2 shrink-0 text-primary" />
          <input ref={input} className="quick-input h-12 min-w-0 flex-1 border-0 bg-transparent text-[16px] shadow-none outline-none ring-0 placeholder:text-muted focus:outline-none focus-visible:outline-none" aria-label={t('quick.title')}
            placeholder={t('quick.placeholder')} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          <button className="btn btn-primary shrink-0" disabled={blocked} aria-label={t('quick.add')}><CornerDownLeft size={15} aria-hidden /> <span className="hidden sm:inline">{t('quick.add')}</span></button>
          <button type="button" className="icon-btn shrink-0" aria-label={t('common.close')} onClick={onClose}><X size={16} /></button>
        </form>
        <div className="flex min-h-[30px] flex-wrap items-center gap-1.5 px-2 pt-1" aria-live="polite">
          {parsed.tokens.map((tk, k) => {
            const C = CHIP[tk.kind];
            const missing = tk.kind === 'client' && !match && cq === parsed.clientQuery && !client.isFetching;
            return (
              <span key={`${tk.kind}-${tk.text}-${k}`} className={`chip-pop pill inline-flex items-center gap-1 ${missing ? 'bg-overdue/10 text-overdue' : C.cls}`}>
                <C.icon size={12} aria-hidden /> {missing ? t('quick.clientNotFound', { q: tk.text }) : label(tk.kind, tk.text)}
              </span>
            );
          })}
        </div>
        {create.isError && <p role="alert" className="px-2 pt-1 text-sm text-overdue">{ruleMsg(create.error)}</p>}
        {added.length > 0 && (
          <div className="mt-2 border-t border-border px-2 pt-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{t('quick.justAdded')}</div>
            <ul className="mt-1 space-y-0.5">
              {added.map((a) => (
                <li key={a.id} className="rise flex items-center gap-2 text-sm">
                  <span aria-hidden className="check-pop flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-fg">✓</span>
                  <a className="truncate hover:text-primary" href={`#/tasks/${a.id}`} onClick={onClose}>{a.title}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 px-2 pb-1 text-xs text-muted">
          <span className="flex-1">{t('quick.hint', { date: t('quick.datesEg') })}</span>
          <a href="#/tasks?new=1" className="font-medium text-primary hover:underline" onClick={onClose}>{t('quick.more')}</a>
        </div>
      </div>
    </div>
  );
}
