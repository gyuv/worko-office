import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../src/auth/crypto.js';
import { DEV_WEBHOOK_SECRET, hmacHex } from '../src/billing/providers.js';
import { DbService } from '../src/db/db.service.js';
import { createPlatformAdmin } from '../src/platform/platform-auth.service.js';
import { bearer, bootApp, PW, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let admin: string; let tenantId: string;
const SECRET = Buffer.from('saas-test-secret-000000000', 'utf8');
const H = (s: { accessToken: string }) => bearer(s.accessToken);
const run = async (today: string) => (await t.http().post(`/v1/platform/tenants/${tenantId}/lifecycle/run`).set(bearer(admin)).send({ today }).expect(200)).body;
const sub = async () => (await t.http().get('/v1/subscription').set(H(P)).expect(200)).body;
const webhook = (body: Record<string, unknown>) => {
  const raw = JSON.stringify(body);
  return t.http().post('/v1/saas/webhooks/mock').set('Content-Type', 'application/json').set('x-worko-signature', hmacHex(process.env.PAYMENT_WEBHOOK_SECRET || DEV_WEBHOOK_SECRET, Buffer.from(raw))).send(raw);
};

beforeAll(async () => {
  t = await bootApp();
  await t.app.get(DbService).systemTx((tx) => createPlatformAdmin(tx, { email: 'billing-ops@worko.example', name: 'Billing Ops', password: PW, secret: SECRET }));
  admin = (await t.http().post('/v1/platform/auth/login').send({ email: 'billing-ops@worko.example', password: PW, totp: totp(SECRET) }).expect(200)).body.accessToken;
  P = await t.signup('saasco');
  tenantId = P.tenantId;
  await t.sql(`UPDATE tenant SET trial_ends_on = '2026-10-31' WHERE id = $1`, [tenantId]);
  // Worko's GST registration is data (sample); intra-state with the firm (27) → CGST + SGST.
  await t.sql(`UPDATE platform_setting SET value = value || '{"gstin":"27AAACW0000A1Z5"}' WHERE key = 'saas.supplier'`);
}, 60_000);
afterAll(() => t?.close());

describe('seats', () => {
  it('adding staff beyond the plan seats is refused with a clear error; portal users count only when the plan says so', async () => {
    await t.http().put(`/v1/platform/tenants/${tenantId}/plan`).set(bearer(admin)).send({ planKey: 'starter' }).expect(200);
    for (const n of ['Asha', 'Bala', 'Chitra', 'Dev']) await t.addUser(P, 'saasco', n, 'article');
    expect((await sub()).usage).toMatchObject({ seatsUsed: 5, seatLimit: 5 });
    const r = await t.http().post('/v1/users').set(H(P)).send({ name: 'Esha', email: 'esha@saasco.in', password: PW, roleKeys: ['article'] }).expect(402);
    expect(r.body).toMatchObject({ code: 'SEAT_LIMIT', used: 5, limit: 5 });
    expect(r.body.message).toMatch(/plan includes 5 seats/);
    const [dev] = await t.sql<{ id: string }>(`SELECT id FROM app_user WHERE email = 'dev@saasco.in'`);
    await t.http().patch(`/v1/users/${dev!.id}`).set(H(P)).send({ status: 'disabled' }).expect(204);
    await t.addUser(P, 'saasco', 'Esha', 'article');
    expect((await t.http().patch(`/v1/users/${dev!.id}`).set(H(P)).send({ status: 'active' }).expect(402)).body.code).toBe('SEAT_LIMIT');
    // a portal user doesn't take a seat on starter…
    await t.sql(`INSERT INTO portal_user (id, tenant_id, name, email, status) VALUES (gen_random_uuid(), $1, 'Portal Person', 'pp@example.in', 'active')`, [tenantId]);
    expect((await sub()).usage.seatsUsed).toBe(5);
    // …but does on a plan that says so (plans are data)
    await t.http().put('/v1/platform/plans/tiny').set(bearer(admin)).send({ name: 'Tiny', seats: 7, storageGb: 1, portalUsersCountAsSeats: true, modules: { portal: true, leads: true, reports: true } }).expect(200);
    await t.http().put(`/v1/platform/tenants/${tenantId}/plan`).set(bearer(admin)).send({ planKey: 'tiny' }).expect(200);
    expect((await sub()).usage).toMatchObject({ seatsUsed: 6, seatLimit: 7 });
    // a super-admin seat override beats the plan
    await t.http().put(`/v1/platform/tenants/${tenantId}/plan`).set(bearer(admin)).send({ planKey: 'starter', seatLimit: 10 }).expect(200);
    expect((await sub()).usage.seatLimit).toBe(10);
    await t.http().put(`/v1/platform/tenants/${tenantId}/plan`).set(bearer(admin)).send({ planKey: 'trial', seatLimit: null }).expect(200);
  });
});

describe('subscription lifecycle (pinned dates)', () => {
  let inv1: { id: string; number: string; totalPaise: number; paymentUrl: string };
  it('trial → invoice at trial end (GST via billing helpers, payment link) → idempotent per day', async () => {
    expect((await run('2026-10-31'))).toMatchObject({ status: 'trial', actions: [] });
    const r = await run('2026-11-01');
    expect(r).toMatchObject({ status: 'trial', actions: ['issue_invoice'] });
    expect((await run('2026-11-01')).actions).toEqual([]);
    const s = await sub();
    expect(s.subscription.plan).toBe('starter'); // trial converts to the configured plan
    expect(s.invoices).toHaveLength(1);
    inv1 = s.invoices[0];
    expect(inv1).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-11-30', dueDate: '2026-11-08', supplyType: 'intra', taxablePaise: 99900, cgstPaise: 8991, sgstPaise: 8991, igstPaise: 0, totalPaise: 117900, status: 'issued' });
    expect(inv1.number).toMatch(/^WKO\/2627\/\d{5}$/);
    expect(inv1.paymentUrl).toMatch(/^https:\/\/pay\.example\.invalid\//);
  });

  it('unpaid past due → past_due with dunning reminders → suspended after grace (logins blocked, data kept)', async () => {
    expect((await run('2026-11-08')).reminders).toBe(1);
    expect((await run('2026-11-08')).reminders).toBe(0);
    expect((await run('2026-11-09')).status).toBe('past_due');
    expect((await run('2026-11-11')).reminders).toBe(1);
    const notes = await t.sql(`SELECT title FROM notification WHERE tenant_id = $1 AND entity_type = 'saas_invoice'`, [tenantId]);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    await t.http().get('/v1/me').set(H(P)).expect(200); // past_due still works
    expect((await run('2026-11-24')).status).toBe('suspended');
    expect((await t.http().get('/v1/me').set(H(P)).expect(403)).body.code).toBe('TENANT_SUSPENDED');
    await t.http().post('/v1/auth/login').send({ firm: 'saasco', email: 'partner@saasco.in', password: PW, device: { platform: 'web' } }).expect(403);
  });

  it('payment webhook (signed, deduplicated) activates the subscription for the invoice period', async () => {
    const [link] = await t.sql<{ link_id: string }>('SELECT link_id FROM saas_payment_link WHERE invoice_id = $1', [inv1.id]);
    await t.http().post('/v1/saas/webhooks/mock').set('x-worko-signature', 'bad').send({ id: 'e0', type: 'payment.captured' }).expect(401);
    const ev = { id: 'evt_1', type: 'payment.captured', linkId: link!.link_id, paymentId: 'pay_1', amountPaise: inv1.totalPaise };
    expect((await webhook(ev).expect(200)).body).toMatchObject({ paid: true, status: 'active' });
    expect((await webhook(ev).expect(200)).body.duplicate).toBe(true);
    await t.http().get('/v1/me').set(H(P)).expect(200);
    const s = await sub();
    expect(s.subscription).toMatchObject({ subStatus: 'active', periodStart: '2026-11-01', periodEnd: '2026-11-30' });
    expect(s.invoices[0].status).toBe('paid');
  });

  it('renewal at period end; cancelled after long suspension; an offline payment reactivates', async () => {
    expect((await run('2026-11-30')).actions).toEqual([]);
    expect((await run('2026-12-01'))).toMatchObject({ status: 'active', actions: ['issue_invoice'] });
    const dec = (await sub()).invoices[0];
    expect(dec).toMatchObject({ periodStart: '2026-12-01', periodEnd: '2026-12-31' });
    expect((await run('2026-12-09')).status).toBe('past_due');
    expect((await run('2026-12-24')).status).toBe('suspended');
    expect((await run('2027-02-22')).status).toBe('cancelled');
    expect((await run('2027-03-01')).actions).toEqual([]);
    expect((await t.http().post(`/v1/platform/tenants/${tenantId}/invoices/${dec.id}/mark-paid`).set(bearer(admin)).expect(200)).body.status).toBe('active');
    await t.http().get('/v1/me').set(H(P)).expect(200);
    const audit = await t.sql<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'subscription.%'`, [tenantId]);
    expect(new Set(audit.map((x) => x.action))).toEqual(new Set(['subscription.invoice_issued', 'subscription.dunning_sent', 'subscription.status_changed', 'subscription.invoice_paid']));
  });

  it('usage is metered per month and the firm can ask for an upgrade', async () => {
    const months = await t.sql<{ month: string }>('SELECT month FROM saas_usage WHERE tenant_id = $1 ORDER BY month', [tenantId]);
    expect(months.map((m) => m.month)).toEqual(expect.arrayContaining(['2026-11', '2026-12']));
    const s = await sub();
    expect(s.plans.map((p: { key: string }) => p.key)).not.toContain('trial');
    await t.http().post('/v1/subscription/upgrade-requests').set(H(P)).send({ planKey: 'professional', cycle: 'annual', note: 'Need AI' }).expect(201);
    await t.http().post('/v1/subscription/upgrade-requests').set(H(P)).send({ planKey: 'nope', cycle: 'annual' }).expect(400);
    const d = (await t.http().get(`/v1/platform/tenants/${tenantId}`).set(bearer(admin)).expect(200)).body;
    expect(d.upgradeRequests[0]).toMatchObject({ planKey: 'professional', status: 'open' });
    expect(d.history.length).toBeGreaterThanOrEqual(2);
  });
});
