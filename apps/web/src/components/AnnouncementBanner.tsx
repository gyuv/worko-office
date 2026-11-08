import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info, Megaphone, X } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../lib/i18n';
import { api } from '../lib/session';

type Ann = { id: string; title: string; body: string; level: 'info' | 'warning' | 'critical' };
const KEY = 'worko.dismissedAnnouncements';
const readDismissed = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]; } catch { return []; } };

/** Platform announcements for this firm, shown above every screen; each can be dismissed (remembered on this device). */
export function AnnouncementBanner() {
  const t = useT();
  const [dismissed, setDismissed] = useState(readDismissed);
  const q = useQuery({ queryKey: ['announcements'], refetchInterval: 5 * 60_000, queryFn: async () => ((await api.GET('/announcements')).data ?? []) as Ann[] });
  const list = (q.data ?? []).filter((a) => !dismissed.includes(a.id));
  if (!list.length) return null;
  const close = (id: string) => { const next = [...dismissed, id].slice(-100); setDismissed(next); try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ } };
  const tone = { info: 'bg-primary-soft text-fg', warning: 'bg-amber-100 text-amber-950 dark:bg-amber-900/50 dark:text-amber-50', critical: 'bg-red-600 text-white' } as const;
  return (
    <div className="mx-3 mt-2 space-y-2 md:ml-0">
      {list.map((a) => {
        const Icon = a.level === 'info' ? Info : a.level === 'warning' ? AlertTriangle : Megaphone;
        return (
          <div key={a.id} role={a.level === 'critical' ? 'alert' : 'status'} className={`rise flex items-start gap-3 rounded-2xl px-4 py-2.5 shadow-sm ${tone[a.level]}`}>
            <Icon size={18} aria-hidden className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1"><div className="font-semibold">{a.title}</div>{a.body && <div className="text-sm opacity-90">{a.body}</div>}</div>
            <button className="rounded-full p-1 opacity-80 hover:opacity-100" aria-label={t('common.close')} onClick={() => close(a.id)}><X size={16} /></button>
          </div>
        );
      })}
    </div>
  );
}
