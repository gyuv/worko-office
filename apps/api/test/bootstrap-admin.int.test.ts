import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../src/auth/crypto.js';
import { DbService } from '../src/db/db.service.js';
import { PLATFORM_DEMO } from '../src/db/seed-platform.js';
import { bootstrapPlatformAdmin } from '../src/platform/bootstrap-admin.js';
import { createPlatformAdmin } from '../src/platform/platform-auth.service.js';
import { bootApp } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
const demoSecret = Buffer.from(PLATFORM_DEMO.totpSecretHex, 'hex');
beforeAll(async () => {
  t = await bootApp();
  await t.app.get(DbService).systemTx((tx) => createPlatformAdmin(tx, { email: PLATFORM_DEMO.email, name: 'demo', password: PLATFORM_DEMO.password, secret: demoSecret }));
});
afterAll(async () => { await t?.close(); });

describe('platform admin bootstrap (production)', () => {
  it('disables the public demo admin, creates the configured admin once, and prints its setup key only once', async () => {
    const login = () => t.http().post('/v1/platform/auth/login').send({ email: PLATFORM_DEMO.email, password: PLATFORM_DEMO.password, totp: totp(demoSecret) });
    expect((await login()).status).toBe(200);
    const env = { NODE_ENV: 'production', PLATFORM_ADMIN_EMAIL: 'Me@MyFirm.in', PLATFORM_ADMIN_PASSWORD: 'a-long-secret-pass', PLATFORM_ADMIN_NAME: 'Me' };
    const first: string[] = [];
    await bootstrapPlatformAdmin(t.app.get(DbService), env, (s) => first.push(s));
    expect((await login()).status).toBe(401);
    expect(first.join('\n')).toMatch(/Disabled the demo platform admin/);
    const key = first.find((l) => l.includes('setup key:'))!.split('setup key: ')[1]!.trim();
    expect(key.length).toBeGreaterThan(10);

    const second: string[] = [];
    await bootstrapPlatformAdmin(t.app.get(DbService), env, (s) => second.push(s));
    expect(second).toEqual([]);

    const rows = await t.sql<{ email: string; status: string }>(`SELECT email, status FROM platform_admin ORDER BY email`);
    expect(rows).toEqual([{ email: 'me@myfirm.in', status: 'active' }, { email: PLATFORM_DEMO.email, status: 'disabled' }]);

    const short: string[] = [];
    await bootstrapPlatformAdmin(t.app.get(DbService), { PLATFORM_ADMIN_EMAIL: 'x@y.in', PLATFORM_ADMIN_PASSWORD: 'short' }, (s) => short.push(s));
    expect(short.join()).toMatch(/at least 12/);
  });
});
