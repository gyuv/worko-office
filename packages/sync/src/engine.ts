/**
 * Client sync engine (offline-first). Writes go to the local store immediately and to an outbox;
 * `sync()` pushes the outbox (idempotent keys) then pulls deltas by cursor. Transport- and storage-agnostic:
 * the same engine runs in Electron, React Native and tests.
 */
/** `fields` = what the UI shows (server state + pending local edits); `server` = last state confirmed by the server. */
export type LocalRow = { table: string; id: string; version: number; deleted: boolean; fields: Record<string, unknown>; server?: Record<string, unknown> };
export type OutboxEntry = { key: string; table: string; id: string; baseVersion: number; patch: Record<string, unknown>; delete?: boolean };
export type PushResult = { key: string; status: 'applied' | 'duplicate' | 'rejected_stale' | 'rejected'; version?: number; reason?: string };
export type PullPage = { changes: Array<{ table: string; id: string; version: number; cursor: number; deleted: boolean; fields: Record<string, unknown> }>; cursor: number; hasMore: boolean };

export interface LocalStore {
  get(table: string, id: string): Promise<LocalRow | null>;
  put(rows: LocalRow[]): Promise<void>;
  remove(table: string, id: string): Promise<void>;
  list(table: string): Promise<LocalRow[]>;
  outboxAdd(e: OutboxEntry): Promise<void>;
  outboxList(limit: number): Promise<OutboxEntry[]>;
  outboxRemove(keys: string[]): Promise<void>;
  outboxCount(): Promise<number>;
  getMeta(k: string): Promise<string | null>;
  setMeta(k: string, v: string): Promise<void>;
  /** Remote wipe / sign-out: erase everything. */
  wipe(): Promise<void>;
}

export interface Transport {
  push(mutations: OutboxEntry[]): Promise<PushResult[]>;
  pull(since: number, limit: number): Promise<PullPage>;
}

/** Thrown by transports when the device is offline/unreachable (vs. a server rejection). */
export class OfflineError extends Error { constructor(cause?: unknown) { super('offline', { cause }); } }

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error';
export type SyncState = { status: SyncStatus; pending: number; rejected: PushResult[]; lastSyncedAt: number | null; initial?: { pulled: number; done: boolean } };

export class SyncEngine {
  private running: Promise<void> | null = null;
  private again = false;
  private state: SyncState = { status: 'idle', pending: 0, rejected: [], lastSyncedAt: null };
  private seq = 0;

  constructor(private o: {
    store: LocalStore; transport: Transport; deviceId: string;
    onChange?: (tables: Set<string>) => void; onState?: (s: SyncState) => void;
    now?: () => number; batch?: number; pageSize?: number;
  }) {}

  get snapshot(): SyncState { return this.state; }
  private set(p: Partial<SyncState>) { this.state = { ...this.state, ...p }; this.o.onState?.(this.state); }

  /** Optimistic local write + outbox entry. Visible immediately; reaches the server on next sync. */
  async write(table: string, id: string, patch: Record<string, unknown>, opts: { delete?: boolean } = {}) {
    const cur = await this.o.store.get(table, id);
    await this.o.store.put([{ table, id, version: cur?.version ?? 0, deleted: !!opts.delete || !!cur?.deleted, fields: { ...cur?.fields, ...patch }, server: cur?.server ?? {} }]);
    const key = `${this.o.deviceId}:${(this.o.now ?? Date.now)()}:${++this.seq}:${Math.random().toString(36).slice(2, 8)}`;
    await this.o.store.outboxAdd({ key, table, id, baseVersion: cur?.version ?? 0, patch, delete: opts.delete });
    this.set({ pending: await this.o.store.outboxCount() });
    this.o.onChange?.(new Set([table]));
  }

  /** Coalesces concurrent calls: a sync requested mid-run triggers exactly one more run. */
  sync(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do { this.again = false; await this.runOnce(); } while (this.again);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  private async runOnce() {
    this.set({ status: 'syncing' });
    try {
      await this.pushAll();
      await this.pullAll();
      this.set({ status: 'synced', lastSyncedAt: (this.o.now ?? Date.now)(), pending: await this.o.store.outboxCount() });
    } catch (e) {
      this.set({ status: e instanceof OfflineError ? 'offline' : 'error', pending: await this.o.store.outboxCount() });
      if (!(e instanceof OfflineError)) throw e;
    }
  }

  private async pushAll() {
    for (;;) {
      const batch = await this.o.store.outboxList(this.o.batch ?? 50);
      if (!batch.length) return;
      const results = await this.o.transport.push(batch);
      const bad = results.filter((r) => r.status === 'rejected' || r.status === 'rejected_stale');
      if (bad.length) this.set({ rejected: [...this.state.rejected, ...bad].slice(-50) });
      // Every answered mutation leaves the outbox; rejected ones are surfaced and their local effect undone.
      await this.o.store.outboxRemove(results.map((r) => r.key));
      if (bad.length) await this.revert(batch.filter((m) => bad.some((b) => b.key === m.key)));
      if (results.length < batch.length) return; // partial answer: retry the rest next time
    }
  }

  /** Rebuild rejected rows from the last server state plus any edits still waiting to be pushed. */
  private async revert(rejected: OutboxEntry[]) {
    const pending = await this.o.store.outboxList(100_000);
    const tables = new Set<string>();
    for (const m of rejected) {
      const row = await this.o.store.get(m.table, m.id);
      if (!row) continue;
      tables.add(m.table);
      if (!row.version) { await this.o.store.remove(m.table, m.id); continue; } // never existed on the server
      const fields = { ...row.server };
      for (const p of pending) if (p.table === m.table && p.id === m.id) Object.assign(fields, p.patch);
      await this.o.store.put([{ ...row, deleted: false, fields }]);
    }
    if (tables.size) this.o.onChange?.(tables);
  }

  private async pullAll() {
    let since = Number((await this.o.store.getMeta('cursor')) ?? 0);
    const initial = since === 0;
    let pulled = 0;
    for (;;) {
      const page = await this.o.transport.pull(since, this.o.pageSize ?? 500);
      const pending = await this.o.store.outboxList(100_000);
      const rows: LocalRow[] = []; const tables = new Set<string>();
      for (const c of page.changes) {
        tables.add(c.table);
        if (c.deleted) { await this.o.store.remove(c.table, c.id); continue; }
        // Re-apply not-yet-pushed local edits on top of server state so the UI never flickers back.
        const fields = { ...c.fields };
        for (const m of pending) if (m.table === c.table && m.id === c.id) Object.assign(fields, m.patch);
        rows.push({ table: c.table, id: c.id, version: c.version, deleted: false, fields, server: c.fields });
      }
      await this.o.store.put(rows);
      since = page.cursor;
      await this.o.store.setMeta('cursor', String(since));
      pulled += page.changes.length;
      if (initial) this.set({ initial: { pulled, done: !page.hasMore } });
      if (tables.size) this.o.onChange?.(tables);
      if (!page.hasMore) return;
    }
  }

  clearRejected() { this.set({ rejected: [] }); }

  async wipe() { await this.o.store.wipe(); this.set({ status: 'idle', pending: 0, rejected: [], lastSyncedAt: null, initial: undefined }); }
}

/** In-memory store (tests, web without persistence). */
export class MemoryStore implements LocalStore {
  rows = new Map<string, LocalRow>(); outbox: OutboxEntry[] = []; meta = new Map<string, string>();
  async get(t: string, id: string) { return this.rows.get(`${t}:${id}`) ?? null; }
  async put(rows: LocalRow[]) { for (const r of rows) this.rows.set(`${r.table}:${r.id}`, structuredClone(r)); }
  async remove(t: string, id: string) { this.rows.delete(`${t}:${id}`); }
  async list(t: string) { return [...this.rows.values()].filter((r) => r.table === t && !r.deleted); }
  async outboxAdd(e: OutboxEntry) { this.outbox.push(structuredClone(e)); }
  async outboxList(n: number) { return this.outbox.slice(0, n); }
  async outboxRemove(keys: string[]) { const k = new Set(keys); this.outbox = this.outbox.filter((e) => !k.has(e.key)); }
  async outboxCount() { return this.outbox.length; }
  async getMeta(k: string) { return this.meta.get(k) ?? null; }
  async setMeta(k: string, v: string) { this.meta.set(k, v); }
  async wipe() { this.rows.clear(); this.outbox = []; this.meta.clear(); }
}

/** Minimal async SQL driver: implemented over node:sqlite / better-sqlite3 (desktop) and expo-sqlite (Android, SQLCipher). */
export interface SqlDriver {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

type SqlRow = { tbl: string; id: string; version: number; deleted: number; fields: string; server: string | null };

/** Durable store on SQLite. Rows are kept generically (JSON) so new synced tables need no client migration. */
export class SqliteStore implements LocalStore {
  constructor(private db: SqlDriver) {}

  static async open(db: SqlDriver): Promise<SqliteStore> {
    await db.run(`CREATE TABLE IF NOT EXISTS rows (tbl TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL, fields TEXT NOT NULL, server TEXT, PRIMARY KEY (tbl, id))`);
    await db.run(`CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, body TEXT NOT NULL)`);
    await db.run(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    return new SqliteStore(db);
  }

  private row(r: SqlRow): LocalRow {
    return { table: r.tbl, id: r.id, version: Number(r.version), deleted: !!r.deleted, fields: JSON.parse(r.fields), server: r.server ? JSON.parse(r.server) : undefined };
  }
  async get(t: string, id: string) {
    const [r] = await this.db.all<SqlRow>('SELECT * FROM rows WHERE tbl = ? AND id = ?', [t, id]);
    return r ? this.row(r) : null;
  }
  async put(rows: LocalRow[]) {
    for (const r of rows) {
      await this.db.run('INSERT INTO rows (tbl, id, version, deleted, fields, server) VALUES (?,?,?,?,?,?) ON CONFLICT (tbl, id) DO UPDATE SET version = excluded.version, deleted = excluded.deleted, fields = excluded.fields, server = excluded.server',
        [r.table, r.id, r.version, r.deleted ? 1 : 0, JSON.stringify(r.fields), r.server ? JSON.stringify(r.server) : null]);
    }
  }
  async remove(t: string, id: string) { await this.db.run('DELETE FROM rows WHERE tbl = ? AND id = ?', [t, id]); }
  async list(t: string) {
    return (await this.db.all<SqlRow>('SELECT * FROM rows WHERE tbl = ? AND deleted = 0', [t])).map((r) => this.row(r));
  }
  async outboxAdd(e: OutboxEntry) { await this.db.run('INSERT INTO outbox (key, body) VALUES (?, ?)', [e.key, JSON.stringify(e)]); }
  async outboxList(n: number) { return (await this.db.all<{ body: string }>('SELECT body FROM outbox ORDER BY seq LIMIT ?', [n])).map((r) => JSON.parse(r.body) as OutboxEntry); }
  async outboxRemove(keys: string[]) { for (const k of keys) await this.db.run('DELETE FROM outbox WHERE key = ?', [k]); }
  async outboxCount() { return Number((await this.db.all<{ n: number }>('SELECT count(*) AS n FROM outbox'))[0]?.n ?? 0); }
  async getMeta(k: string) { return (await this.db.all<{ v: string }>('SELECT v FROM meta WHERE k = ?', [k]))[0]?.v ?? null; }
  async setMeta(k: string, v: string) { await this.db.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [k, v]); }
  async wipe() { await this.db.run('DELETE FROM rows'); await this.db.run('DELETE FROM outbox'); await this.db.run('DELETE FROM meta'); }
}
