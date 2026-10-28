import { createHttpTransport, createWorkoClient, type TokenPair } from '@worko/api-client';
import { MemoryStore, SyncEngine } from '@worko/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, bootApp } from './helpers.js';

/** Real client engines ↔ real API ↔ real Postgres: the acceptance-test path for "offline basement" edits. */
let t: Awaited<ReturnType<typeof bootApp>>;
let base: string;
beforeAll(async () => {
  t = await bootApp({ listen: true });
  base = `http://127.0.0.1:${(t.app.getHttpServer().address() as { port: number }).port}/v1`;
}, 60_000);
afterAll(() => t?.close());

function device(tokens: TokenPair) {
  let tk: TokenPair | null = tokens;
  const net = { online: true };
  const api = createWorkoClient({
    baseUrl: base, tokens: { get: () => tk, set: (x) => { tk = x; } },
    fetch: (input, init) => net.online ? fetch(input, init) : Promise.reject(new TypeError('network down')),
  });
  const store = new MemoryStore();
  const engine = new SyncEngine({ store, transport: createHttpTransport(api), deviceId: tokens.sessionId });
  return { store, engine, net };
}

describe('client engine ↔ API', () => {
  it('an offline read on the phone reaches the desktop after reconnect; nobody else sees it', async () => {
    const p = await t.signup('engco');
    const phone = device(await t.login('engco', 'partner@engco.in', 'android'));
    const desk = device(await t.login('engco', 'partner@engco.in', 'desktop'));
    const other = device(await t.addUser(p, 'engco', 'Oza', 'senior'));
    const { body: { id } } = await t.http().post('/v1/notifications/test').set(bearer(p.accessToken)).expect(201);
    await phone.engine.sync(); await desk.engine.sync(); await other.engine.sync();
    expect((await desk.store.list('notification')).map((r) => r.id)).toEqual([id]);
    expect(await other.store.list('notification')).toEqual([]);

    phone.net.online = false;
    const readAt = new Date().toISOString();
    await phone.engine.write('notification', id, { read_at: readAt });
    await phone.engine.sync();
    expect(phone.engine.snapshot).toMatchObject({ status: 'offline', pending: 1 });
    expect((await phone.store.get('notification', id))?.fields.read_at).toBe(readAt); // optimistic

    phone.net.online = true;
    await phone.engine.sync(); await desk.engine.sync();
    expect(new Date((await desk.store.get('notification', id))!.fields.read_at as string).toISOString()).toBe(readAt);
    expect((await t.http().get('/v1/notifications/unread-count').set(bearer(p.accessToken))).body.count).toBe(0);
  });

  it('server rejections are surfaced, undone locally at once, and not retried', async () => {
    const p = await t.signup('engrej');
    const phone = device(await t.login('engrej', 'partner@engrej.in', 'android'));
    const { body: { id } } = await t.http().post('/v1/notifications/test').set(bearer(p.accessToken)).expect(201);
    await phone.engine.sync();
    await phone.engine.write('notification', id, { title: 'tampered' });
    await phone.engine.sync();
    expect(phone.engine.snapshot.rejected[0]).toMatchObject({ status: 'rejected', reason: 'field_not_writable:title' });
    expect(phone.engine.snapshot.pending).toBe(0);
    expect((await phone.store.get('notification', id))?.fields.title).toBe('Test notification');
  });
});
