import { createHttpTransport } from '@worko/api-client';
import { defaultPrefs, prefsSchema, ReminderScheduler, type LocalReminder, type Prefs } from '@worko/notify';
import { MemoryStore, RealtimeClient, SyncEngine, type LocalRow, type LocalStore, type SyncState, type WsLike } from '@worko/sync';
import { create } from 'zustand';
import { aesGcmCipher, IdbStore } from './idb-store';
import { apiBase, desktop } from './platform';
import { api, useSession } from './session';

/** Re-render trigger per synced table, plus live sync/connection state for the header indicator. */
type SyncUi = SyncState & { versions: Record<string, number>; connected: boolean; toasts: LocalReminder[] };
export const useSync = create<SyncUi>(() => ({ status: 'idle', pending: 0, rejected: [], lastSyncedAt: null, versions: {}, connected: false, toasts: [] }));

let engine: SyncEngine | null = null;
let store: LocalStore | null = null;
let realtime: RealtimeClient | null = null;
let scheduler: ReminderScheduler | null = null;
let reminderTimer: ReturnType<typeof setTimeout> | undefined;
let primed = false;
/** Bumped by start/stop; an in-flight start that sees a newer generation abandons itself. */
let generation = 0;
let fallbackTimer: ReturnType<typeof setInterval> | undefined;
let currentKey = '';

export const getEngine = () => engine;
export const getStore = () => store;

export function wsUrl(base = apiBase()): string {
  const u = new URL(base, typeof location !== 'undefined' ? location.href : 'http://localhost');
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/$/, '')}/realtime`;
  return u.toString();
}

async function openStore(tenantId: string, userId: string): Promise<LocalStore> {
  if (typeof indexedDB === 'undefined') return new MemoryStore();
  const d = desktop();
  // Desktop: encrypted at rest with a key held by the OS keychain. Web: browser profile storage, wiped on sign-out.
  const cipher = d ? await aesGcmCipher(await d.getDbKey()) : undefined;
  return IdbStore.open(`worko-${tenantId}-${userId}`, cipher);
}

function bump(tables: Set<string>) {
  useSync.setState((s) => {
    const versions = { ...s.versions };
    for (const t of tables) versions[t] = (versions[t] ?? 0) + 1;
    return { versions };
  });
  if (tables.has('notification') || tables.has('notification_pref')) void runReminders();
}

async function prefs(): Promise<Prefs> {
  const row = (await store?.list('notification_pref'))?.[0];
  const p = prefsSchema.safeParse(row?.fields.prefs ?? {});
  return p.success ? p.data : defaultPrefs();
}

export const toReminder = (r: LocalRow): LocalReminder => ({
  id: r.id, title: String(r.fields.title ?? ''), body: String(r.fields.body ?? ''), category: String(r.fields.category ?? ''),
  priority: (r.fields.priority as LocalReminder['priority']) ?? 'normal', fireAt: String(r.fields.fire_at ?? new Date(0).toISOString()),
  readAt: r.fields.read_at as string | null, ackedAt: r.fields.acked_at as string | null, snoozedUntil: r.fields.snoozed_until as string | null,
});

/** Fires due reminders from local data — works offline; desktop shows native toasts, web shows in-app toasts. */
async function runReminders() {
  if (!scheduler || !store || !primed) return;
  clearTimeout(reminderTimer);
  const rows = (await store.list('notification')).map(toReminder);
  const unread = rows.filter((r) => !r.readAt && new Date(r.fireAt) <= new Date() && !(r.snoozedUntil && new Date(r.snoozedUntil) > new Date())).length;
  desktop()?.setBadge(unread);
  if (typeof document !== 'undefined') document.title = unread ? `(${unread}) Worko` : 'Worko';
  const next = scheduler.tick(rows);
  if (next !== null) reminderTimer = setTimeout(() => void runReminders(), Math.min(next + 50, 2 ** 31 - 1));
}

let cachedPrefs: Prefs = defaultPrefs();

export async function startSync(tenantId: string, userId: string, sessionId: string) {
  const key = `${tenantId}:${userId}:${sessionId}`;
  if (currentKey === key) return;
  await stopSync(false);
  const gen = ++generation;
  const stale = () => gen !== generation;
  currentKey = key;
  const opened = await openStore(tenantId, userId);
  if (stale()) { (opened as IdbStore).close?.(); return; }
  store = opened;
  engine = new SyncEngine({
    store, transport: createHttpTransport(api), deviceId: sessionId,
    onChange: bump, onState: (s) => useSync.setState(s),
  });
  const firedKey = `worko.fired.${userId}`;
  scheduler = new ReminderScheduler({
    now: Date.now, prefs: () => cachedPrefs,
    load: () => { try { return JSON.parse(localStorage.getItem(firedKey) ?? '[]'); } catch { return []; } },
    save: (ids) => { try { localStorage.setItem(firedKey, JSON.stringify(ids)); } catch { /* quota */ } },
    show: (r) => {
      const d = desktop();
      if (d) d.notify({ id: r.id, title: r.title, body: r.body });
      else useSync.setState((s) => ({ toasts: [...s.toasts.slice(-3), r] }));
    },
  });
  const refreshPrefs = async () => { cachedPrefs = await prefs(); };
  await refreshPrefs();
  if (stale()) return;
  realtime = new RealtimeClient({
    url: wsUrl(), createSocket: (u) => new WebSocket(u) as unknown as WsLike,
    getToken: () => useSession.getState().tokens?.accessToken ?? null,
    onChanged: () => void engine?.sync().then(refreshPrefs).then(runReminders).catch(() => undefined),
    onUnauthorized: () => void api.GET('/me'), // triggers the client's single-flight refresh
    onRevoked: (wipe) => void (wipe ? onRemoteWipe() : useSession.getState().setTokens(null)),
    onConnected: (connected) => useSync.setState({ connected }),
  });
  realtime.start();
  addEventListener('online', onOnline);
  fallbackTimer = setInterval(() => void engine?.sync().catch(() => undefined), 60_000);
  await engine.sync().catch(() => undefined);
  if (stale()) return;
  await refreshPrefs();
  const items = (await store.list('notification')).map(toReminder);
  if (stale() || !scheduler) return;
  scheduler.prime(items);
  primed = true;
  await runReminders();
}

function onOnline() { realtime?.nudge(); void engine?.sync().catch(() => undefined); }

export async function stopSync(wipe: boolean) {
  generation++;
  realtime?.stop(); realtime = null;
  clearInterval(fallbackTimer); clearTimeout(reminderTimer);
  removeEventListener('online', onOnline);
  if (wipe) await engine?.wipe();
  (store as IdbStore | null)?.close?.();
  engine = null; store = null; scheduler = null; currentKey = ''; primed = false;
  useSync.setState({ status: 'idle', pending: 0, rejected: [], connected: false, toasts: [] });
}

/** Called for remote wipe from any path (HTTP 401 DEVICE_WIPE or realtime 'revoked' with wipe). */
export async function onRemoteWipe() {
  await stopSync(true);
  await desktop()?.wipeLocalData();
  try { localStorage.clear(); } catch { /* ignore */ }
  useSession.setState({ tokens: null, notice: 'wiped' });
}

export const syncNow = () => engine?.sync().catch(() => undefined);
export const dismissToast = (id: string) => useSync.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
