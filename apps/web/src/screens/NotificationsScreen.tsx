import { useMutation, useQuery } from '@tanstack/react-query';
import { CATEGORIES, type Prefs } from '@worko/notify';
import { relativeTime } from '@worko/i18n';

import { AlertOctagon, Bell, BellOff, Check, CheckCheck, Clock, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../lib/i18n';
import { desktop } from '../lib/platform';
import { api, unwrap } from '../lib/session';
import { ReportExportDownload } from './reports/Schedules';
import { getEngine, getStore, syncNow, toReminder, useSync } from '../lib/sync';
import type { LocalReminder } from '@worko/notify';

/** Notifications from the local synced store — works offline and updates live across devices. */
export function useNotifications() {
  const v = useSync((s) => s.versions.notification ?? 0);
  const [rows, setRows] = useState<Array<LocalReminder & { requiresAck: boolean; escalationLevel: number; entityType: string | null; entityId: string | null }>>([]);
  useEffect(() => {
    let live = true;
    void getStore()?.list('notification').then((list) => {
      if (!live) return;
      const now = new Date();
      setRows(list.map((r) => ({ ...toReminder(r), requiresAck: !!r.fields.requires_ack, escalationLevel: Number(r.fields.escalation_level ?? 0),
        entityType: (r.fields.entity_type as string | null) ?? null, entityId: (r.fields.entity_id as string | null) ?? null }))
        .filter((r) => new Date(r.fireAt) <= now && !(r.snoozedUntil && new Date(r.snoozedUntil) > now))
        .sort((a, b) => b.fireAt.localeCompare(a.fireAt)));
    });
    return () => { live = false; };
  }, [v]);
  return rows;
}

const write = async (id: string, patch: Record<string, unknown>) => { await getEngine()?.write('notification', id, patch); void syncNow(); };

function tomorrow9IST(): Date {
  const ist = new Date(Date.now() + 330 * 60_000);
  ist.setUTCDate(ist.getUTCDate() + 1); ist.setUTCHours(9, 0, 0, 0);
  return new Date(ist.getTime() - 330 * 60_000);
}

export function NotificationsScreen() {
  const t = useT();
  const [tab, setTab] = useState<'inbox' | 'settings'>('inbox');
  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold">{t('nav.notifications')}</h1>
        <div role="tablist" className="flex gap-1">
          {(['inbox', 'settings'] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`btn ${tab === k ? 'bg-surface-alt' : ''}`} onClick={() => setTab(k)}>{t(`notif.${k}`)}</button>
          ))}
        </div>
      </div>
      {tab === 'inbox' ? <Inbox /> : <NotificationSettings />}
    </div>
  );
}

function Inbox() {
  const t = useT();
  const items = useNotifications();
  const unread = items.filter((n) => !n.readAt);
  const snooze = useMutation({
    mutationFn: ({ id, until }: { id: string; until: Date }) => unwrap(api.POST('/notifications/{id}/snooze', { params: { path: { id } }, body: { until: until.toISOString() } })),
    onSuccess: () => void syncNow(),
  });
  if (!items.length) return <div className="card p-6 text-muted">{t('notif.empty')}</div>;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm text-muted">
        <span>{t('notif.unread', { count: unread.length })}</span>
        {unread.length > 0 && <button className="btn" onClick={() => unread.forEach((n) => void write(n.id, { read_at: new Date().toISOString() }))}><CheckCheck size={14} aria-hidden /> {t('notif.markAllRead')}</button>}
      </div>
      <ul className="card divide-y divide-border">
        {items.map((n) => {
          const critical = n.priority === 'critical' || n.priority === 'high';
          return (
            <li key={n.id} className={`flex gap-3 px-4 py-3 ${n.readAt ? 'opacity-70' : ''}`}>
              <span className="mt-0.5" style={{ color: critical ? `var(--w-status-overdue)` : undefined }} aria-hidden>
                {n.escalationLevel > 0 ? <ShieldAlert size={16} /> : critical ? <AlertOctagon size={16} /> : <Bell size={16} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className={`${n.readAt ? '' : 'font-semibold'}`}>{n.title}</div>
                {n.body && <div className="text-muted">{n.body}</div>}
                {n.category === 'report.ready' && n.entityType === 'report_export' && n.entityId && <ReportExportDownload id={n.entityId} />}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>{relativeTime(n.fireAt)}</span>
                  {n.escalationLevel > 0 && <span>· {t('notif.escalated', { level: n.escalationLevel })}</span>}
                  {n.requiresAck && !n.ackedAt && <span className="text-overdue">· {t('notif.ackRequired')}</span>}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-start gap-1">
                {n.requiresAck && !n.ackedAt
                  ? <button className="btn btn-primary" onClick={() => void write(n.id, { acked_at: new Date().toISOString(), read_at: new Date().toISOString() })}><Check size={14} aria-hidden /> {t('notif.ack')}</button>
                  : !n.readAt && <button className="btn" onClick={() => void write(n.id, { read_at: new Date().toISOString() })}>{t('notif.markRead')}</button>}
                <button className="btn" aria-label={t('notif.snooze1h')} title={t('notif.snooze1h')} onClick={() => snooze.mutate({ id: n.id, until: new Date(Date.now() + 3600_000) })}><Clock size={14} /></button>
                <button className="btn hidden sm:inline-flex" onClick={() => snooze.mutate({ id: n.id, until: tomorrow9IST() })}>{t('notif.snoozeTomorrow')}</button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const groups: Array<[string, string[]]> = [
  ['Tasks', CATEGORIES.filter((c) => c.startsWith('task.'))],
  ['Compliance & notices', CATEGORIES.filter((c) => /^(compliance|notice)\./.test(c))],
  ['Billing', ['invoice.due', 'payment.received']],
  ['Registers', ['dsc.expiring', 'licence.expiring', 'document.received', 'client.uploaded']],
  ['Team', ['leave.approval', 'attendance.approval', 'whatsapp.reply', 'automation.failed']],
];

function NotificationSettings() {
  const t = useT();
  const prefsQ = useQuery({ queryKey: ['prefs'], queryFn: () => unwrap(api.GET('/notifications/prefs')) as Promise<Prefs> });
  const [p, setP] = useState<Prefs | null>(null);
  useEffect(() => { if (prefsQ.data && !p) setP(prefsQ.data); }, [prefsQ.data, p]);
  const save = useMutation({ mutationFn: (x: Prefs) => unwrap(api.PUT('/notifications/prefs', { body: x })), onSuccess: () => void syncNow() });
  const test = useMutation({ mutationFn: () => unwrap(api.POST('/notifications/test')) });
  const cats = useMemo(() => p?.categories ?? {}, [p]);
  if (!p) return null;
  const setCat = (c: string, k: 'push' | 'muted', v: boolean) =>
    setP({ ...p, categories: { ...cats, [c]: { push: cats[c as keyof typeof cats]?.push ?? true, muted: cats[c as keyof typeof cats]?.muted ?? false, [k]: v } } });

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(p); }}>
      <section className="card space-y-2 p-4">
        <label className="flex items-center gap-2 font-semibold">
          <input type="checkbox" checked={!!p.quietHours} onChange={(e) => setP({ ...p, quietHours: e.target.checked ? { start: '21:00', end: '08:00' } : null })} />
          {t('notif.quietHours')}
        </label>
        <p className="text-sm text-muted">{t('notif.quietHoursHelp')}</p>
        {p.quietHours && (
          <div className="flex gap-3">
            <label className="text-sm">{t('notif.from')} <input type="time" className="input w-32" value={p.quietHours.start} onChange={(e) => setP({ ...p, quietHours: { ...p.quietHours!, start: e.target.value } })} /></label>
            <label className="text-sm">{t('notif.to')} <input type="time" className="input w-32" value={p.quietHours.end} onChange={(e) => setP({ ...p, quietHours: { ...p.quietHours!, end: e.target.value } })} /></label>
          </div>
        )}
      </section>
      <section className="card overflow-auto">
        <table className="table w-full">
          <thead><tr><th>{t('notif.categories')}</th><th>{t('notif.push')}</th><th>{t('notif.mute')}</th></tr></thead>
          <tbody>
            {groups.flatMap(([g, list]) => [
              <tr key={g}><td colSpan={3} className="bg-surface-alt text-xs font-semibold uppercase text-muted">{g}</td></tr>,
              ...list.map((c) => {
                const v = cats[c as keyof typeof cats];
                return (
                  <tr key={c}>
                    <td>{c.split('.')[1]!.replace(/_/g, ' ')}</td>
                    <td><input type="checkbox" aria-label={`${c} push`} checked={v?.push ?? true} onChange={(e) => setCat(c, 'push', e.target.checked)} /></td>
                    <td><input type="checkbox" aria-label={`${c} mute`} checked={v?.muted ?? false} onChange={(e) => setCat(c, 'muted', e.target.checked)} /></td>
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
      </section>
      <section className="card flex flex-wrap items-center gap-3 p-4">
        <label className="text-sm">{t('notif.digest')}{' '}
          <select className="input w-48" value={p.digest} onChange={(e) => setP({ ...p, digest: e.target.value as Prefs['digest'] })}>
            {(['off', 'morning', 'morning_evening'] as const).map((d) => <option key={d} value={d}>{t(`notif.digest.${d}`)}</option>)}
          </select>
        </label>
      </section>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" disabled={save.isPending}>{t('common.save')}</button>
        {save.isSuccess && <span role="status" className="text-done">{t('notif.saved')}</span>}
        <button type="button" className="btn" onClick={() => test.mutate()}><Bell size={14} aria-hidden /> {t('notif.sendTest')}</button>
        {test.isSuccess && <span role="status" className="text-sm text-muted">{t('notif.testSent')}</span>}
        {!desktop() && <BrowserPush />}
      </div>
    </form>
  );
}

function urlB64ToUint8(b64: string) {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Web Push opt-in: only on an explicit click (browsers penalise unprompted permission requests). */
function BrowserPush() {
  const t = useT();
  const [state, setState] = useState<'idle' | 'on' | 'unavailable'>('idle');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const enable = async () => {
    const { key } = await unwrap(api.GET('/push/vapid-public-key'));
    if (!key) { setState('unavailable'); return; }
    if ((await Notification.requestPermission()) !== 'granted') return;
    const reg = await navigator.serviceWorker.register('./sw.js');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await unwrap(api.POST('/push/subscriptions', { body: { kind: 'webpush', endpoint: j.endpoint, keys: j.keys } }));
    setState('on');
  };
  if (state === 'on') return <span className="text-sm text-done">{t('notif.browserOn')}</span>;
  if (state === 'unavailable') return <span className="text-sm text-muted"><BellOff size={14} className="inline" aria-hidden /> {t('notif.browserUnavailable')}</span>;
  return <button type="button" className="btn" onClick={() => void enable()}>{t('notif.enableBrowser')}</button>;
}

