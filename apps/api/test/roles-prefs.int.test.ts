import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, bootApp, PW, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let M: Session;
beforeAll(async () => { t = await bootApp(); P = await t.signup('rolefirm'); M = await t.addUser(P, 'rolefirm', 'Mona', 'manager'); }, 60_000);
afterAll(async () => { await t?.close(); });

describe('per-user UI preferences', () => {
  it('saves and returns only the caller’s preferences; rejects unknown values', async () => {
    expect((await t.http().get('/v1/me/ui-prefs').set(bearer(P.accessToken)).expect(200)).body).toEqual({});
    const prefs = { theme: 'dark', accent: 'indigo', fontScale: 'lg', density: 'compact', motion: 'reduced', glass: false, hiddenModules: ['leads'] };
    expect((await t.http().put('/v1/me/ui-prefs').set(bearer(P.accessToken)).send(prefs).expect(200)).body).toEqual(prefs);
    expect((await t.http().get('/v1/me/ui-prefs').set(bearer(P.accessToken)).expect(200)).body).toEqual(prefs);
    expect((await t.http().get('/v1/me/ui-prefs').set(bearer(M.accessToken)).expect(200)).body).toEqual({});
    await t.http().put('/v1/me/ui-prefs').set(bearer(P.accessToken)).send({ accent: 'neon' }).expect(400);
  });
});

describe('roles (firm admin)', () => {
  it('partner creates a custom role that takes effect at once; it can be edited, and deleted only when unused', async () => {
    const grants = [{ module: 'tasks', action: 'view', scope: 'own' }, { module: 'clients', action: 'view', scope: 'own' }];
    const { id } = (await t.http().post('/v1/roles').set(bearer(P.accessToken)).send({ key: 'viewer', name: 'Viewer', grants }).expect(201)).body;
    await t.http().post('/v1/roles').set(bearer(P.accessToken)).send({ key: 'viewer', name: 'Dup', grants }).expect(409);
    const V = await t.addUser(P, 'rolefirm', 'Vik', 'viewer');
    await t.http().get('/v1/tasks').set(bearer(V.accessToken)).expect(200);
    await t.http().get('/v1/users').set(bearer(V.accessToken)).expect(403);
    // grant users:view → the same session gets it immediately
    await t.http().patch(`/v1/roles/${id}`).set(bearer(P.accessToken)).send({ grants: [...grants, { module: 'users', action: 'view', scope: 'all' }] }).expect(204);
    await t.http().get('/v1/users').set(bearer(V.accessToken)).expect(200);
    await t.http().delete(`/v1/roles/${id}`).set(bearer(P.accessToken)).expect(409);
  });

  it('protects the Partner role, built-in roles and against privilege escalation', async () => {
    const roles = (await t.http().get('/v1/roles').set(bearer(P.accessToken)).expect(200)).body as Array<{ id: string; key: string }>;
    const partner = roles.find((r) => r.key === 'partner')!; const senior = roles.find((r) => r.key === 'senior')!;
    await t.http().patch(`/v1/roles/${partner.id}`).set(bearer(P.accessToken)).send({ name: 'Boss' }).expect(400);
    await t.http().delete(`/v1/roles/${senior.id}`).set(bearer(P.accessToken)).expect(400);
    // a manager cannot mint a role with powers they lack (settings is not in the manager role)
    const r = await t.http().post('/v1/roles').set(bearer(M.accessToken)).send({ key: 'sneaky', name: 'Sneaky', grants: [{ module: 'settings', action: 'edit', scope: 'all' }] });
    expect([403]).toContain(r.status);
  });
});
