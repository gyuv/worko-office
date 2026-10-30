import NetInfo from '@react-native-community/netinfo';
import { createHttpTransport } from '@worko/api-client';
import { defaultPrefs, prefsSchema, ReminderScheduler, type LocalReminder, type Prefs } from '@worko/notify';
import { RealtimeClient, SqliteStore, SyncEngine, type LocalRow, type SqlDriver, type SyncState, type WsLike } from '@worko/sync';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { create } from 'zustand';
import { scheduleUpcoming, cancelAllScheduled } from './notifications';
import { planTaskReminders, toTaskItem } from './logic/tasks';
import { createTranslator } from '@worko/i18n';
import { PRODUCT } from '@worko/domain';
import { api, apiBase, setWipeHandler, useSession } from './session';
import { clearReportCache } from './reportCache';

type MobileSync = SyncState & { versions: Record<string, number>; online: boolean; connected: boolean };
export const useSync = create<MobileSync>(() => ({ status: 'idle', pending: 0, rejected: [], lastSyncedAt: null, versions: {}, online: true, connected: false }));

const tr = createTranslator('en-IN', { product: PRODUCT.name });

let db: SQLite.SQLiteDatabase | null = null;
let engine: SyncEngine | null = null;
let store: SqliteStore | null = null;
let realtime: RealtimeClient | null = null;
let unsubNet: (() => void) | null = null;
let current = '';
/** Bumped by start/stop; an in-flight start that sees a newer generation abandons itself. */
let generation = 0;

export const getEngine = () => engine;
export const getStore = () => store;

/** Per-install SQLCipher key, generated on first use and kept in the Android Keystore via SecureStore. */
async function dbKey(): Promise<string> {
  const k = 'worko.dbkey';
  let v = await SecureStore.getItemAsync(k);
  if (!v) {
    v = Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
    await SecureStore.setItemAsync(k, v);
  }
  return v;
}

function driver(d: SQLite.SQLiteDatabase): SqlDriver {
  return {
    run: async (sql, params = []) => { await d.runAsync(sql, params as SQLite.SQLiteBindValue[]); },
    all: async <T,>(sql: string, params: unknown[] = []) => d.getAllAsync<T>(sql, params as SQLite.SQLiteBindValue[]),
  };
}

export const toReminder = (r: LocalRow): LocalReminder => ({
  id: r.id, title: String(r.fields.title ?? ''), body: String(r.fields.body ?? ''), category: String(r.fields.category ?? ''),
  priority: (r.fields.priority as LocalReminder['priority']) ?? 'normal', fireAt: String(r.fields.fire_at ?? new Date(0).toISOString()),
  readAt: r.fields.read_at as string | null, ackedAt: r.fields.acked_at as string | null, snoozedUntil: r.fields.snoozed_until as string | null,
});

async function prefs(): Promise<Prefs> {
  const row = (await store?.list('notification_pref'))?.[0];
  const p = prefsSchema.safeParse(row?.fields.prefs ?? {});
  return p.success ? p.data : defaultPrefs();
}

/** Hand the next 7 days of reminders to the OS: they fire even if the app is killed, offline, or push is late. */
async function reschedule() {
  if (!store) return;
  const p = await prefs();
  const s = new ReminderScheduler({ now: Date.now, show: () => undefined, prefs: () => p });
  // Server notifications plus device-planned act-by reminders for my own open tasks (work offline).
  const userId = useSession.getState().tokens?.userId ?? '';
  const tasks = (await store.list('task')).filter((r) => !r.deleted).map(toTaskItem);
  const own = planTaskReminders(tasks, userId, { soon: (x) => tr('m.task.remind.soon', { title: x.title }), today: (x) => tr('m.task.remind.today', { title: x.title }) });
  await scheduleUpcoming(s.upcoming([...(await store.list('notification')).map(toReminder), ...own]));
}

function bump(tables: Set<string>) {
  useSync.setState((s) => {
    const versions = { ...s.versions };
    for (const t of tables) versions[t] = (versions[t] ?? 0) + 1;
    return { versions };
  });
  if (tables.has('notification') || tables.has('notification_pref') || tables.has('task')) void reschedule();
}

export async function startSync(tenantId: string, userId: string, sessionId: string) {
  const key = `${tenantId}:${userId}:${sessionId}`;
  if (current === key) return;
  await stopSync(false);
  const gen = ++generation;
  const stale = () => gen !== generation;
  current = key;
  const opened = await SQLite.openDatabaseAsync(`worko-${tenantId}-${userId}.db`);
  await opened.execAsync(`PRAGMA key = '${await dbKey()}'`); // hex-only key: safe to inline
  const s = await SqliteStore.open(driver(opened));
  if (stale()) { await opened.closeAsync().catch(() => undefined); return; }
  db = opened; store = s;
  engine = new SyncEngine({ store, transport: createHttpTransport(api), deviceId: sessionId, onChange: bump, onState: (s) => useSync.setState(s) });
  const ws = apiBase.replace(/^http/, 'ws').replace(/\/$/, '') + '/realtime';
  realtime = new RealtimeClient({
    url: ws, createSocket: (u) => new WebSocket(u) as unknown as WsLike,
    getToken: () => useSession.getState().tokens?.accessToken ?? null,
    onChanged: () => void engine?.sync().catch(() => undefined),
    onUnauthorized: () => void api.GET('/me'),
    onRevoked: (wipe) => void (wipe ? remoteWipe() : useSession.getState().setTokens(null)),
    onConnected: (connected) => useSync.setState({ connected }),
  });
  realtime.start();
  unsubNet = NetInfo.addEventListener((s) => {
    const online = !!s.isConnected && s.isInternetReachable !== false;
    const was = useSync.getState().online;
    useSync.setState({ online });
    if (online && !was) { realtime?.nudge(); void engine?.sync().catch(() => undefined); }
  });
  await engine.sync().catch(() => undefined);
  if (!stale()) await reschedule();
}

export async function stopSync(wipe: boolean) {
  generation++;
  realtime?.stop(); realtime = null; unsubNet?.(); unsubNet = null;
  if (wipe) { await engine?.wipe(); await cancelAllScheduled(); await clearReportCache(); }
  await db?.closeAsync().catch(() => undefined);
  if (wipe && current) {
    const [tenantId, userId] = current.split(':');
    await SQLite.deleteDatabaseAsync(`worko-${tenantId}-${userId}.db`).catch(() => undefined);
    await SecureStore.deleteItemAsync('worko.dbkey');
  }
  db = null; engine = null; store = null; current = '';
  useSync.setState({ status: 'idle', pending: 0, rejected: [], connected: false });
}

/** Remote wipe: erase DB file, its key, scheduled reminders and tokens. */
export async function remoteWipe() {
  await stopSync(true);
  useSession.setState({ tokens: null, wiped: true });
  void SecureStore.deleteItemAsync('worko.session');
}

setWipeHandler(remoteWipe);

export const syncNow = () => engine?.sync().catch(() => undefined);
