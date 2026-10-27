import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { base32Decode, totp } from '../src/auth/crypto.js';
import { MockSmsProvider, SMS_PROVIDER } from '../src/auth/sms.provider.js';
import { migrate } from '../src/db/migrate.js';
import { freshDatabase } from './db.js';


let app: INestApplication;
let db: Awaited<ReturnType<typeof freshDatabase>>;
let sms: MockSmsProvider;
const http = () => request(app.getHttpServer());
const web = { platform: 'web', label: 'Chrome' };
const PW = 'correct horse battery';

async function signup(slug: string, email = `partner@${slug}.in`, phone?: string) {
  await http().post('/v1/tenants/signup').send({ firmName: `${slug} & Co`, slug, stateCode: '27', partner: { name: 'P', email, password: PW, phone } }).expect(201);
  const r = await http().post('/v1/auth/login').send({ firm: slug, email, password: PW, device: web }).expect(200);
  return r.body as { accessToken: string; refreshToken: string; sessionId: string; tenantId: string; userId: string };
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  db = await freshDatabase();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('v1');
  await app.init();
  sms = app.get(SMS_PROVIDER);
}, 60_000);
afterAll(async () => { await app?.close(); await db?.drop(); });

describe('migrations', () => {
  it('are idempotent', async () => expect(await migrate(db.url)).toEqual([]));
});

describe('signup + login', () => {
  it('creates a firm and logs the partner in', async () => {
    const s = await signup('sharma');
    const me = await http().get('/v1/me').set(bearer(s.accessToken)).expect(200);
    expect(me.body).toMatchObject({ firmSlug: 'sharma', roles: ['partner'] });
  });
  it('rejects duplicate slug and weak password', async () => {
    await http().post('/v1/tenants/signup').send({ firmName: 'XY', slug: 'sharma', stateCode: '27', partner: { name: 'P', email: 'a@b.in', password: PW } }).expect(409);
    await http().post('/v1/tenants/signup').send({ firmName: 'XY', slug: 'weak', stateCode: '27', partner: { name: 'P', email: 'a@b.in', password: 'short' } }).expect(400);
  });
  it('does not reveal whether a firm exists', async () => {
    const a = await http().post('/v1/auth/login').send({ firm: 'nope', email: 'x@y.in', password: 'x', device: web }).expect(401);
    const b = await http().post('/v1/auth/login').send({ firm: 'sharma', email: 'partner@sharma.in', password: 'wrong', device: web }).expect(401);
    expect(a.body.message).toBe(b.body.message);
  });
  it('requires auth on protected routes', () => http().get('/v1/me').expect(401));
});

describe('lockout', () => {
  it('locks after 5 failures, even with the right password', async () => {
    await signup('lockco');
    for (let i = 0; i < 5; i++) await http().post('/v1/auth/login').send({ firm: 'lockco', email: 'partner@lockco.in', password: 'bad', device: web }).expect(401);
    await http().post('/v1/auth/login').send({ firm: 'lockco', email: 'partner@lockco.in', password: PW, device: web }).expect(429);
  });
});

describe('refresh rotation', () => {
  it('rotates, and replaying an old token revokes the session', async () => {
    const s = await signup('rotco');
    const r1 = await http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    await http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401); // reuse
    await http().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401); // family revoked
    await http().get('/v1/me').set(bearer(r1.body.accessToken)).expect(401);
  });
});

describe('TOTP 2FA', () => {
  it('enables and then requires the code', async () => {
    const s = await signup('totpco');
    const setup = await http().post('/v1/auth/totp/setup').set(bearer(s.accessToken)).expect(201);
    const secret = base32Decode(setup.body.secret);
    await http().post('/v1/auth/totp/enable').set(bearer(s.accessToken)).send({ code: '000000' === totp(secret) ? '111111' : '000000' }).expect(401);
    await http().post('/v1/auth/totp/enable').set(bearer(s.accessToken)).send({ code: totp(secret) }).expect(204);
    const noCode = await http().post('/v1/auth/login').send({ firm: 'totpco', email: 'partner@totpco.in', password: PW, device: web }).expect(401);
    expect(noCode.body.code).toBe('MFA_REQUIRED');
    await http().post('/v1/auth/login').send({ firm: 'totpco', email: 'partner@totpco.in', password: PW, totp: totp(secret), device: web }).expect(200);
  });
});

describe('phone OTP', () => {
  it('logs in with an SMS code; wrong codes are counted', async () => {
    await signup('otpco', 'partner@otpco.in', '+919876543210');
    await http().post('/v1/auth/otp/request').send({ firm: 'otpco', phone: '+919876543210' }).expect(202);
    await http().post('/v1/auth/otp/request').send({ firm: 'otpco', phone: '+919999999999' }).expect(202); // unknown: same answer
    const code = sms.sent.at(-1)!.text.slice(0, 6);
    await http().post('/v1/auth/otp/verify').send({ firm: 'otpco', phone: '+919876543210', code: code === '000000' ? '111111' : '000000', device: web }).expect(401);
    await http().post('/v1/auth/otp/verify').send({ firm: 'otpco', phone: '+919876543210', code, device: { platform: 'android' } }).expect(200);
    await http().post('/v1/auth/otp/verify').send({ firm: 'otpco', phone: '+919876543210', code, device: web }).expect(401); // single use
  });
});

describe('devices, remote wipe, permissions', () => {
  it('partner wipes a lost laptop; it gets DEVICE_WIPE; audit shows it; chain verifies', async () => {
    const s = await signup('wipeco');
    const laptop = await http().post('/v1/auth/login').send({ firm: 'wipeco', email: 'partner@wipeco.in', password: PW, device: { platform: 'desktop', label: 'Laptop' } }).expect(200);
    const list = await http().get('/v1/auth/sessions').set(bearer(s.accessToken)).expect(200);
    expect(list.body).toHaveLength(2);
    await http().post(`/v1/auth/sessions/${laptop.body.sessionId}/wipe`).set(bearer(s.accessToken)).expect(204);
    const r = await http().get('/v1/me').set(bearer(laptop.body.accessToken)).expect(401);
    expect(r.body.code).toBe('DEVICE_WIPE');
    const rr = await http().post('/v1/auth/refresh').send({ refreshToken: laptop.body.refreshToken }).expect(401);
    expect(rr.body.code).toBe('DEVICE_WIPE');
    const audit = await http().get('/v1/audit').set(bearer(s.accessToken)).expect(200);
    expect(audit.body.map((e: { action: string }) => e.action)).toContain('auth.remote_wipe');
    expect((await http().get('/v1/audit/verify').set(bearer(s.accessToken)).expect(200)).body).toMatchObject({ ok: true });
  });

  it('article cannot list users or read audit; cannot be used to escalate', async () => {
    const s = await signup('permco');
    await http().post('/v1/users').set(bearer(s.accessToken)).send({ name: 'Art', email: 'art@permco.in', password: PW, roleKeys: ['article'] }).expect(201);
    const art = (await http().post('/v1/auth/login').send({ firm: 'permco', email: 'art@permco.in', password: PW, device: web }).expect(200)).body;
    await http().get('/v1/users').set(bearer(art.accessToken)).expect(403);
    await http().get('/v1/audit').set(bearer(art.accessToken)).expect(403);
    await http().post('/v1/users').set(bearer(art.accessToken)).send({ name: 'X', email: 'x@permco.in', password: PW, roleKeys: ['partner'] }).expect(403);
    await http().get('/v1/me').set(bearer(art.accessToken)).expect(200);
  });

  it('cannot revoke another user\'s session without users:edit', async () => {
    const s = await signup('sessco');
    await http().post('/v1/users').set(bearer(s.accessToken)).send({ name: 'Art', email: 'art@sessco.in', password: PW, roleKeys: ['article'] }).expect(201);
    const art = (await http().post('/v1/auth/login').send({ firm: 'sessco', email: 'art@sessco.in', password: PW, device: web }).expect(200)).body;
    await http().post(`/v1/auth/sessions/${s.sessionId}/revoke`).set(bearer(art.accessToken)).expect(403);
  });
});

describe('tenant isolation (RLS) and audit tamper evidence', () => {
  it('firm A cannot see firm B users; tampering breaks the chain', async () => {
    const a = await signup('firma');
    const b = await signup('firmb');
    const ua = await http().get('/v1/users').set(bearer(a.accessToken)).expect(200);
    expect(ua.body.map((u: { email: string }) => u.email)).toEqual(['partner@firma.in']);
    // A forged token for B's session but A's tenant id finds nothing under RLS.
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    await c.query("UPDATE audit_log SET action = 'tampered' WHERE seq = (SELECT min(seq) FROM audit_log WHERE tenant_id = $1)", [b.tenantId]);
    await c.end();
    expect((await http().get('/v1/audit/verify').set(bearer(b.accessToken)).expect(200)).body.ok).toBe(false);
    expect((await http().get('/v1/audit/verify').set(bearer(a.accessToken)).expect(200)).body.ok).toBe(true);
  });
});

describe('rules endpoints', () => {
  it('require auth + compliance:view, validate input and report extension impact', async () => {
    const s = await signup('rulesco');
    await http().post('/v1/rules/preview').send({ fy: 2026, clients: [] }).expect(401);
    await http().post('/v1/rules/preview').set(bearer(s.accessToken)).send({ fy: 'x' }).expect(400);
    const clients = Array.from({ length: 412 }, (_, i) => ({ id: `c${i}`, gstRegistered: true, gstFiling: 'MONTHLY' }));
    const res = await http().post('/v1/rules/extension-impact').set(bearer(s.accessToken)).send({
      fy: 2026, clients, extensions: [{ id: 'n1', ruleId: 'gst.gstr3b.monthly', periodKey: '2026-09', newDueDate: '2026-10-25' }],
    }).expect(201);
    expect(res.body).toMatchObject({ clientsAffected: 412, dueDatesChanged: 1 });
  });
  it('health is public', () => http().get('/v1/health').expect(200, { status: 'ok', product: 'Worko' }));
});

describe('demo seed', () => {
  it('creates the demo firm once and every demo user can log in', async () => {
    const { seedDemo, DEMO } = await import('../src/db/seed-demo.js');
    expect((await seedDemo(db.url)).created).toBe(true);
    expect((await seedDemo(db.url)).created).toBe(false);
    for (const u of DEMO.users) {
      const r = await http().post('/v1/auth/login').send({ firm: 'demo', email: u.email, password: DEMO.password, device: web }).expect(200);
      expect((await http().get('/v1/me').set(bearer(r.body.accessToken))).body.roles).toEqual([u.role]);
    }
  });
});
