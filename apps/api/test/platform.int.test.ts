import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC, PLATFORM_ROUTE, PORTAL_ALLOWED } from '../src/auth/context.js';
import { totp } from '../src/auth/crypto.js';
import { DbService } from '../src/db/db.service.js';
import { createPlatformAdmin } from '../src/platform/platform-auth.service.js';
import { bearer, bootApp, PW, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let M: Session; let other: Session;
let admin: string; let tenantId: string;
const SECRET = Buffer.from('platform-test-secret-0123', 'utf8');
const EMAIL = 'ops@worko.example';
const H = (s: { accessToken: string }) => bearer(s.accessToken);
let step = 0;
/** Each login needs a fresh, increasing time step (replays are refused): -30 s, now, +30 s (±1 step drift is accepted). */
const code = () => totp(SECRET, Date.now() + 30_000 * (step++ - 1));

async function platformLogin() {
  const r = await t.http().post('/v1/platform/auth/login').send({ email: EMAIL, password: PW, totp: code() }).expect(200);
  return r.body.accessToken as string;
}

beforeAll(async () => {
  t = await bootApp();
  await t.app.get(DbService).systemTx((tx) => createPlatformAdmin(tx, { email: EMAIL, name: 'Ops One', password: PW, secret: SECRET }));
  P = await t.signup('plat');
  tenantId = P.tenantId;
  M = await t.addUser(P, 'plat', 'Mona', 'manager');
  other = await t.signup('otherfirm');
}, 60_000);
afterAll(() => t?.close());

describe('platform authentication', () => {
  it('MFA is mandatory: password alone → MFA_REQUIRED, wrong code → 401, then password + code works', async () => {
    const r = await t.http().post('/v1/platform/auth/login').send({ email: EMAIL, password: PW }).expect(401);
    expect(r.body.code).toBe('MFA_REQUIRED');
    const right = totp(SECRET);
    await t.http().post('/v1/platform/auth/login').send({ email: EMAIL, password: PW, totp: right === '000000' ? '111111' : '000000' }).expect(401);
    await t.http().post('/v1/platform/auth/login').send({ email: EMAIL, password: 'wrong password!', totp: '123456' }).expect(401);
    admin = await platformLogin();
    expect((await t.http().get('/v1/platform/me').set(bearer(admin)).expect(200)).body.email).toBe(EMAIL);
    // replaying the step just used is refused
    await t.http().post('/v1/platform/auth/login').send({ email: EMAIL, password: PW, totp: totp(SECRET, Date.now() - 30_000) }).expect(401);
  });

  it('tenant tokens cannot reach ANY platform route and platform tokens cannot reach ANY tenant route', async () => {
    const reflector = t.app.get(Reflector);
    const routes: Array<{ method: string; path: string; platform: boolean; portal: boolean }> = [];
    for (const m of t.app.get(ModulesContainer).values()) {
      for (const c of m.controllers.values()) {
        const cls = c.metatype as unknown as { prototype: Record<string, unknown> };
        const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
        for (const name of Object.getOwnPropertyNames(cls.prototype)) {
          const h = cls.prototype[name] as object;
          if (name === 'constructor' || typeof h !== 'function') continue;
          const sub = Reflect.getMetadata(PATH_METADATA, h);
          if (sub === undefined) continue;
          if (reflector.getAllAndOverride<boolean>(IS_PUBLIC, [h as never, cls as never])) continue;
          const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, h) as number]!;
          const path = `/v1/${[base, String(sub)].filter((x) => x && x !== '/').join('/')}`.replace(/\/+/g, '/')
            .replace(/:kind/g, 'pbc').replace(/:provider/g, 'mock').replace(/:key/g, 'starter').replace(/:(\w+)/g, '00000000-0000-4000-8000-000000000000');
          routes.push({ method, path, platform: !!reflector.getAllAndOverride<boolean>(PLATFORM_ROUTE, [h as never, cls as never]),
            portal: !!reflector.getAllAndOverride<boolean>(PORTAL_ALLOWED, [h as never, cls as never]) });
        }
      }
    }
    const platform = routes.filter((r) => r.platform); const tenant = routes.filter((r) => !r.platform);
    expect(platform.length).toBeGreaterThanOrEqual(20);
    expect(platform.every((r) => r.path.startsWith('/v1/platform/'))).toBe(true);
    const call = (r: { method: string; path: string }, tok: string) => (t.http() as unknown as Record<string, (p: string) => { set: (h: Record<string, string>) => Promise<{ status: number }> }>)[r.method.toLowerCase()]!(r.path).set(bearer(tok));
    const failures: string[] = [];
    for (const r of platform) { const res = await call(r, P.accessToken); if (res.status !== 401) failures.push(`tenant on ${r.method} ${r.path} → ${res.status}`); }
    for (const r of tenant) { const res = await call(r, admin); if (res.status !== 401) failures.push(`platform on ${r.method} ${r.path} → ${res.status}`); }
    expect(failures).toEqual([]);
  }, 180_000);
});

describe('tenants, flags, plans, suspension', () => {
  it('lists/searches tenants and shows usage', async () => {
    const list = (await t.http().get('/v1/platform/tenants?q=plat').set(bearer(admin)).expect(200)).body;
    expect(list.map((x: { slug: string }) => x.slug)).toEqual(['plat']);
    const d = (await t.http().get(`/v1/platform/tenants/${tenantId}`).set(bearer(admin)).expect(200)).body;
    expect(d.tenant).toMatchObject({ slug: 'plat', plan: 'trial', subStatus: 'trial', status: 'active' });
    expect(d.usage).toMatchObject({ seatsUsed: 2, seatLimit: 25, messages: 0, aiCalls: 0 });
    expect(Object.values(d.features).every(Boolean)).toBe(true);
  });

  it('feature flags switch modules off for the firm (403 feature_disabled) and back on', async () => {
    await t.http().get('/v1/automation/rules').set(H(P)).expect(200);
    const f = (await t.http().put(`/v1/platform/tenants/${tenantId}/flags`).set(bearer(admin)).send({ overrides: { automation: false } }).expect(200)).body;
    expect(f.automation).toBe(false);
    const r = await t.http().get('/v1/automation/rules').set(H(P)).expect(403);
    expect(r.body.code).toBe('feature_disabled');
    await t.http().get('/v1/automation/rules').set(H(other)).expect(200); // other firm unaffected
    await t.http().put(`/v1/platform/tenants/${tenantId}/flags`).set(bearer(admin)).send({ overrides: { automation: null } }).expect(200);
    await t.http().get('/v1/automation/rules').set(H(P)).expect(200);
  });

  it('plan assignment changes module defaults; plans and prices are data', async () => {
    const plans = (await t.http().get('/v1/platform/plans').set(bearer(admin)).expect(200)).body;
    expect(plans.find((p: { key: string }) => p.key === 'starter').prices.every((x: { unverified: boolean }) => x.unverified)).toBe(true);
    await t.http().put(`/v1/platform/tenants/${tenantId}/plan`).set(bearer(admin)).send({ planKey: 'starter' }).expect(200);
    expect((await t.http().get('/v1/ai/settings').set(H(P))).status).toBe(403); // starter has no AI
    await t.http().post('/v1/platform/plans/starter/prices').set(bearer(admin)).send({ cycle: 'monthly', pricePaise: 129900, effectiveFrom: '2027-04-01' }).expect(201);
    await t.http().put(`/v1/platform/tenants/${tenantId}/plan`).set(bearer(admin)).send({ planKey: 'trial' }).expect(200);
  });

  it('suspension blocks logins, sessions and jobs but keeps data; reactivation restores access', async () => {
    await t.http().post(`/v1/platform/tenants/${tenantId}/suspend`).set(bearer(admin)).send({ reason: 'Abuse report under review' }).expect(200);
    expect((await t.http().get('/v1/me').set(H(P)).expect(403)).body.code).toBe('TENANT_SUSPENDED');
    expect((await t.http().post('/v1/auth/login').send({ firm: 'plat', email: 'partner@plat.in', password: PW, device: { platform: 'web' } }).expect(403)).body.code).toBe('TENANT_SUSPENDED');
    await t.http().get('/v1/me').set(H(other)).expect(200);
    await t.sql(`INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) VALUES ($1, 'test.never', $1, now() - interval '1 minute')`, [tenantId]);
    const { JobQueueService } = await import('../src/jobs/job-queue.service.js');
    await t.app.get(JobQueueService).runOnce();
    expect((await t.sql<{ attempts: number }>(`SELECT attempts FROM job_queue WHERE kind = 'test.never'`))[0]!.attempts).toBe(0); // not claimed
    expect((await t.sql<{ n: number }>('SELECT count(*)::int AS n FROM app_user WHERE tenant_id = $1', [tenantId]))[0]!.n).toBe(2); // data kept
    await t.http().post(`/v1/platform/tenants/${tenantId}/reactivate`).set(bearer(admin)).expect(200);
    await t.http().get('/v1/me').set(H(P)).expect(200);
    await t.sql(`DELETE FROM job_queue WHERE kind = 'test.never'`);
  });

  it('every platform action is in the hash-chained platform audit log, also in the tenant log for tenant changes', async () => {
    const log = (await t.http().get(`/v1/platform/audit?tenantId=${tenantId}`).set(bearer(admin)).expect(200)).body as Array<{ action: string; diff: unknown }>;
    for (const a of ['platform.tenant_suspended', 'platform.tenant_reactivated', 'platform.flags_set', 'platform.plan_assigned', 'platform.tenant_viewed']) expect(log.map((x) => x.action)).toContain(a);
    expect((await t.http().get('/v1/platform/audit/verify').set(bearer(admin)).expect(200)).body.ok).toBe(true);
    const tenantAudit = await t.sql<{ action: string; diff: { platformAdminId?: string } }>(`SELECT action, diff FROM audit_log WHERE tenant_id = $1 AND action LIKE 'tenant.%'`, [tenantId]);
    expect(tenantAudit.map((x) => x.action)).toEqual(expect.arrayContaining(['tenant.suspended', 'tenant.reactivated', 'tenant.features_changed', 'tenant.plan_changed']));
    expect(tenantAudit.every((x) => x.action === 'tenant.created' || !!x.diff.platformAdminId)).toBe(true);
    // tamper detection
    const [first] = await t.sql<{ seq: string; action: string }>('SELECT seq, action FROM platform_audit_log ORDER BY seq LIMIT 1');
    await t.sql(`UPDATE platform_audit_log SET action = 'x' WHERE seq = $1`, [first!.seq]);
    expect((await t.http().get('/v1/platform/audit/verify').set(bearer(admin)).expect(200)).body.ok).toBe(false);
    await t.sql(`UPDATE platform_audit_log SET action = $2 WHERE seq = $1`, [first!.seq, first!.action]);
  });

  it('platform logout kills the session', async () => {
    const tok = await platformLogin();
    await t.http().post('/v1/platform/auth/logout').set(bearer(tok)).expect(204);
    await t.http().get('/v1/platform/me').set(bearer(tok)).expect(401);
  });
});

describe('impersonation with consent', () => {
  let grant: string; let imp: string;
  it('requires a partner approval; a manager cannot approve; unapproved grants cannot start', async () => {
    grant = (await t.http().post(`/v1/platform/tenants/${tenantId}/impersonations`).set(bearer(admin)).send({ reason: 'Ticket #4411: invoice PDF looks wrong', minutes: 30 }).expect(201)).body.id;
    await t.http().post(`/v1/platform/tenants/${tenantId}/impersonations/${grant}/start`).set(bearer(admin)).expect(403);
    const notes = await t.sql(`SELECT 1 FROM notification WHERE tenant_id = $1 AND entity_id = $2`, [tenantId, grant]);
    expect(notes.length).toBeGreaterThan(0);
    await t.http().post(`/v1/impersonation/grants/${grant}/approve`).set(H(M)).send({}).expect(403);
    await t.http().post(`/v1/impersonation/grants/${grant}/approve`).set(H(P)).send({ writeConsent: true }).expect(400); // write was not requested
    const g = (await t.http().post(`/v1/impersonation/grants/${grant}/approve`).set(H(P)).send({ minutes: 20 }).expect(200)).body;
    expect(g).toMatchObject({ status: 'approved', writeConsent: false, asUserId: P.userId });
  });

  it('distinct token, read-only, banner flag, double-audited', async () => {
    const s = (await t.http().post(`/v1/platform/tenants/${tenantId}/impersonations/${grant}/start`).set(bearer(admin)).expect(200)).body;
    imp = s.accessToken;
    const me = await t.http().get('/v1/me').set(bearer(imp)).expect(200);
    expect(me.body.impersonation).toMatchObject({ grantId: grant, write: false });
    expect(me.headers['x-worko-impersonation']).toBe(grant);
    await t.http().get('/v1/clients').set(bearer(imp)).expect(200);
    expect((await t.http().post('/v1/clients').set(bearer(imp)).send({ name: 'X', entityType: 'INDIVIDUAL' }).expect(403)).body.code).toBe('IMPERSONATION_READ_ONLY');
    await t.http().get('/v1/auth/sessions').set(bearer(imp)).expect(403);
    await t.http().get('/v1/platform/me').set(bearer(imp)).expect(401); // not a platform token
    await t.http().get('/v1/me').set(H(other)).expect(200);
    const ta = await t.sql<{ action: string; diff: { platformAdminId: string; path: string } }>(`SELECT action, diff FROM audit_log WHERE tenant_id = $1 AND action LIKE 'impersonation.%' ORDER BY seq`, [tenantId]);
    expect(ta.map((x) => x.action)).toEqual(expect.arrayContaining(['impersonation.requested', 'impersonation.approved', 'impersonation.started', 'impersonation.action', 'impersonation.blocked']));
    expect(ta.filter((x) => x.action === 'impersonation.action').every((x) => !!x.diff.platformAdminId)).toBe(true);
    const pa = (await t.http().get(`/v1/platform/audit?tenantId=${tenantId}`).set(bearer(admin)).expect(200)).body.map((x: { action: string }) => x.action);
    expect(pa).toEqual(expect.arrayContaining(['platform.impersonation_requested', 'platform.impersonation_approved', 'platform.impersonation_started', 'platform.impersonation_action', 'platform.impersonation_blocked']));
  });

  it('the firm can revoke at any time; consent records are retained', async () => {
    await t.http().post(`/v1/impersonation/grants/${grant}/revoke`).set(H(P)).expect(200);
    await t.http().get('/v1/me').set(bearer(imp)).expect(401);
    const list = (await t.http().get('/v1/impersonation/grants').set(H(P)).expect(200)).body;
    expect(list[0]).toMatchObject({ id: grant, status: 'revoked' });
  });

  it('write needs explicit consent; grants auto-expire', async () => {
    const g2 = (await t.http().post(`/v1/platform/tenants/${tenantId}/impersonations`).set(bearer(admin)).send({ reason: 'Ticket #4412: fix a client record', write: true, minutes: 10 }).expect(201)).body.id;
    await t.http().post(`/v1/impersonation/grants/${g2}/approve`).set(H(P)).send({ writeConsent: true }).expect(200);
    const tok = (await t.http().post(`/v1/platform/tenants/${tenantId}/impersonations/${g2}/start`).set(bearer(admin)).expect(200)).body.accessToken;
    await t.http().post('/v1/clients').set(bearer(tok)).send({ name: 'Created by support', entityType: 'INDIVIDUAL' }).expect(201);
    await t.http().post('/v1/users').set(bearer(tok)).send({ name: 'Sneaky', email: 'sneaky@plat.in', password: PW, roleKeys: ['article'] }).expect(403);
    // The blocklist can't be sidestepped with case, trailing or duplicate slashes (the router accepts all of these).
    for (const p of ['/v1/Users', '/V1/USERS/', '/v1//users', '/v1/users/']) {
      const r = await t.http().post(p).set(bearer(tok)).send({ name: 'Sneaky', email: 'sneaky2@plat.in', password: PW, roleKeys: ['article'] });
      expect([403, 404]).toContain(r.status); // blocked, or not routed at all — never reaches the controller
    }
    expect(await t.sql(`SELECT 1 FROM app_user WHERE email = 'sneaky2@plat.in'`)).toHaveLength(0);
    await t.sql(`UPDATE impersonation_grant SET expires_at = now() - interval '1 second' WHERE id = $1`, [g2]);
    expect((await t.http().get('/v1/me').set(bearer(tok)).expect(401)).body.code).toBe('IMPERSONATION_EXPIRED');
    expect((await t.sql<{ status: string }>('SELECT status FROM impersonation_grant WHERE id = $1', [g2]))[0]!.status).toBe('expired');
    // Ending the platform session ends impersonation, even while a grant is still valid.
    const g3 = (await t.http().post(`/v1/platform/tenants/${tenantId}/impersonations`).set(bearer(admin)).send({ reason: 'Ticket #4413: check settings', minutes: 60 }).expect(201)).body.id;
    await t.http().post(`/v1/impersonation/grants/${g3}/approve`).set(H(P)).send({}).expect(200);
    const tok3 = (await t.http().post(`/v1/platform/tenants/${tenantId}/impersonations/${g3}/start`).set(bearer(admin)).expect(200)).body.accessToken;
    await t.http().get('/v1/me').set(bearer(tok3)).expect(200);
    await t.sql(`UPDATE platform_session SET expires_at = now() - interval '1 second' WHERE admin_id = (SELECT id FROM platform_admin WHERE email = $1) AND revoked_at IS NULL`, [EMAIL]);
    await t.http().get('/v1/me').set(bearer(tok3)).expect(401);
  });

  it('a firm cannot see or decide another firm\'s grants', async () => {
    await t.http().post(`/v1/impersonation/grants/${grant}/revoke`).set(H(other)).expect(404);
    expect((await t.http().get('/v1/impersonation/grants').set(H(other)).expect(200)).body).toEqual([]);
  });
});
