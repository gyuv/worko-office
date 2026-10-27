import { relativeTime } from '@worko/i18n';
import { Bell, CloudOff, Loader, RefreshCw, TriangleAlert, Wifi } from 'lucide-react';
import { useT } from '../lib/i18n';
import { useRoute } from '../lib/router';
import { dismissToast, syncNow, useSync } from '../lib/sync';
import { useNotifications } from '../screens/NotificationsScreen';

/** Always-visible sync status (spec §8): synced / syncing / offline, pending count, live-feed state. */
export function SyncIndicator() {
  const t = useT();
  const s = useSync();
  const label = s.status === 'syncing' ? t('sync.syncing') : s.status === 'offline' ? t('sync.offline') : s.status === 'error' ? t('sync.error') : s.status === 'synced' ? t('sync.synced') : t('sync.idle');
  const Icon = s.status === 'syncing' ? Loader : s.status === 'offline' ? CloudOff : s.status === 'error' ? TriangleAlert : s.connected ? Wifi : RefreshCw;
  const title = [
    s.pending ? t('sync.pending', { count: s.pending }) : null,
    s.lastSyncedAt ? t('sync.lastSynced', { when: relativeTime(new Date(s.lastSyncedAt)) }) : null,
    s.connected ? t('sync.live') : t('sync.notLive'),
  ].filter(Boolean).join(' · ');
  return (
    <button className="btn" onClick={() => void syncNow()} title={title} aria-label={`${label}. ${title}`}>
      <Icon size={14} aria-hidden className={s.status === 'syncing' ? 'animate-spin' : ''} />
      <span className="hidden lg:inline">{label}</span>
      {s.pending > 0 && <span className="rounded bg-surface-alt px-1 text-xs">{s.pending}</span>}
    </button>
  );
}

export function BellButton() {
  const t = useT();
  const go = useRoute((s) => s.go);
  const unread = useNotifications().filter((n) => !n.readAt).length;
  return (
    <button className="btn relative" aria-label={`${t('nav.notifications')}${unread ? `, ${t('notif.unread', { count: unread })}` : ''}`} onClick={() => go('notifications')}>
      <Bell size={14} aria-hidden />
      {unread > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-overdue px-1 text-center text-[10px] font-bold text-white">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}

/** In-app toasts for reminders that come due while the app is open (web; desktop uses native toasts). */
export function Toasts() {
  const toasts = useSync((s) => s.toasts);
  const go = useRoute((s) => s.go);
  const rejected = useSync((s) => s.rejected);
  const t = useT();
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-16 right-4 z-40 flex w-80 flex-col gap-2 md:bottom-4">
      {rejected.length > 0 && (
        <div role="alert" className="card pointer-events-auto p-3 text-sm">
          {t('sync.rejected', { count: rejected.length })}{' '}
          <button className="text-primary" onClick={() => useSync.setState({ rejected: [] })}>{t('common.close')}</button>
        </div>
      )}
      {toasts.map((n) => (
        <div key={n.id} className="card pointer-events-auto p-3 shadow-lg">
          <button className="block w-full text-left" onClick={() => { dismissToast(n.id); go('notifications'); }}>
            <div className="font-semibold">{n.title}</div>
            {n.body && <div className="text-sm text-muted">{n.body}</div>}
          </button>
          <button className="mt-1 text-xs text-muted" onClick={() => dismissToast(n.id)}>{t('common.close')}</button>
        </div>
      ))}
    </div>
  );
}
