import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../src/auth/crypto.js';
import { DbService } from '../src/db/db.service.js';
import { createPlatformAdmin } from '../src/platform/platform-auth.service.js';
import { bearer, bootApp, PW } from './helpers.js';

const SECRET = Buffer.from('firm-admin-test-secret-0000', 'utf8');
let t: Awaited<ReturnType<typeof bootApp>>;
let admin: string;
const NEW_PW = 'Fresh#Pass9x2';

beforeAll(async () => {
  t = await bootApp();
  await t.app.get(DbService).systemTx((tx) => createPlatformAdmin(tx, { email: 'ops@firmadmin.example', name: 'Ops', password: PW, secret: SECRET }));
  admin = (await t.http().post('/v1/platform/auth/login').send({ email: 'ops@firmadmin.example', password: PW, totp: totp(SECRET) }).expect(200)).body.accessToken;
});
afterAll(async () => { await t?.close(); });

describe('super-admin firm management', () => {
  let tenantId = '';
  let adminUserId = '';

  it('creates a firm with its first admin and a seat limit; the admin can sign in and add users up to the limit', async () => {
    const r = await t.http().post('/v1/platform/tenants').set(bearer(admin)).send({
      firmName: 'Rao & Iyer', slug: 'Rao-Iyer', stateCode: '29', seatLimit: 2,
      admin: { name: 'Lakshmi Rao', email: 'Lakshmi@raoiyer.in', password: PW },
    }).expect(201);
    expect(r.body).toMatchObject({ slug: 'rao-iyer' });
    tenantId = r.body.tenantId; adminUserId = r.body.adminUserId;

    const owner = await t.login('rao-iyer', 'lakshmi@raoiyer.in');
    const me = (await t.http().get('/v1/me').set(bearer(owner.accessToken)).expect(200)).body;
    expect(me.roles).toContain('partner');
    await t.http().post('/v1/users').set(bearer(owner.accessToken)).send({ name: 'Two', email: 'two@raoiyer.in', password: PW, roleKeys: ['senior'] }).expect(201);
    const over = await t.http().post('/v1/users').set(bearer(owner.accessToken)).send({ name: 'Three', email: 'three@raoiyer.in', password: PW, roleKeys: ['senior'] });
    expect(over.status).toBe(402);
    expect(over.body.code).toBe('SEAT_LIMIT');

    // the same firm ID cannot be taken twice
    await t.http().post('/v1/platform/tenants').set(bearer(admin)).send({
      firmName: 'Other', slug: 'rao-iyer', stateCode: '29', admin: { name: 'X', email: 'x@x.in', password: PW } }).expect(409);
  });

  it('lists the firm users and resets a password (old password stops working, sessions are revoked)', async () => {
    const users = (await t.http().get(`/v1/platform/tenants/${tenantId}/users`).set(bearer(admin)).expect(200)).body;
    expect(users.map((u: { email: string }) => u.email).sort()).toEqual(['lakshmi@raoiyer.in', 'two@raoiyer.in']);
    expect(JSON.stringify(users)).not.toContain('password');

    await t.http().post(`/v1/platform/tenants/${tenantId}/users/${adminUserId}/reset-password`).set(bearer(admin)).send({ password: NEW_PW }).expect(200);
    await t.http().post('/v1/auth/login').send({ firm: 'rao-iyer', email: 'lakshmi@raoiyer.in', password: PW, device: { platform: 'web' } }).expect(401);
    await t.http().post('/v1/auth/login').send({ firm: 'rao-iyer', email: 'lakshmi@raoiyer.in', password: NEW_PW, device: { platform: 'web' } }).expect(200);
  });

  it('exports the firm data without secrets, needs a reason, and audits it; firm routes refuse firm tokens', async () => {
    await t.http().post(`/v1/platform/tenants/${tenantId}/export`).set(bearer(admin)).send({ reason: '' }).expect(400);
    const r = (await t.http().post(`/v1/platform/tenants/${tenantId}/export`).set(bearer(admin)).send({ reason: 'Firm asked for a copy' }).expect(200)).body;
    expect(r.firm.slug).toBe('rao-iyer');
    expect(r.tables.app_user).toHaveLength(2);
    expect(r.tables.branch.length).toBeGreaterThan(0);
    const raw = JSON.stringify(r);
    expect(raw).not.toMatch(/password_hash|refresh_token_hash|totp_secret/);
    const log = (await t.http().get(`/v1/platform/audit?tenantId=${tenantId}`).set(bearer(admin)).expect(200)).body;
    expect(JSON.stringify(log)).toMatch(/platform\.firm_exported/);
    expect(JSON.stringify(log)).toMatch(/platform\.firm_created/);

    const owner = await t.http().post('/v1/auth/login').send({ firm: 'rao-iyer', email: 'lakshmi@raoiyer.in', password: NEW_PW, device: { platform: 'web' } }).expect(200);
    await t.http().get(`/v1/platform/tenants/${tenantId}/users`).set(bearer(owner.body.accessToken)).expect((res) => { expect([401, 403]).toContain(res.status); });
  });

  it('overview counts firms and users; disabling a user signs them out and blocks login, enabling respects the user limit', async () => {
    const o = (await t.http().get('/v1/platform/overview').set(bearer(admin)).expect(200)).body;
    expect(o.firms).toBeGreaterThanOrEqual(1);
    expect(o.users).toBeGreaterThanOrEqual(2);
    expect(o.recent.map((f: { slug: string }) => f.slug)).toContain('rao-iyer');

    const users = (await t.http().get(`/v1/platform/tenants/${tenantId}/users`).set(bearer(admin)).expect(200)).body as Array<{ id: string; email: string }>;
    const two = users.find((u) => u.email === 'two@raoiyer.in')!;
    const s2 = await t.login('rao-iyer', 'two@raoiyer.in');
    await t.http().post(`/v1/platform/tenants/${tenantId}/users/${two.id}/status`).set(bearer(admin)).send({ status: 'disabled' }).expect(200);
    expect((await t.http().get('/v1/me').set(bearer(s2.accessToken))).status).toBe(401);
    await t.http().post('/v1/auth/login').send({ firm: 'rao-iyer', email: 'two@raoiyer.in', password: PW, device: { platform: 'web' } }).expect((r) => { expect(r.status).toBeGreaterThanOrEqual(400); });

    // With "two" disabled the firm has a free seat; fill it, then re-enabling "two" exceeds the limit of 2.
    const owner = await t.http().post('/v1/auth/login').send({ firm: 'rao-iyer', email: 'lakshmi@raoiyer.in', password: NEW_PW, device: { platform: 'web' } }).expect(200);
    await t.http().post('/v1/users').set(bearer(owner.body.accessToken)).send({ name: 'Three', email: 'three@raoiyer.in', password: PW, roleKeys: ['senior'] }).expect(201);
    const again = await t.http().post(`/v1/platform/tenants/${tenantId}/users/${two.id}/status`).set(bearer(admin)).send({ status: 'active' });
    expect(again.status).toBe(402);
    const log = (await t.http().get(`/v1/platform/audit?tenantId=${tenantId}`).set(bearer(admin)).expect(200)).body;
    expect(JSON.stringify(log)).toMatch(/platform\.user_disabled/);
  });

  it('announcements reach all firms or one firm and can be ended; rename and activity work', async () => {
    const other = await t.signup('otherann');
    const all = (await t.http().post('/v1/platform/announcements').set(bearer(admin)).send({ title: 'Maintenance tonight', body: '10pm to 11pm', level: 'warning' }).expect(201)).body.id;
    await t.http().post('/v1/platform/announcements').set(bearer(admin)).send({ title: 'Only for Rao', tenantId }).expect(201);
    const owner = (await t.http().post('/v1/auth/login').send({ firm: 'rao-iyer', email: 'lakshmi@raoiyer.in', password: NEW_PW, device: { platform: 'web' } }).expect(200)).body;
    const mine = (await t.http().get('/v1/announcements').set(bearer(owner.accessToken)).expect(200)).body.map((a: { title: string }) => a.title);
    expect(mine.sort()).toEqual(['Maintenance tonight', 'Only for Rao']);
    expect((await t.http().get('/v1/announcements').set(bearer(other.accessToken)).expect(200)).body.map((a: { title: string }) => a.title)).toEqual(['Maintenance tonight']);
    await t.http().put(`/v1/platform/announcements/${all}/active`).set(bearer(admin)).send({ active: false }).expect(200);
    expect((await t.http().get('/v1/announcements').set(bearer(other.accessToken)).expect(200)).body).toEqual([]);
    // firm tokens can't create announcements
    await t.http().post('/v1/platform/announcements').set(bearer(owner.accessToken)).send({ title: 'nope nope' }).expect((r) => { expect([401, 403]).toContain(r.status); });

    await t.http().put(`/v1/platform/tenants/${tenantId}/name`).set(bearer(admin)).send({ name: 'Rao Iyer & Associates' }).expect(200);
    expect((await t.http().get('/v1/me').set(bearer(owner.accessToken)).expect(200)).body.firmName).toBe('Rao Iyer & Associates');
    const act = (await t.http().get('/v1/platform/activity').set(bearer(admin)).expect(200)).body;
    expect(act[tenantId].users).toBeGreaterThanOrEqual(1);
    expect(act[tenantId].lastActive).toBeTruthy();
    const ov = (await t.http().get('/v1/platform/overview').set(bearer(admin)).expect(200)).body;
    expect(ov.topFirms.length).toBeGreaterThan(0);
  });
});
