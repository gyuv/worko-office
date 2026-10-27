import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { JobQueueService } from '../src/jobs/job-queue.service.js';
import { PUSH_PROVIDERS, type MockPushProvider, type PushProviders } from '../src/notifications/push.providers.js';
import { SYNC_TABLES, SYNC_TABLES_TOKEN } from '../src/sync/registry.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let push: MockPushProvider;
let jobs: JobQueueService;
const runJobs = (offsetMs = 0) => jobs.runOnce(100, new Date(Date.now() + offsetMs));

beforeAll(async () => {
  t = await bootApp({
    listen: true,
    // A strict alias over `team` lets us exercise money/legal-record semantics before invoices exist.
    override: (b) => b.overrideProvider(SYNC_TABLES_TOKEN).useValue({ ...SYNC_TABLES, team_strict: { ...SYNC_TABLES.team, strict: true } }),
  });
  push = (t.app.get(PUSH_PROVIDERS) as PushProviders).webpush as MockPushProvider;
  jobs = t.app.get(JobQueueService);
}, 60_000);
afterAll(() => t?.close());

const pushM = (s: Session, mutations: unknown[]) => t.http().post('/v1/sync/push').set(bearer(s.accessToken)).send({ mutations }).expect(200).then((r) => r.body.results);
const pull = (s: Session, since = 0, limit = 500) => t.http().get(`/v1/sync/pull?since=${since}&limit=${limit}`).set(bearer(s.accessToken)).expect(200).then((r) => r.body);
const key = () => `k-${randomUUID()}`;
async function testNotification(s: Session) {
  const r = await t.http().post('/v1/notifications/test').set(bearer(s.accessToken)).expect(201);
  return r.body.id as string;
}
/** Tests must not depend on the wall clock: default quiet hours (21:00–08:00 IST) would defer pushes. */
const noQuietHours = (s: Session) => t.http().put('/v1/notifications/prefs').set(bearer(s.accessToken)).send({ quietHours: null }).expect(204);
const sendHigh = async (s: Session, title = 'Due today') => {
  const svc = t.app.get((await import('../src/notifications/notifications.service.js')).NotificationsService);
  return (await svc.send(s.tenantId, { userIds: [s.userId], category: 'task.due_today', priority: 'high', title }))[0]!;
};
async function subscribe(s: Session, endpoint = `https://push.example/${randomUUID()}`) {
  return (await t.http().post('/v1/push/subscriptions').set(bearer(s.accessToken)).send({ kind: 'webpush', endpoint, keys: { p256dh: 'k', auth: 'a' } }).expect(201)).body.id as string;
}

describe('sync push/pull', () => {
  it('inserts, pulls on another device, and dedupes replays', async () => {
    const a = await t.signup('syncone');
    const phone = await t.login('syncone', 'partner@syncone.in', 'android');
    const id = randomUUID(); const k = key();
    const m = { key: k, table: 'notification_pref', id, baseVersion: 0, patch: { prefs: { quietHours: { start: '22:00', end: '07:00' } } } };
    expect((await pushM(a, [m]))[0]).toMatchObject({ status: 'applied', version: 1 });
    expect((await pushM(a, [m]))[0]).toMatchObject({ status: 'duplicate' });
    const p = await pull(phone);
    const pref = p.changes.find((c: { id: string }) => c.id === id);
    expect(pref.fields.prefs.quietHours).toEqual({ start: '22:00', end: '07:00' });
    expect(pref.fields.user_id).toBe(a.userId); // owner forced server-side
    expect((await pull(phone, p.cursor)).changes).toEqual([]);
  });

  it('pages through changes in cursor order', async () => {
    const a = await t.signup('syncpage');
    for (let i = 0; i < 5; i++) await testNotification(a);
    const p1 = await pull(a, 0, 2);
    expect(p1).toMatchObject({ hasMore: true });
    const p2 = await pull(a, p1.cursor, 2); const p3 = await pull(a, p2.cursor, 2);
    const all = [...p1.changes, ...p2.changes, ...p3.changes].filter((c) => c.table === 'notification');
    expect(all).toHaveLength(5);
    expect(all.map((c) => c.cursor)).toEqual([...all.map((c) => c.cursor)].sort((x, y) => x - y));
  });

  it('rejects non-writable fields, foreign rows and unknown tables; never leaks other users\' rows', async () => {
    const a = await t.signup('syncperm');
    const b = await t.addUser(a, 'syncperm', 'Bina', 'senior');
    const nid = await testNotification(a);
    const res = await pushM(b, [
      { key: key(), table: 'notification', id: nid, baseVersion: 1, patch: { read_at: new Date().toISOString() } },
      { key: key(), table: 'notification', id: nid, baseVersion: 1, patch: { title: 'hacked' } },
      { key: key(), table: 'app_user', id: a.userId, baseVersion: 1, patch: { status: 'disabled' } },
    ]);
    expect(res.map((r: { status: string; reason: string }) => r.reason)).toEqual(['forbidden', 'field_not_writable:title', 'unknown_table']);
    expect((await pull(b)).changes.filter((c: { table: string }) => c.table === 'notification')).toEqual([]);
  });

  it('field-level merge: concurrent edits to different fields both survive; same field logs a conflict that can be restored', async () => {
    const a = await t.signup('syncmerge');
    const laptop = await t.login('syncmerge', 'partner@syncmerge.in', 'desktop');
    const nid = await testNotification(a);
    const v = (await pull(a)).changes.find((c: { id: string }) => c.id === nid).version;
    const later = new Date(Date.now() + 3600_000).toISOString();
    await pushM(a, [{ key: key(), table: 'notification', id: nid, baseVersion: v, patch: { read_at: '2026-10-27T10:00:00.000Z' } }]);
    await pushM(laptop, [{ key: key(), table: 'notification', id: nid, baseVersion: v, patch: { snoozed_until: later } }]);
    await pushM(laptop, [{ key: key(), table: 'notification', id: nid, baseVersion: v, patch: { read_at: '2026-10-27T11:00:00.000Z' } }]);
    const row = (await pull(a)).changes.filter((c: { id: string }) => c.id === nid).at(-1);
    expect(new Date(row.fields.snoozed_until).toISOString()).toBe(later);
    expect(new Date(row.fields.read_at).toISOString()).toBe('2026-10-27T11:00:00.000Z');
    const conflicts = (await t.http().get('/v1/sync/conflicts').set(bearer(a.accessToken)).expect(200)).body;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ table: 'notification', field: 'read_at' });
    expect(new Date(conflicts[0].lost).toISOString()).toBe('2026-10-27T10:00:00.000Z');
    await t.http().post(`/v1/sync/conflicts/${conflicts[0].id}/resolve`).set(bearer(a.accessToken)).send({ restore: true }).expect(204);
    const after = (await pull(a)).changes.filter((c: { id: string }) => c.id === nid).at(-1);
    expect(new Date(after.fields.read_at).toISOString()).toBe('2026-10-27T10:00:00.000Z');
    expect((await t.http().get('/v1/sync/conflicts').set(bearer(a.accessToken))).body).toEqual([]);
  });

  it('strict tables reject stale writes instead of merging', async () => {
    const a = await t.signup('syncstrict');
    const id = randomUUID();
    await pushM(a, [{ key: key(), table: 'team_strict', id, baseVersion: 0, patch: { name: 'Audit' } }]);
    expect((await pushM(a, [{ key: key(), table: 'team_strict', id, baseVersion: 1, patch: { name: 'Audit A' } }]))[0].status).toBe('applied');
    expect((await pushM(a, [{ key: key(), table: 'team_strict', id, baseVersion: 1, patch: { name: 'Audit B' } }]))[0]).toMatchObject({ status: 'rejected_stale', version: 2 });
  });

  it('cursor order matches commit order (a slow transaction cannot be skipped by a pull)', async () => {
    const a = await t.signup('synclock');
    const nid = await testNotification(a);
    const slow = new pg.Client({ connectionString: t.db.url }); await slow.connect();
    await slow.query('BEGIN'); await slow.query('SET LOCAL ROLE worko_app');
    await slow.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
    const slowCursor = Number((await slow.query("UPDATE notification SET body = 'slow' WHERE id = $1 RETURNING sync_cursor", [nid])).rows[0].sync_cursor);
    let fastDone = false;
    const fast = t.http().post('/v1/notifications/test').set(bearer(a.accessToken)).then((r) => { fastDone = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(fastDone).toBe(false); // blocked behind the open transaction
    await slow.query('COMMIT'); await slow.end();
    await fast;
    const changes = (await pull(a)).changes;
    const fastRow = changes.find((c: { id: string; table: string }) => c.table === 'notification' && c.id !== nid);
    expect(fastRow.cursor).toBeGreaterThan(slowCursor);
  });
});

describe('notifications & push delivery', () => {
  it('pushes to registered devices; a read on any device stops pushes to the rest', async () => {
    const a = await t.signup('pushone');
    await noQuietHours(a);
    const sub = await subscribe(a);
    await sendHigh(a);
    await runJobs();
    expect(push.sent.filter((s) => s.sub.id === sub)).toHaveLength(1);
    const n2 = await sendHigh(a, 'Second');
    await t.http().post(`/v1/notifications/${n2}/read`).set(bearer(a.accessToken)).expect(204);
    await runJobs();
    expect(push.sent.filter((s) => s.sub.id === sub)).toHaveLength(1);
    expect((await t.http().get('/v1/notifications/unread-count').set(bearer(a.accessToken))).body.count).toBe(1);
  });

  it('retries transient failures with backoff, disables gone endpoints, never double-sends', async () => {
    const a = await t.signup('pushretry');
    await noQuietHours(a);
    const ok = await subscribe(a); const dead = `https://push.example/${randomUUID()}`; const deadId = await subscribe(a, dead);
    push.gone.add(dead);
    push.failNext = 1;
    await sendHigh(a);
    await runJobs(); // first device fails transiently; the gone one is disabled
    expect(push.sent.filter((s) => s.sub.id === ok)).toHaveLength(0);
    await runJobs(); // not yet due (backoff)
    expect(push.sent.filter((s) => s.sub.id === ok)).toHaveLength(0);
    await runJobs(5 * 60_000);
    await runJobs(10 * 60_000);
    expect(push.sent.filter((s) => s.sub.id === ok)).toHaveLength(1);
    expect((await t.sql(`SELECT disabled_at FROM push_subscription WHERE id = $1`, [deadId]))[0]!.disabled_at).not.toBeNull();
  });

  it('defers pushes in quiet hours, except critical', async () => {
    const a = await t.signup('pushquiet');
    const sub = await subscribe(a);
    const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 16);
    const start = ist(new Date(Date.now() - 3600_000)); const end = ist(new Date(Date.now() + 3600_000));
    await t.http().put('/v1/notifications/prefs').set(bearer(a.accessToken)).send({ quietHours: { start, end } }).expect(204);
    await sendHigh(a); // 'high' → deferred to the end of the window
    await runJobs();
    expect(push.sent.filter((s) => s.sub.id === sub)).toHaveLength(0);
    const [job] = await t.sql<{ run_at: Date }>(`SELECT run_at FROM job_queue WHERE tenant_id = $1 AND kind = 'notification.deliver'`, [a.tenantId]);
    expect(job!.run_at.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    await testNotification(a); // test notifications are critical → immediate even in quiet hours
    await runJobs();
    expect(push.sent.filter((s) => s.sub.id === sub)).toHaveLength(1);
  });

  it('escalates unacknowledged critical alerts to the manager; acknowledging stops it', async () => {
    const p = await t.signup('escco');
    const mgr = await t.addUser(p, 'escco', 'Manoj', 'senior');
    await t.sql(`UPDATE app_user SET manager_id = $1 WHERE email = 'partner@escco.in'`, [mgr.userId]);
    const svc = t.app.get((await import('../src/notifications/notifications.service.js')).NotificationsService);
    const [n1] = await svc.send(p.tenantId, { userIds: [p.userId], category: 'notice.hearing', priority: 'high', title: 'Hearing tomorrow', requiresAck: true, escalateAfterMinutes: 30 });
    const [n2] = await svc.send(p.tenantId, { userIds: [p.userId], category: 'notice.hearing', priority: 'high', title: 'Reply due', requiresAck: true, escalateAfterMinutes: 30 });
    await t.http().post(`/v1/notifications/${n2}/ack`).set(bearer(p.accessToken)).expect(204);
    await runJobs(31 * 60_000);
    const mine = (await t.http().get('/v1/notifications').set(bearer(mgr.accessToken)).expect(200)).body;
    expect(mine.map((n: { title: string }) => n.title)).toEqual(['Escalated: Hearing tomorrow']);
    expect(mine[0]).toMatchObject({ escalationLevel: 1, requiresAck: true });
    await runJobs(31 * 60_000); // same job not repeated
    expect((await t.http().get('/v1/notifications').set(bearer(mgr.accessToken))).body).toHaveLength(1);
    expect(n1).toBeTruthy();
  });

  it('team lead is the escalation fallback and team membership drives team scope', async () => {
    const p = await t.signup('teamco');
    const lead = await t.addUser(p, 'teamco', 'Leela', 'manager');
    const art = await t.addUser(p, 'teamco', 'Arun', 'article');
    await t.http().post('/v1/teams').set(bearer(p.accessToken)).send({ name: 'GST', leadUserId: lead.userId, memberIds: [art.userId, lead.userId] }).expect(201);
    expect((await t.http().get('/v1/teams').set(bearer(p.accessToken)).expect(200)).body[0]).toMatchObject({ name: 'GST', leadUserId: lead.userId });
    await t.http().get('/v1/teams').set(bearer(art.accessToken)).expect(403);
    const svc = t.app.get((await import('../src/notifications/notifications.service.js')).NotificationsService);
    await svc.send(p.tenantId, { userIds: [art.userId], category: 'task.overdue', priority: 'critical', title: 'GSTR-3B overdue', requiresAck: true, escalateAfterMinutes: 10 });
    await runJobs(11 * 60_000);
    const leadInbox = (await t.http().get('/v1/notifications').set(bearer(lead.accessToken))).body;
    expect(leadInbox.map((n: { title: string }) => n.title)).toContain('Escalated: GSTR-3B overdue');
  });
});

describe('realtime change feed', () => {
  const connect = async (token: string) => {
    const addr = t.app.getHttpServer().address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/realtime`);
    const msgs: Array<Record<string, unknown>> = [];
    let closeCode = 0;
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    ws.on('close', (c) => (closeCode = c));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'auth', token }));
    const wait = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20)); return pred(); };
    return { ws, msgs, wait, closeCode: () => closeCode };
  };

  it('pushes change hints to the right user within the tenant, and kicks revoked sessions', async () => {
    const a = await t.signup('rtone');
    const b = await t.addUser(a, 'rtone', 'Bala', 'senior');
    const laptop = await t.login('rtone', 'partner@rtone.in', 'desktop');
    const ca = await connect(laptop.accessToken); const cb = await connect(b.accessToken);
    expect(await ca.wait(() => ca.msgs.some((m) => m.type === 'ready'))).toBe(true);
    await testNotification(a); // only for partner
    expect(await ca.wait(() => ca.msgs.some((m) => m.type === 'changed'))).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(cb.msgs.filter((m) => m.type === 'changed')).toHaveLength(0);
    await t.http().post(`/v1/auth/sessions/${laptop.sessionId}/wipe`).set(bearer(a.accessToken)).expect(204);
    expect(await ca.wait(() => ca.msgs.some((m) => m.type === 'revoked' && m.wipe === true))).toBe(true);
    expect(await ca.wait(() => ca.closeCode() === 4403)).toBe(true);
    cb.ws.close();
  });

  it('rejects bad tokens and revoked sessions', async () => {
    const bad = await connect('nope');
    expect(await bad.wait(() => bad.closeCode() === 4401)).toBe(true);
    const a = await t.signup('rttwo');
    await t.http().post('/v1/auth/logout').set(bearer(a.accessToken)).expect(204);
    const c = await connect(a.accessToken);
    expect(await c.wait(() => c.closeCode() === 4401)).toBe(true);
  });

  it('revoking a session disables its push subscriptions', async () => {
    const a = await t.signup('rtpush');
    const phone = await t.login('rtpush', 'partner@rtpush.in', 'android');
    const sub = await subscribe(phone);
    await t.http().post(`/v1/auth/sessions/${phone.sessionId}/revoke`).set(bearer(a.accessToken)).expect(204);
    expect((await t.sql(`SELECT disabled_at FROM push_subscription WHERE id = $1`, [sub]))[0]!.disabled_at).not.toBeNull();
  });
});
