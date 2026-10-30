import './env-high-throttle.js';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AppModule } from '../src/app.module.js';
import { IS_PUBLIC, PLATFORM_ROUTE } from '../src/auth/context.js';
import { PUBLIC_API } from '../src/publicapi/decorators.js';
import { PUBLIC_OPENAPI } from '../src/publicapi/openapi.public.js';
import { publicSpec } from '../src/publicapi/public-spec.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => { t = await bootApp(); }, 60_000);
afterAll(() => t?.close());

const H = (s: Session) => bearer(s.accessToken);
const K = (key: string) => ({ Authorization: `Bearer ${key}` });
async function mkKey(s: Session, body: Record<string, unknown>) {
  const r = await t.http().post('/v1/developers/api-keys').set(H(s)).send({ name: 'k', ...body });
  if (r.status !== 201) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { key: { id: string; prefix: string }; secret: string };
}
let pan = 5000;
const client = (extra: Record<string, unknown> = {}) => ({ name: `Client ${pan}`, entityType: 'INDIVIDUAL', pan: `ABCPX${pan++}Z`, ...extra });

/** Every controller route with its decorator metadata (the same discovery the guard relies on). */
function routes() {
  const ctrls = Reflect.getMetadata('controllers', AppModule) as Array<new (...a: never[]) => object>;
  const out: Array<{ method: string; path: string; isPublic: boolean; publicApi: boolean; platform: boolean }> = [];
  for (const C of ctrls) {
    const base = String(Reflect.getMetadata(PATH_METADATA, C) ?? '');
    for (const name of Object.getOwnPropertyNames(C.prototype)) {
      const h = (C.prototype as Record<string, unknown>)[name];
      if (typeof h !== 'function' || name === 'constructor' || Reflect.getMetadata(PATH_METADATA, h) === undefined) continue;
      const m = RequestMethod[Reflect.getMetadata(METHOD_METADATA, h) as number]!.toLowerCase();
      const sub = String(Reflect.getMetadata(PATH_METADATA, h));
      const path = `/v1/${[base, sub].filter((x) => x && x !== '/').join('/')}`.replace(/\/+/g, '/').replace(/:\w+/g, randomUUID());
      out.push({ method: m, path, isPublic: !!(Reflect.getMetadata(IS_PUBLIC, h) ?? Reflect.getMetadata(IS_PUBLIC, C)), publicApi: !!Reflect.getMetadata(PUBLIC_API, h),
        platform: !!(Reflect.getMetadata(PLATFORM_ROUTE, h) ?? Reflect.getMetadata(PLATFORM_ROUTE, C)) });
    }
  }
  return out;
}

describe('public API keys', () => {
  it('default deny: a key reaches only @PublicApi routes; every staff/portal/platform route refuses it', async () => {
    const p = await t.signup('pk1');
    const { secret } = await mkKey(p, { scopes: ['clients:view', 'clients:create', 'tasks:view', 'tasks:create', 'tasks:edit', 'billing:view', 'receipts:create', 'documents:view', 'documents:create', 'compliance:view', 'time:view', 'settings:edit', 'users:view'], ratePerMin: 2000 });
    const all = routes();
    expect(all.length).toBeGreaterThan(200);
    const pub = all.filter((r) => r.publicApi);
    expect(pub.map((r) => r.method).sort()).toEqual(['get', 'get', 'get', 'get', 'get', 'get', 'get', 'get', 'get', 'patch', 'post', 'post', 'post', 'post']);
    let denied = 0;
    for (const r of all.filter((x) => !x.isPublic && !x.publicApi)) {
      const res = await (t.http() as unknown as Record<string, (p: string) => import('supertest').Test>)[r.method]!(r.path).set(K(secret)).send({});
      // Platform (super-admin) routes accept platform tokens only: a key is not one → 401 there; everywhere else 403.
      if (r.platform) expect([r.method, r.path, res.status]).toEqual([r.method, r.path, 401]);
      else expect([r.method, r.path, res.status, res.body.code]).toEqual([r.method, r.path, 403, 'API_KEY_ROUTE_DENIED']);
      denied++;
    }
    expect(denied).toBeGreaterThan(200);
    // Public routes work with the same key.
    await t.http().get('/v1/clients').set(K(secret)).expect(200);
  }, 120_000);

  it('scopes ∩ creator rights, re-evaluated per request; creator deactivation disables the key', async () => {
    const p = await t.signup('pk2');
    const admin = await t.addUser(p, 'pk2', 'Adminuser', 'admin');
    const bad = await t.http().post('/v1/developers/api-keys').set(H(admin)).send({ name: 'x', scopes: ['clients:view', 'tasks:view'] }).expect(400);
    expect(bad.body).toMatchObject({ code: 'scope_not_held', scopes: ['tasks:view'] });
    const { secret, key } = await mkKey(admin, { scopes: ['clients:view'] });
    await t.http().get('/v1/clients').set(K(secret)).expect(200);
    expect((await t.http().post('/v1/clients').set(K(secret)).send(client()).expect(403)).body.code).toBe('SCOPE_MISSING');
    expect((await t.http().get('/v1/tasks').set(K(secret)).expect(403)).body.code).toBe('SCOPE_MISSING');
    // Secret never stored; list shows prefix only.
    const raw = await t.sql<{ secret_hash: Buffer }>('SELECT secret_hash FROM api_key WHERE id = $1', [key.id]);
    expect(raw[0]!.secret_hash.toString('latin1')).not.toContain(secret.split('_')[2]);
    const list = (await t.http().get('/v1/developers/api-keys').set(H(p)).expect(200)).body.items;
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(list[0]).toMatchObject({ prefix: key.prefix, status: 'active' });
    // Creator loses the right → key loses it on the next request.
    await t.sql(`UPDATE role SET grants = '[]'::jsonb WHERE tenant_id = (SELECT tenant_id FROM app_user WHERE id = $1) AND key = 'admin'`, [admin.userId]);
    expect((await t.http().get('/v1/clients').set(K(secret)).expect(403)).body.code).toBe('SCOPE_MISSING');
    await t.sql(`UPDATE app_user SET status = 'inactive' WHERE id = $1`, [admin.userId]);
    expect((await t.http().get('/v1/clients').set(K(secret)).expect(401)).body.code).toBe('KEY_DISABLED');
    expect((await t.http().get('/v1/developers/api-keys').set(H(p))).body.items[0].status).toBe('creator_inactive');
  });

  it('client-group restriction narrows list scope', async () => {
    const p = await t.signup('pk3');
    const g = (await t.http().post('/v1/client-groups').set(H(p)).send({ name: 'Mehta family' }).expect(201)).body.id;
    const inG = (await t.http().post('/v1/clients').set(H(p)).send(client({ groupIds: [g] })).expect(201)).body.id;
    const out = (await t.http().post('/v1/clients').set(H(p)).send(client()).expect(201)).body.id;
    const { secret } = await mkKey(p, { scopes: ['clients:view'], clientGroupIds: [g] });
    const items = (await t.http().get('/v1/clients').set(K(secret)).expect(200)).body.items.map((c: { id: string }) => c.id);
    expect(items).toEqual([inG]);
    await t.http().get(`/v1/clients/${out}`).set(K(secret)).expect(404);
  });

  it('IP allow-list, expiry, rotation, revocation, rate limit', async () => {
    const p = await t.signup('pk4');
    const blocked = await mkKey(p, { scopes: ['clients:view'], ipAllowlist: ['203.0.113.0/24'] });
    expect((await t.http().get('/v1/clients').set(K(blocked.secret)).expect(403)).body.code).toBe('IP_NOT_ALLOWED');
    const local = await mkKey(p, { scopes: ['clients:view'], ipAllowlist: ['127.0.0.0/8', '::1/128'] });
    await t.http().get('/v1/clients').set(K(local.secret)).expect(200);
    await t.http().post('/v1/developers/api-keys').set(H(p)).send({ name: 'old', scopes: ['clients:view'], expiresAt: '2020-01-01T00:00:00Z' }).expect(400);
    const e = await mkKey(p, { scopes: ['clients:view'] });
    await t.sql(`UPDATE api_key SET expires_at = now() - interval '1 second' WHERE id = $1`, [e.key.id]);
    expect((await t.http().get('/v1/clients').set(K(e.secret)).expect(401)).body.code).toBe('KEY_EXPIRED');

    const r = await mkKey(p, { scopes: ['clients:view'] });
    const rot = (await t.http().post(`/v1/developers/api-keys/${r.key.id}/rotate`).set(H(p)).expect(200)).body;
    expect(rot.secret).not.toBe(r.secret);
    expect((await t.http().get('/v1/clients').set(K(r.secret)).expect(401)).body.code).toBe('INVALID_API_KEY');
    await t.http().get('/v1/clients').set(K(rot.secret)).expect(200);
    await t.http().delete(`/v1/developers/api-keys/${r.key.id}`).set(H(p)).expect(204);
    expect((await t.http().get('/v1/clients').set(K(rot.secret)).expect(401)).body.code).toBe('KEY_REVOKED');
    await t.http().get('/v1/clients').set(K('wk_nope')).expect(401);

    const rl = await mkKey(p, { scopes: ['clients:view'], ratePerMin: 3 });
    for (let i = 0; i < 3; i++) await t.http().get('/v1/clients').set(K(rl.secret)).expect(200);
    const over = await t.http().get('/v1/clients').set(K(rl.secret)).expect(429);
    expect(over.body.code).toBe('RATE_LIMITED');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('cursor pagination, idempotency keys, writes through services, per-call audit', async () => {
    const p = await t.signup('pk5');
    const { secret, key } = await mkKey(p, { scopes: ['clients:view', 'clients:create', 'tasks:view', 'tasks:create', 'tasks:edit', 'billing:view', 'documents:view', 'documents:create', 'compliance:view', 'time:view'] });
    const body = client();
    const a = await t.http().post('/v1/clients').set(K(secret)).set('Idempotency-Key', 'c-1').send(body).expect(201);
    const b = await t.http().post('/v1/clients').set(K(secret)).set('Idempotency-Key', 'c-1').send(body).expect(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect((await t.http().post('/v1/clients').set(K(secret)).set('Idempotency-Key', 'c-1').send(client()).expect(422)).body.code).toBe('IDEMPOTENCY_MISMATCH');
    // A failed request releases its key.
    await t.http().post('/v1/clients').set(K(secret)).set('Idempotency-Key', 'c-2').send({ name: '' }).expect(400);
    await t.http().post('/v1/clients').set(K(secret)).set('Idempotency-Key', 'c-2').send(client()).expect(201);
    await t.http().post('/v1/clients').set(K(secret)).send(client()).expect(201);
    expect((await t.sql('SELECT id FROM client WHERE tenant_id = $1', [p.tenantId])).length).toBe(3);

    const p1 = (await t.http().get('/v1/clients?limit=2').set(K(secret)).expect(200)).body;
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await t.http().get(`/v1/clients?limit=2&cursor=${p1.nextCursor}`).set(K(secret)).expect(200)).body;
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((c: { id: string }) => c.id)).size).toBe(3);
    expect((await t.http().get('/v1/clients?offset=2').set(K(secret)).expect(400)).body.code).toBe('USE_CURSOR');
    expect((await t.http().get('/v1/clients?cursor=zz').set(K(secret)).expect(400)).body.code).toBe('INVALID_CURSOR');
    // Staff sessions keep offset pagination untouched.
    expect((await t.http().get('/v1/clients?offset=2').set(H(p)).expect(200)).body.nextCursor).toBeUndefined();

    const task = (await t.http().post('/v1/tasks').set(K(secret)).send({ title: 'GSTR-1 via API', client_id: a.body.id }).expect(201)).body;
    await t.http().patch(`/v1/tasks/${task.id}`).set(K(secret)).set('Idempotency-Key', 't-1').send({ status: 'in_progress' }).expect(204);
    await t.http().patch(`/v1/tasks/${task.id}`).set(K(secret)).set('Idempotency-Key', 't-1').send({ status: 'in_progress' }).expect(204);
    expect((await t.http().get(`/v1/tasks/${task.id}`).set(K(secret)).expect(200)).body.status).toBe('in_progress');
    await t.http().get('/v1/tasks').set(K(secret)).expect(200);
    await t.http().get('/v1/billing/invoices').set(K(secret)).expect(200);
    await t.http().get('/v1/time/entries').set(K(secret)).expect(200);
    await t.http().get('/v1/compliance/matrix?from=2026-04-01&to=2026-04-30').set(K(secret)).expect(200);
    const doc = await t.http().post('/v1/documents').set(K(secret)).field('clientId', a.body.id).attach('file', Buffer.from('%PDF-1.4 hello'), 'note.pdf').expect(201);
    expect((await t.http().get(`/v1/documents?clientId=${a.body.id}`).set(K(secret)).expect(200)).body.items.map((d: { id: string }) => d.id)).toContain(doc.body.id);

    // Service-level audit carries the key as device; every call has an api.call entry.
    const audit = await t.sql<{ action: string; device_id: string; diff: { route: string; status: number } }>(`SELECT action, device_id, diff FROM audit_log WHERE entity_id = $1 OR device_id = $2 ORDER BY seq`, [key.id, `apikey:${key.id}`]);
    for (let i = 0; i < 50 && !audit.some((x) => x.diff?.route?.includes('documents')); i++) {
      await new Promise((r) => setTimeout(r, 50));
      audit.splice(0, audit.length, ...(await t.sql<{ action: string; device_id: string; diff: { route: string; status: number } }>(`SELECT action, device_id, diff FROM audit_log WHERE entity_id = $1 OR device_id = $2 ORDER BY seq`, [key.id, `apikey:${key.id}`])));
    }
    expect(audit.filter((x) => x.action === 'api.call').length).toBeGreaterThanOrEqual(10);
    expect(audit.some((x) => x.action === 'client.created' && x.device_id === `apikey:${key.id}`)).toBe(true);
    expect(audit.find((x) => x.action === 'api.call' && x.diff.status === 422)).toBeTruthy();
  });

  it('serves the public OpenAPI document, in sync with docs/openapi.yaml', async () => {
    const spec = (await t.http().get('/v1/public-api/openapi.json').expect(200)).body;
    expect(Object.keys(spec.paths).sort()).toEqual(['/billing/invoices', '/billing/invoices/{id}', '/billing/receipts', '/clients', '/clients/{id}', '/compliance/matrix', '/documents', '/tasks', '/tasks/{id}', '/time/entries']);
    expect(spec.paths['/clients'].patch).toBeUndefined();
    expect(spec.components.securitySchemes.apiKey).toBeTruthy();
    const full = parse(readFileSync(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8'));
    expect(JSON.parse(JSON.stringify(PUBLIC_OPENAPI))).toEqual(JSON.parse(JSON.stringify(publicSpec(full)))); // run `pnpm --filter @worko/api gen:public-openapi` if stale
  });
});
