import { verifyWebhookSignature } from '@worko/domain';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobQueueService } from '../src/jobs/job-queue.service.js';
import { WEBHOOK_TRANSPORT, type WebhookTransport } from '../src/publicapi/transport.js';
import { bearer, bootApp, type Session } from './helpers.js';

/** Records requests instead of opening sockets; DNS answers are scripted per host (rebinding tests). */
class MockTransport implements WebhookTransport {
  dns = new Map<string, string[]>();
  status = 200;
  calls: Array<{ url: string; address: string; headers: Record<string, string>; body: string }> = [];
  async resolve(host: string) { return this.dns.get(host) ?? ['93.184.216.34']; }
  async post(o: { url: URL; address: string; headers: Record<string, string>; body: string }) { this.calls.push({ url: o.url.toString(), address: o.address, headers: o.headers, body: o.body }); return { status: this.status }; }
}
const mock = new MockTransport();
let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => { t = await bootApp({ override: (b) => b.overrideProvider(WEBHOOK_TRANSPORT).useValue(mock) }); }, 60_000);
afterAll(() => t?.close());
beforeEach(() => { mock.calls = []; mock.status = 200; mock.dns.clear(); process.env.WEBHOOK_MAX_ATTEMPTS = '3'; process.env.WEBHOOK_DISABLE_AFTER = '2'; });

const H = (s: Session) => bearer(s.accessToken);
const T0 = new Date('2026-11-02T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
/** Drains everything due at `now` (fan-out jobs enqueue delivery jobs). */
const run = async (now: Date) => { for (let i = 0; i < 10 && (await t.app.get(JobQueueService).runOnce(200, now)) > 0; i++); };
let pan = 7000;
async function mkClient(s: Session) {
  const name = `Ramesh Traders ${pan}`;
  const r = await t.http().post('/v1/clients').set(H(s)).send({ name, entityType: 'INDIVIDUAL', pan: `ABCPR${pan++}Q`, phone: '+919811000001', email: 'ramesh@example.com' }).expect(201);
  return { id: r.body.id as string, name };
}
async function hook(s: Session, body: Record<string, unknown> = {}) {
  const r = await t.http().post('/v1/developers/webhooks').set(H(s)).send({ name: 'ERP', url: 'https://hooks.example.com/worko', events: ['task.created', 'task.status_changed'], ...body });
  if (r.status !== 201) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { subscription: { id: string }; secret: string };
}
const deliveries = async (s: Session, id: string) => (await t.http().get(`/v1/developers/webhooks/${id}/deliveries`).set(H(s)).expect(200)).body.items;

describe('webhooks', () => {
  it('rejects non-https and SSRF targets (literal, encoded, IPv6, metadata, private DNS)', async () => {
    const p = await t.signup('wh1');
    const post = (url: string) => t.http().post('/v1/developers/webhooks').set(H(p)).send({ name: 'x', url, events: ['task.created'] });
    await post('http://hooks.example.com/x').expect(400);
    await post('https://user:pw@hooks.example.com/x').expect(400);
    for (const url of ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://10.1.2.3/x', 'https://2130706433/x', 'https://0x7f.1/x',
      'https://[::ffff:127.0.0.1]/x', 'https://localhost/x', 'https://metadata.google.internal/x']) {
      const r = await post(url);
      expect([url, r.status, r.body.code]).toEqual([url, 400, 'blocked_address']);
    }
    mock.dns.set('intranet.example.com', ['93.184.216.34', '10.0.0.5']);
    expect((await post('https://intranet.example.com/x').expect(400)).body.code).toBe('blocked_address');
    await post('https://hooks.example.com/x').expect(201);
  });

  it('delivers signed, scoped envelopes with ids only; verifiable within the replay window', async () => {
    const p = await t.signup('wh2');
    const { subscription, secret } = await hook(p);
    const c = await mkClient(p);
    const task = (await t.http().post('/v1/tasks').set(H(p)).send({ title: 'GSTR-3B Oct', client_id: c.id }).expect(201)).body;
    await t.http().patch(`/v1/tasks/${task.id}`).set(H(p)).send({ status: 'in_progress' }).expect(204);
    await run(T0);
    expect(mock.calls.map((x) => JSON.parse(x.body).type)).toEqual(['task.created', 'task.status_changed']);
    const call = mock.calls[1]!;
    expect(call.address).toBe('93.184.216.34');
    const env = JSON.parse(call.body);
    expect(env.data).toEqual({ entityType: 'task', entityId: task.id, clientId: c.id, from: 'open', to: 'in_progress' });
    for (const pii of [c.name, 'ramesh@example.com', '9811000001', 'ABCPR']) expect(call.body).not.toContain(pii);
    const mac = (x: string) => createHmac('sha256', secret).update(x).digest('hex');
    const nowSec = Math.floor(T0.getTime() / 1000);
    expect(call.headers['worko-timestamp']).toBe(String(nowSec));
    expect(verifyWebhookSignature({ header: call.headers['worko-signature'], body: call.body, nowSec: nowSec + 60, hmacHex: mac })).toEqual({ ok: true, timestamp: nowSec });
    expect(verifyWebhookSignature({ header: call.headers['worko-signature'], body: call.body, nowSec: nowSec + 3600, hmacHex: mac })).toEqual({ ok: false, reason: 'stale' });
    expect(verifyWebhookSignature({ header: call.headers['worko-signature'], body: call.body.replace('in_progress', 'done'), nowSec, hmacHex: mac }).ok).toBe(false);
    const log = await deliveries(p, subscription.id);
    expect(log.map((d: { status: string; lastStatusCode: number }) => [d.status, d.lastStatusCode])).toEqual([['succeeded', 200], ['succeeded', 200]]);
    // Log rows hold the id-only envelope, never names or contacts.
    const rows = await t.sql<{ e: string }>('SELECT envelope::text AS e FROM webhook_delivery');
    for (const r of rows) for (const pii of [c.name, 'ramesh@example.com']) expect(r.e).not.toContain(pii);
    const enc = await t.sql<{ secret_enc: Buffer }>('SELECT secret_enc FROM webhook_subscription WHERE id = $1', [subscription.id]);
    expect(enc[0]!.secret_enc.toString('latin1')).not.toContain(secret);

    // Ping + redelivery go through the same signed path.
    await t.http().post(`/v1/developers/webhooks/${subscription.id}/ping`).set(H(p)).expect(202);
    const re = (await t.http().post(`/v1/developers/webhook-deliveries/${log[0].id}/redeliver`).set(H(p)).expect(202)).body;
    await run(T0);
    expect(mock.calls.slice(2).map((x) => JSON.parse(x.body).type).sort()).toEqual(['ping', log[0].eventType].sort());
    expect((await deliveries(p, subscription.id)).find((d: { id: string }) => d.id === re.id)).toMatchObject({ redeliveryOf: log[0].id, status: 'succeeded' });
  });

  it('payload respects the subscription creator\'s scope; inactive creators get nothing', async () => {
    const p = await t.signup('wh3');
    const admin = await t.addUser(p, 'wh3', 'Officeadmin', 'admin'); // settings:edit but no tasks:view
    const a = await hook(admin);
    const c = await mkClient(p);
    await t.http().post('/v1/tasks').set(H(p)).send({ title: 'TDS Q2', client_id: c.id }).expect(201);
    await run(T0);
    expect(mock.calls).toHaveLength(0);
    expect((await deliveries(p, a.subscription.id))[0]).toMatchObject({ status: 'skipped', lastError: 'out_of_scope' });
    const ok = await hook(p);
    await t.http().post('/v1/tasks').set(H(p)).send({ title: 'TDS Q3', client_id: c.id }).expect(201);
    await t.sql(`UPDATE app_user SET status = 'inactive' WHERE id = $1`, [p.userId]); // before fan-out runs
    await run(T0);
    expect(mock.calls).toHaveLength(0);
    expect(await deliveries(admin, ok.subscription.id)).toHaveLength(0);
  });

  it('retries with exponential backoff on an injected clock, then auto-disables; DNS rebinding is blocked at delivery', async () => {
    const p = await t.signup('wh4');
    const { subscription } = await hook(p, { events: ['task.created'] });
    const c = await mkClient(p);
    mock.status = 500;
    await t.http().post('/v1/tasks').set(H(p)).send({ title: 'ROC', client_id: c.id }).expect(201);
    await run(T0);
    let d = (await deliveries(p, subscription.id))[0];
    expect(d).toMatchObject({ status: 'retrying', attempts: 1, lastStatusCode: 500, lastError: 'http_500', nextAttemptAt: at(30_000).toISOString() });
    await run(at(29_000));
    expect(mock.calls).toHaveLength(1);
    await run(at(30_000));
    d = (await deliveries(p, subscription.id))[0];
    expect(d).toMatchObject({ status: 'retrying', attempts: 2, nextAttemptAt: at(30_000 + 120_000).toISOString() });
    await run(at(150_000));
    d = (await deliveries(p, subscription.id))[0];
    expect(d).toMatchObject({ status: 'failed', attempts: 3, nextAttemptAt: null });
    expect(mock.calls).toHaveLength(3);
    let sub = (await t.http().get('/v1/developers/webhooks').set(H(p))).body.items[0];
    expect(sub).toMatchObject({ status: 'active', consecutiveFailures: 1 });

    // Second exhausted delivery → auto-disabled (WEBHOOK_DISABLE_AFTER=2).
    await t.http().post('/v1/tasks').set(H(p)).send({ title: 'ROC 2', client_id: c.id }).expect(201);
    for (const ms of [0, 30_000, 150_000]) await run(at(ms));
    sub = (await t.http().get('/v1/developers/webhooks').set(H(p))).body.items[0];
    expect(sub).toMatchObject({ status: 'disabled', disabledReason: 'too_many_failures', consecutiveFailures: 2 });
    const audit = await t.sql<{ action: string }>(`SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'webhook.auto_disable'`, [subscription.id]);
    expect(audit).toHaveLength(1);
    // Disabled: no new events are even emitted for it.
    await t.http().post('/v1/tasks').set(H(p)).send({ title: 'ROC 3', client_id: c.id }).expect(201);
    await run(at(200_000));
    expect(mock.calls).toHaveLength(6);

    // Re-enable; the host now resolves to loopback (rebinding) → never sent.
    await t.http().patch(`/v1/developers/webhooks/${subscription.id}`).set(H(p)).send({ active: true }).expect(200);
    mock.status = 200;
    mock.dns.set('hooks.example.com', ['127.0.0.1']);
    await t.http().post('/v1/tasks').set(H(p)).send({ title: 'ROC 4', client_id: c.id }).expect(201);
    await run(at(300_000));
    expect(mock.calls).toHaveLength(6);
    expect((await deliveries(p, subscription.id))[0]).toMatchObject({ lastError: 'blocked_address', lastStatusCode: null });
    mock.dns.set('hooks.example.com', ['::ffff:a9fe:a9fe']);
    await run(at(400_000));
    expect(mock.calls).toHaveLength(6);
  });
});
