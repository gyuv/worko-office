import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { SyncServer } from './core.js';
import { MemoryStore, OfflineError, RealtimeClient, SqliteStore, SyncEngine, type LocalStore, type SqlDriver, type Transport, type WsLike } from './index.js';

// Loaded via require: Vite doesn't recognise `node:sqlite` as a builtin and rewrites the import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

/** Transport over the pure reference server, with a switchable network. */
function link(server: SyncServer) {
  const net = { online: true };
  const transport: Transport = {
    async push(ms) {
      if (!net.online) throw new OfflineError();
      return ms.map((m) => {
        const r = server.apply({ idempotencyKey: m.key, deviceId: 'x', table: m.table, id: m.id, baseVersion: m.baseVersion, patch: m.patch, delete: m.delete });
        return { key: m.key, status: r.status, version: r.row?.version };
      });
    },
    async pull(since, limit) {
      if (!net.online) throw new OfflineError();
      const p = server.pull(since, () => true, limit);
      return { changes: p.upserts.map((r) => ({ table: r.table, id: r.id, version: r.version, cursor: r.cursor, deleted: r.deleted, fields: r.fields })), cursor: p.cursor, hasMore: p.upserts.length === limit };
    },
  };
  return { net, transport };
}

const sqliteDriver = (file = ':memory:'): { driver: SqlDriver; db: DatabaseSync } => {
  const db = new DatabaseSync(file);
  return { db, driver: {
    async run(sql, params = []) { db.prepare(sql).run(...(params as never[])); },
    async all(sql, params = []) { return db.prepare(sql).all(...(params as never[])) as never; },
  } };
};

const view = async (s: LocalStore, table = 'task') => Object.fromEntries((await s.list(table)).map((r) => [r.id, r.fields]));

/** Server that rejects any patch touching `locked`. */
function rejectingLink(server: SyncServer) {
  const l = link(server);
  const push = l.transport.push;
  l.transport.push = async (ms) => {
    const ok = ms.filter((m) => !('locked' in m.patch));
    const res = await push(ok);
    return ms.map((m) => res.find((r) => r.key === m.key) ?? { key: m.key, status: 'rejected' as const, reason: 'field_not_writable:locked' });
  };
  return l;
}

describe.each([
  ['memory', async () => new MemoryStore() as LocalStore],
  ['sqlite', async () => SqliteStore.open(sqliteDriver().driver) as Promise<LocalStore>],
])('SyncEngine (%s store)', (_name, mkStore) => {
  it('works offline, then converges on reconnect', async () => {
    const server = new SyncServer();
    const A = link(server); const B = link(server);
    const a = new SyncEngine({ store: await mkStore(), transport: A.transport, deviceId: 'a' });
    const bStore = await mkStore();
    const b = new SyncEngine({ store: bStore, transport: B.transport, deviceId: 'b' });
    A.net.online = false;
    await a.write('task', 't1', { title: 'File GSTR-3B', stage: 'Prepare' });
    await a.sync();
    expect(a.snapshot).toMatchObject({ status: 'offline', pending: 1 });
    A.net.online = true;
    await a.sync(); await b.sync();
    expect(a.snapshot).toMatchObject({ status: 'synced', pending: 0 });
    expect(await view(bStore)).toEqual({ t1: { title: 'File GSTR-3B', stage: 'Prepare' } });
  });

  it('keeps unpushed local edits visible over incoming server rows', async () => {
    const server = new SyncServer();
    const A = link(server); const B = link(server);
    const aStore = await mkStore();
    const a = new SyncEngine({ store: aStore, transport: A.transport, deviceId: 'a' });
    const b = new SyncEngine({ store: await mkStore(), transport: B.transport, deviceId: 'b' });
    await a.write('task', 't1', { title: 'T', stage: 'Prepare' }); await a.sync(); await b.sync();
    await b.write('task', 't1', { title: 'T (renamed)' }); await b.sync();
    // a edits stage while its push fails mid-way; the pull must not revert the local stage
    await a.write('task', 't1', { stage: 'Check' });
    const realPush = A.transport.push; A.transport.push = async () => { throw new OfflineError(); };
    await a.sync().catch(() => undefined);
    A.transport.push = realPush;
    const p = await A.transport.pull(0, 100);
    expect(p.changes.find((c) => c.id === 't1')?.fields.title).toBe('T (renamed)');
    await a.sync();
    expect(await view(aStore)).toEqual({ t1: { title: 'T (renamed)', stage: 'Check' } });
  });

  it('a rejected edit is undone locally at once, keeping other pending edits', async () => {
    const server = new SyncServer();
    const L = rejectingLink(server);
    const store = await mkStore();
    const e = new SyncEngine({ store, transport: L.transport, deviceId: 'a' });
    await e.write('task', 't', { title: 'T' }); await e.sync();
    L.net.online = false;
    await e.write('task', 't', { locked: true });
    await e.write('task', 't', { stage: 'Check' });
    L.net.online = true;
    // Push the rejected one alone first, while the stage edit is still pending.
    const realList = store.outboxList.bind(store);
    let first = true;
    store.outboxList = async (n) => (first ? ((first = false), (await realList(n)).slice(0, 1)) : realList(n));
    await e.sync();
    expect(e.snapshot.rejected).toHaveLength(1);
    expect((await store.get('task', 't'))?.fields).toEqual({ title: 'T', stage: 'Check' });
    // A never-synced row whose creation is rejected disappears.
    await e.write('task', 'new', { locked: true });
    await e.sync();
    expect(await store.get('task', 'new')).toBeNull();
  });

  it('surfaces rejected mutations and wipes cleanly', async () => {
    const server = new SyncServer(new Set(['invoice']));
    const A = link(server); const B = link(server);
    const aStore = await mkStore();
    const a = new SyncEngine({ store: aStore, transport: A.transport, deviceId: 'a' });
    const b = new SyncEngine({ store: await mkStore(), transport: B.transport, deviceId: 'b' });
    await a.write('invoice', 'i1', { total: 100 }); await a.sync(); await b.sync();
    await a.write('invoice', 'i1', { total: 200 }); await b.write('invoice', 'i1', { total: 300 });
    await a.sync(); await b.sync();
    expect(b.snapshot.rejected.map((r) => r.status)).toEqual(['rejected_stale']);
    expect((await view((b as unknown as { o: { store: LocalStore } }).o.store, 'invoice')).i1).toEqual({ total: 200 }); // server truth restored
    await a.wipe();
    expect(await aStore.list('invoice')).toEqual([]);
    expect(await aStore.getMeta('cursor')).toBeNull();
  });
});

describe('SyncEngine convergence under random offline periods', () => {
  for (let seed = 1; seed <= 20; seed++) {
    it(`seed ${seed}`, async () => {
      let x = seed; const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      const server = new SyncServer();
      const devs = await Promise.all(['web', 'desk', 'phone'].map(async (d) => {
        const l = link(server); const store = new MemoryStore();
        return { l, store, e: new SyncEngine({ store, transport: l.transport, deviceId: d, pageSize: 3 }) };
      }));
      for (let step = 0; step < 150; step++) {
        const d = devs[Math.floor(rnd() * devs.length)]!;
        const r = rnd();
        if (r < 0.5) await d.e.write('task', `t${Math.floor(rnd() * 6)}`, { [['title', 'stage', 'owner'][Math.floor(rnd() * 3)]!]: `${step}` });
        else if (r < 0.65) d.l.net.online = !d.l.net.online;
        else await d.e.sync();
      }
      for (const d of devs) d.l.net.online = true;
      for (let k = 0; k < 2; k++) for (const d of devs) await d.e.sync();
      const views = await Promise.all(devs.map((d) => view(d.store)));
      expect(views[1]).toEqual(views[0]); expect(views[2]).toEqual(views[0]);
      expect(views[0]).toEqual(Object.fromEntries([...server.snapshot()].filter(([, v]) => !v.deleted).map(([k, v]) => [k.split(':')[1], v.fields])));
    });
  }
});

describe('SqliteStore durability', () => {
  it('outbox and cursor survive a restart', async () => {
    const file = `/tmp/worko-sync-${process.pid}-${Date.now()}.db`;
    const first = sqliteDriver(file);
    const s1 = await SqliteStore.open(first.driver);
    const e1 = new SyncEngine({ store: s1, transport: { push: async () => { throw new OfflineError(); }, pull: async () => { throw new OfflineError(); } }, deviceId: 'd' });
    await e1.write('task', 't', { title: 'offline edit' });
    await s1.setMeta('cursor', '42');
    first.db.close();
    const s2 = await SqliteStore.open(sqliteDriver(file).driver);
    expect(await s2.outboxCount()).toBe(1);
    expect(await s2.getMeta('cursor')).toBe('42');
    expect((await s2.get('task', 't'))?.fields).toEqual({ title: 'offline edit' });
  });
});

describe('RealtimeClient', () => {
  function fakeWs() {
    const made: Array<WsLike & { sent: string[]; serverSend(m: object): void; serverClose(code: number): void }> = [];
    const create = () => {
      const ws = { readyState: 1, sent: [] as string[], onopen: null, onmessage: null, onclose: null, onerror: null,
        send(d: string) { this.sent.push(d); }, close() {},
        serverSend(m: object) { this.onmessage?.({ data: JSON.stringify(m) }); }, serverClose(code: number) { this.onclose?.({ code }); } } as never;
      made.push(ws); setTimeout(() => (ws as WsLike).onopen?.({}));
      return ws;
    };
    return { made, create };
  }
  it('authenticates, relays change hints, reconnects with backoff, stops on revoke', async () => {
    const f = fakeWs(); const cursors: number[] = []; let revoked: boolean | null = null;
    const c = new RealtimeClient({ url: 'ws://x', createSocket: f.create, getToken: () => 'tok', onChanged: (n) => cursors.push(n), onRevoked: (w) => (revoked = w), random: () => 0 });
    c.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(JSON.parse(f.made[0]!.sent[0]!)).toEqual({ type: 'auth', token: 'tok' });
    f.made[0]!.serverSend({ type: 'ready' }); f.made[0]!.serverSend({ type: 'changed', cursor: 7 });
    expect(cursors).toEqual([-1, 7]); // -1 = "sync now" after (re)connect
    f.made[0]!.serverClose(1006);
    await new Promise((r) => setTimeout(r, 300));
    expect(f.made).toHaveLength(2);
    f.made[1]!.serverSend({ type: 'revoked', wipe: true });
    expect(revoked).toBe(true);
    f.made[1]!.serverClose(4403);
    await new Promise((r) => setTimeout(r, 300));
    expect(f.made).toHaveLength(2);
    c.stop();
  });
});
