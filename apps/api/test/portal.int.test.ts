import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { gstinCheckChar } from '@worko/domain';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC, PORTAL_ALLOWED } from '../src/auth/context.js';
import { MockChannelHub } from '../src/comm/channels.js';
import { Clock } from '../src/common/clock.js';
import { RealtimeService, type RealtimeEvent } from '../src/realtime/realtime.service.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let S: Session; let hub: MockChannelHub;
let A: string; let B: string; let C: string; let D: string; let E: string;
let ravi: { A: string; B: string }; let gitaContact: string;
const NOW = new Date('2026-10-29T10:00:00+05:30');
const H = (s: { accessToken: string }) => bearer(s.accessToken);
const FIRM = 'portalco';
const events: RealtimeEvent[] = [];
const pdf = Buffer.from('%PDF-1.4\n% portal test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

function gstin(state: string, n: number) { const base = `${state}AABCP${String(n).padStart(4, '0')}Z1Z`; return base + gstinCheckChar(base); }
const client = async (name: string, contacts: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  (await t.http().post('/v1/clients').set(H(P)).send({ name, entityType: 'PRIVATE_COMPANY', staffIds: [S.userId], contacts, ...extra }).expect(201)).body.id as string;
const contactOf = async (clientId: string, email: string) => (await t.sql<{ id: string }>('SELECT id FROM contact WHERE client_id = $1 AND email = $2', [clientId, email]))[0]!.id;
const lastCode = (to: string) => { const m = [...hub.outbox].reverse().find((x) => x.to === to); return m?.text.match(/\b(\d{6})\b/)?.[1] ?? null; };
async function portalLogin(identifier: string, to = identifier) {
  await t.http().post('/v1/portal/auth/otp/request').send({ firm: FIRM, identifier }).expect(202);
  const code = lastCode(to)!;
  return (await t.http().post('/v1/portal/auth/otp/verify').send({ firm: FIRM, identifier, code, device: { platform: 'web' } }).expect(200)).body as { accessToken: string; refreshToken: string; portalUserId: string; sessionId: string };
}
const upload = (s: Session, clientId: string, name: string, fields: Record<string, string> = {}) => {
  let r = t.http().post('/v1/documents').set(H(s)).field('clientId', clientId);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', pdf, { filename: name, contentType: 'application/pdf' }).expect(201).then((x) => x.body.id as string);
};

beforeAll(async () => {
  t = await bootApp();
  t.app.get(Clock).set(NOW);
  hub = t.app.get(MockChannelHub);
  t.app.get(RealtimeService).subscribe((e) => events.push(e));
  P = await t.signup(FIRM);
  S = await t.addUser(P, FIRM, 'Sona', 'senior');
  const [e1] = (await t.http().get('/v1/billing/entities').set(H(P)).expect(200)).body;
  await t.http().patch(`/v1/billing/entities/${e1.id}`).set(H(P)).send({ gstin: gstin('27', 1), invoicePrefix: 'PC' }).expect(204);
  await t.http().put('/v1/billing/settings').set(H(P)).send({ defaultEntityId: e1.id }).expect(204);
  A = await client('Alpha Pvt Ltd', [{ name: 'Ravi Kumar', email: 'ravi@alpha.example', phone: '+919820011111', isPrimary: true }]);
  B = await client('Beta Pvt Ltd', [{ name: 'Ravi Kumar', email: 'ravi@alpha.example', isPrimary: true }]);
  C = await client('Gamma LLP', [{ name: 'Gita Rao', email: 'gita@gamma.example', isPrimary: true }]);
  D = await client('Delta Traders', [{ name: 'Dev', email: 'dev@delta.example', isPrimary: true }]);
  E = await client('Epsilon Ltd', [{ name: 'Lok', email: 'lok@eps.example', phone: '+919820099999', isPrimary: true }]);
  ravi = { A: await contactOf(A, 'ravi@alpha.example'), B: await contactOf(B, 'ravi@alpha.example') };
  gitaContact = await contactOf(C, 'gita@gamma.example');
  const inv1 = (await t.http().post('/v1/portal-admin/invites').set(H(P)).send({ clientId: A, contactId: ravi.A }).expect(201)).body;
  expect(inv1.invite.status).toBe('sent');
  const inv2 = (await t.http().post('/v1/portal-admin/invites').set(H(P)).send({ clientId: B, contactId: ravi.B, send: false }).expect(201)).body;
  expect(inv2.portalUserId).toBe(inv1.portalUserId); // one login across group companies
  await t.http().post('/v1/portal-admin/invites').set(H(P)).send({ clientId: C, contactId: gitaContact, send: false,
    grants: { documents: { categories: ['ITR'], fys: ['2025-26'] }, invoices: false, payments: false } }).expect(201);
  await t.http().post('/v1/portal-admin/invites').set(H(P)).send({ clientId: E, contactId: await contactOf(E, 'lok@eps.example'), send: false }).expect(201);
}, 90_000);
afterAll(() => t?.close());

describe('portal sign-in (OTP)', () => {
  it('invitation goes through the comm pipeline (timeline) and enables the client portal', async () => {
    const m = hub.outbox.find((x) => x.to === 'ravi@alpha.example' && /client portal/.test(x.text))!;
    expect(m.text).toContain(`/${FIRM}`);
    expect((await t.sql<{ portal_enabled: boolean }>('SELECT portal_enabled FROM client WHERE id = $1', [A]))[0]!.portal_enabled).toBe(true);
    expect((await t.sql(`SELECT 1 FROM comm_message WHERE client_id = $1 AND meta ? 'portalInvite'`, [A])).length).toBe(1);
  });

  it('is enumeration-safe: same 202 for unknown firm/person/uninvited contact; codes only to invited people', async () => {
    const before = hub.outbox.length;
    for (const b of [{ firm: 'nope-firm', identifier: 'ravi@alpha.example' }, { firm: FIRM, identifier: 'stranger@x.example' }, { firm: FIRM, identifier: 'dev@delta.example' }, { firm: FIRM, identifier: 'not-an-id' }]) {
      expect((await t.http().post('/v1/portal/auth/otp/request').send(b).expect(202)).body).toEqual({ sent: true });
    }
    expect(hub.outbox.length).toBe(before);
    const bad = await t.http().post('/v1/portal/auth/otp/verify').send({ firm: FIRM, identifier: 'stranger@x.example', code: '123456', device: { platform: 'web' } }).expect(401);
    const bad2 = await t.http().post('/v1/portal/auth/otp/verify').send({ firm: FIRM, identifier: 'ravi@alpha.example', code: '000000', device: { platform: 'web' } }).expect(401);
    expect(bad.body.message).toBe(bad2.body.message);
    await t.http().post('/v1/portal/auth/otp/request').send({ firm: FIRM, identifier: 'ravi@alpha.example' }).expect(202);
    const code = lastCode('ravi@alpha.example')!;
    expect(code).toMatch(/^\d{6}$/);
    // Stored hashed only; never in the message log / timeline or audit.
    expect((await t.sql(`SELECT 1 FROM portal_otp WHERE code_hash = $1`, [code])).length).toBe(0);
    expect((await t.sql(`SELECT 1 FROM comm_message WHERE body LIKE $1`, [`%${code}%`])).length).toBe(0);
    expect(JSON.stringify(await t.sql(`SELECT diff FROM audit_log WHERE action LIKE 'portal.%'`))).not.toContain(code);
    const ok = (await t.http().post('/v1/portal/auth/otp/verify').send({ firm: FIRM, identifier: 'RAVI@alpha.example', code, device: { platform: 'web' } }).expect(200)).body;
    expect(ok.accessToken).toBeTruthy();
    // single use
    await t.http().post('/v1/portal/auth/otp/verify').send({ firm: FIRM, identifier: 'ravi@alpha.example', code, device: { platform: 'web' } }).expect(401);
    // phone works too
    await portalLogin('98200 11111', '+919820011111');
  });

  it('codes expire (pinned clock), are capped per hour, and repeated failures lock the account', async () => {
    await t.http().post('/v1/portal/auth/otp/request').send({ firm: FIRM, identifier: 'lok@eps.example' }).expect(202);
    const code = lastCode('lok@eps.example')!;
    t.app.get(Clock).set(new Date(NOW.getTime() + 11 * 60_000));
    await t.http().post('/v1/portal/auth/otp/verify').send({ firm: FIRM, identifier: 'lok@eps.example', code, device: { platform: 'web' } }).expect(401);
    t.app.get(Clock).set(new Date(NOW.getTime() + 2 * 3600_000));
    try {
      const before = hub.outbox.filter((m) => m.to === 'lok@eps.example').length;
      for (let i = 0; i < 6; i++) await t.http().post('/v1/portal/auth/otp/request').send({ firm: FIRM, identifier: 'lok@eps.example' }).expect(202);
      expect(hub.outbox.filter((m) => m.to === 'lok@eps.example').length - before).toBe(5); // 6th silently suppressed
      const good = lastCode('lok@eps.example')!;
      // (1 failure already counted for the expired code) → 4 more wrong codes lock it
      for (let i = 0; i < 3; i++) await t.http().post('/v1/portal/auth/otp/verify').send({ firm: FIRM, identifier: 'lok@eps.example', code: good === '111111' ? '222222' : '111111', device: { platform: 'web' } }).expect(401);
      await t.http().post('/v1/portal/auth/otp/verify').send({ firm: FIRM, identifier: 'lok@eps.example', code: '999998', device: { platform: 'web' } }).expect(429);
      await t.http().post('/v1/portal/auth/otp/verify').send({ firm: FIRM, identifier: 'lok@eps.example', code: good, device: { platform: 'web' } }).expect(429);
      expect((await t.sql(`SELECT 1 FROM audit_log WHERE action = 'portal.locked'`)).length).toBe(1);
    } finally { t.app.get(Clock).set(NOW); }
  });

  it('refresh rotates; reuse revokes; logout kills the session', async () => {
    const s = await portalLogin('gita@gamma.example');
    const r = (await t.http().post('/v1/portal/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200)).body;
    await t.http().get('/v1/portal/me').set(H(r)).expect(200);
    await t.http().post('/v1/portal/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401); // reuse
    await t.http().get('/v1/portal/me').set(H(r)).expect(401); // session revoked
    const s2 = await portalLogin('gita@gamma.example');
    await t.http().post('/v1/portal/auth/logout').set(H(s2)).expect(204);
    await t.http().get('/v1/portal/me').set(H(s2)).expect(401);
  });
});

describe('session separation (global guard)', () => {
  it('a portal session is refused on EVERY staff route and a staff session on every portal route', async () => {
    const portal = await portalLogin('ravi@alpha.example');
    const reflector = t.app.get(Reflector);
    const routes: Array<{ method: string; path: string; portal: boolean }> = [];
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
            .replace(/:kind/g, 'pbc').replace(/:provider/g, 'mock').replace(/:(\w+)/g, '00000000-0000-4000-8000-000000000000');
          routes.push({ method, path, portal: !!reflector.getAllAndOverride<boolean>(PORTAL_ALLOWED, [h as never, cls as never]) });
        }
      }
    }
    const staff = routes.filter((r) => !r.portal); const portalRoutes = routes.filter((r) => r.portal);
    expect(staff.length).toBeGreaterThan(300);
    expect(portalRoutes.length).toBe(20);
    expect(portalRoutes.every((r) => r.path.startsWith('/v1/portal/'))).toBe(true);
    const call = (r: { method: string; path: string }, tok: string) => (t.http() as unknown as Record<string, (p: string) => { set: (h: Record<string, string>) => Promise<{ status: number }> }>)[r.method.toLowerCase()]!(r.path).set(bearer(tok));
    const failures: string[] = [];
    for (const r of staff) { const res = await call(r, portal.accessToken); if (res.status !== 401) failures.push(`${r.method} ${r.path} → ${res.status}`); }
    for (const r of portalRoutes) { const res = await call(r, P.accessToken); if (res.status !== 401) failures.push(`staff on ${r.method} ${r.path} → ${res.status}`); }
    expect(failures).toEqual([]);
    // and the staff realtime socket / signed staff downloads don't accept portal tokens either (verified by issuer+audience)
  }, 120_000);
});

describe('grants and scoping', () => {
  let ravi1: { accessToken: string }; let gita: { accessToken: string };
  let itr25: string; let itr24: string; let gst25: string; let hidden: string;
  beforeAll(async () => {
    ravi1 = await portalLogin('ravi@alpha.example');
    gita = await portalLogin('gita@gamma.example');
    itr25 = await upload(P, C, 'ITR 2025-26.pdf', { category: 'ITR', fy: '2025-26' });
    itr24 = await upload(P, C, 'ITR 2024-25.pdf', { category: 'ITR', fy: '2024-25' });
    gst25 = await upload(P, C, 'GSTR-9.pdf', { category: 'GST', fy: '2025-26' });
    hidden = await upload(P, C, 'Working papers.pdf', { category: 'ITR', fy: '2025-26' });
    for (const id of [itr25, itr24, gst25]) await t.http().patch(`/v1/documents/${id}`).set(H(P)).send({ clientVisible: true }).expect(204);
  });

  it('me lists only granted clients; multi-client contact switches between group companies', async () => {
    const me = (await t.http().get('/v1/portal/me').set(H(ravi1)).expect(200)).body;
    expect(me.clients.map((c: { name: string }) => c.name).sort()).toEqual(['Alpha Pvt Ltd', 'Beta Pvt Ltd']);
    expect(me.clients[0].grants.notices).toBe(false);
    expect(me.branding).toMatchObject({ firm: FIRM, accent: 'blue' });
    await t.http().get(`/v1/portal/clients/${A}/dashboard`).set(H(ravi1)).expect(200);
    await t.http().get(`/v1/portal/clients/${B}/dashboard`).set(H(ravi1)).expect(200);
    for (const other of [C, D, E, '00000000-0000-4000-8000-000000000000']) await t.http().get(`/v1/portal/clients/${other}/dashboard`).set(H(ravi1)).expect(404);
    expect((await t.http().get('/v1/portal/me').set(H(gita)).expect(200)).body.clients.map((c: { id: string }) => c.id)).toEqual([C]);
  });

  it('documents: client-visible only, in granted categories/FYs; downloads re-check grants', async () => {
    const docs = (await t.http().get(`/v1/portal/clients/${C}/documents`).set(H(gita)).expect(200)).body as Array<{ id: string }>;
    expect(docs.map((d) => d.id)).toEqual([itr25]);
    for (const id of [itr24, gst25, hidden]) await t.http().post(`/v1/portal/clients/${C}/documents/${id}/download-url`).set(H(gita)).expect(404);
    const { url } = (await t.http().post(`/v1/portal/clients/${C}/documents/${itr25}/download-url`).set(H(gita)).expect(200)).body;
    const f = await t.http().get(url).expect(200);
    expect(f.headers['content-disposition']).toContain('ITR%202025-26.pdf');
    // the signed URL is dead once the grant is narrowed
    const acc = (await t.sql<{ id: string }>('SELECT id FROM portal_access WHERE client_id = $1', [C]))[0]!.id;
    await t.http().patch(`/v1/portal-admin/access/${acc}`).set(H(P)).send({ grants: { documents: { categories: ['GST'] }, invoices: false } }).expect(204);
    await t.http().get(url).expect(404);
    expect((await t.http().get(`/v1/portal/clients/${C}/documents`).set(H(gita)).expect(200)).body.map((d: { id: string }) => d.id).sort()).toEqual([gst25].sort());
    expect((await t.sql(`SELECT 1 FROM audit_log WHERE action = 'document.updated' AND entity_id = $1 AND diff->>'clientVisible' = 'true'`, [itr25])).length).toBe(1);
  });

  it('ungranted areas answer 404 (invoices off; notices off by default) and staff-only data never leaks', async () => {
    await t.http().get(`/v1/portal/clients/${C}/invoices`).set(H(gita)).expect(404);
    await t.http().get(`/v1/portal/clients/${C}/notices`).set(H(gita)).expect(404);
    await t.http().get(`/v1/portal/clients/${A}/notices`).set(H(ravi1)).expect(404);
    const dash = (await t.http().get(`/v1/portal/clients/${C}/dashboard`).set(H(gita)).expect(200)).body;
    expect(dash.outstanding).toBeUndefined();
    expect(dash.upcomingDueDates).toBeUndefined();
  });
});

describe('client actions reflect instantly in the office', () => {
  let ravi1: { accessToken: string };
  beforeAll(async () => { ravi1 = await portalLogin('ravi@alpha.example'); });

  it('upload → "From client" inbox, staff notified, realtime cursor, visible in office list; cannot overwrite; bad types refused', async () => {
    events.length = 0;
    const id = (await t.http().post(`/v1/portal/clients/${A}/documents`).set(H(ravi1)).field('name', 'Bank statement Sep.pdf').attach('file', pdf, { filename: 'bank.pdf', contentType: 'application/pdf' }).expect(201)).body.id;
    expect(events.some((e) => e.type === 'changed' && e.cursor > 0)).toBe(true);
    const office = (await t.http().get(`/v1/documents?clientId=${A}`).set(H(S)).expect(200)).body.items;
    expect(office.find((d: { id: string }) => d.id === id)).toMatchObject({ category: 'From client', source: 'portal', clientVisible: false });
    expect((await t.sql(`SELECT 1 FROM notification WHERE user_id = $1 AND category = 'client.uploaded' AND entity_id = $2`, [S.userId, id])).length).toBe(1);
    expect((await t.http().get(`/v1/portal/clients/${A}/documents`).set(H(ravi1)).expect(200)).body.some((d: { id: string; fromClient: boolean }) => d.id === id && d.fromClient)).toBe(true);
    await t.http().post(`/v1/portal/clients/${A}/documents`).set(H(ravi1)).field('documentId', id).attach('file', pdf, { filename: 'x.pdf', contentType: 'application/pdf' }).expect(400);
    await t.http().post(`/v1/portal/clients/${A}/documents`).set(H(ravi1)).attach('file', Buffer.from('MZ'), { filename: 'run.exe', contentType: 'application/octet-stream' }).expect(400);
    await t.http().post(`/v1/portal/clients/${C}/documents`).set(H(ravi1)).attach('file', pdf, { filename: 'x.pdf', contentType: 'application/pdf' }).expect(404);
  });

  it('PBC item and pending-client task answered from the portal: status moves, assignee notified, reply on the timeline', async () => {
    const eng = (await t.http().post('/v1/audit/engagements').set(H(P)).send({ clientId: A, fy: '2025-26', auditType: 'statutory', managerId: S.userId }).expect(201)).body.id;
    const pbc = (await t.http().post(`/v1/audit/engagements/${eng}/pbc`).set(H(P)).send({ items: [{ title: 'Fixed asset register', dueDate: '2026-11-05' }] }).expect(201)).body.ids[0];
    const task = (await t.http().post('/v1/tasks').set(H(P)).send({ client_id: A, title: 'GSTR-3B Sep', assignee_id: S.userId }).expect(201)).body.id;
    await t.http().patch(`/v1/tasks/${task}`).set(H(S)).send({ status: 'pending_client', pending_issue: 'Send purchase invoices for September' }).expect(204);
    const reqs = (await t.http().get(`/v1/portal/clients/${A}/requests`).set(H(ravi1)).expect(200)).body as Array<Record<string, unknown>>;
    expect(reqs.find((r) => r.kind === 'task')).toMatchObject({ id: task, issue: 'Send purchase invoices for September' });
    expect(reqs.find((r) => r.kind === 'pbc')).toMatchObject({ id: pbc, status: 'requested' });
    expect(JSON.stringify(reqs)).not.toMatch(/assignee|estimate|cost/i);
    await t.http().post(`/v1/portal/clients/${A}/requests/pbc/${pbc}/respond`).set(H(ravi1)).field('message', 'Attached FAR').attach('file', pdf, { filename: 'far.pdf', contentType: 'application/pdf' }).expect(200);
    const it = (await t.sql<{ status: string; document_ids: string[]; client_response: string }>('SELECT status, document_ids, client_response FROM pbc_item WHERE id = $1', [pbc]))[0]!;
    expect(it).toMatchObject({ status: 'received', client_response: 'Attached FAR' });
    expect(it.document_ids).toHaveLength(1);
    expect((await t.http().post(`/v1/portal/clients/${A}/requests/task/${task}/respond`).set(H(ravi1)).field('message', 'Uploaded to Drive folder, sharing here').expect(200)).body.status).toBe('in_progress');
    expect((await t.http().get(`/v1/tasks/${task}`).set(H(S)).expect(200)).body.status).toBe('in_progress');
    expect((await t.sql(`SELECT 1 FROM notification WHERE user_id = $1 AND category = 'portal.response' AND entity_id = $2`, [S.userId, task])).length).toBe(1);
    expect((await t.sql(`SELECT 1 FROM notification WHERE user_id = $1 AND category = 'portal.response' AND entity_id = $2`, [S.userId, pbc])).length).toBe(1);
    const tl = (await t.http().get(`/v1/clients/${A}/timeline?channel=portal`).set(H(P)).expect(200)).body.items;
    expect(tl.some((x: { body: string }) => x.body === 'Uploaded to Drive folder, sharing here')).toBe(true);
    await t.http().post(`/v1/portal/clients/${A}/requests/task/${task}/respond`).set(H(ravi1)).field('message', 'again').expect(404); // no longer waiting on the client
    await t.http().post(`/v1/portal/clients/${B}/requests/pbc/${pbc}/respond`).set(H(ravi1)).field('message', 'x').expect(404); // other client
  });

  it('pays an issued invoice through the mock link; webhook receipt shows in the portal', async () => {
    const draft = (await t.http().post('/v1/billing/invoices').set(H(P)).send({ clientId: A, lines: [{ description: 'Audit fee', ratePaise: 100_000 }] }).expect(201)).body.id;
    await t.http().get(`/v1/portal/clients/${A}/invoices/${draft}`).set(H(ravi1)).expect(404); // drafts never shown
    await t.http().post(`/v1/billing/invoices/${draft}/issue`).set(H(P)).send({ issueDate: '2026-10-29' }).expect(200);
    const list = (await t.http().get(`/v1/portal/clients/${A}/invoices`).set(H(ravi1)).expect(200)).body;
    expect(list[0]).toMatchObject({ id: draft, status: 'issued', balancePaise: 118_000 });
    const pay = (await t.http().post(`/v1/portal/clients/${A}/invoices/${draft}/pay`).set(H(ravi1)).expect(200)).body;
    expect((await t.http().post(`/v1/portal/clients/${A}/invoices/${draft}/pay`).set(H(ravi1)).expect(200)).body.url).toBe(pay.url); // live link reused
    await t.http().get(`/v1/portal/clients/${A}/invoices/${draft}/pdf`).set(H(ravi1)).expect(200).expect('Content-Type', /pdf/);
    const body = JSON.stringify({ id: 'evt_portal_1', type: 'payment.captured', linkId: pay.url.split('/').pop(), paymentId: 'pay_portal_1', amountPaise: 118_000 });
    await t.http().post(`/v1/billing/webhooks/mock/${P.tenantId}`).set('Content-Type', 'application/json').set('x-worko-signature', createHmac('sha256', 'worko-dev-webhook-secret').update(body).digest('hex')).send(body).expect(200);
    expect((await t.http().get(`/v1/portal/clients/${A}/invoices/${draft}`).set(H(ravi1)).expect(200)).body).toMatchObject({ status: 'paid', balancePaise: 0, payable: false });
    const rec = (await t.http().get(`/v1/portal/clients/${A}/receipts`).set(H(ravi1)).expect(200)).body;
    expect(rec[0]).toMatchObject({ amountPaise: 118_000, mode: 'online', allocations: [{ amountPaise: 118_000 }] });
    await t.http().post(`/v1/portal/clients/${A}/invoices/${draft}/pay`).set(H(ravi1)).expect(409);
  });

  it('messages: client ↔ staff thread; internal notes stay internal', async () => {
    await t.http().post(`/v1/portal/clients/${A}/messages`).set(H(ravi1)).send({ body: 'When is the audit meeting?' }).expect(201);
    expect((await t.sql(`SELECT 1 FROM notification WHERE user_id = $1 AND category = 'portal.message'`, [S.userId])).length).toBe(1);
    await t.http().post(`/v1/clients/${A}/timeline`).set(H(P)).send({ channel: 'note', body: 'INTERNAL: client is slow to pay' }).expect(201);
    await t.http().post(`/v1/portal-admin/clients/${A}/messages`).set(H(S)).send({ body: 'Monday 11am works.' }).expect(201);
    const thread = (await t.http().get(`/v1/portal/clients/${A}/messages`).set(H(ravi1)).expect(200)).body as Array<{ body: string; direction: string }>;
    expect(thread.map((m) => m.body)).toContain('Monday 11am works.');
    expect(JSON.stringify(thread)).not.toContain('INTERNAL');
    expect((await t.http().get(`/v1/portal-admin/clients/${A}/messages`).set(H(S)).expect(200)).body.some((m: { body: string }) => m.body === 'When is the audit meeting?')).toBe(true);
    await t.http().get(`/v1/portal/clients/${B}/messages`).set(H(ravi1)).expect(200).expect((r) => expect(r.body).toEqual([]));
  });

  it('consent and profile changes: recorded with source portal; staff approve contact changes (values encrypted at rest)', async () => {
    await t.http().put('/v1/portal/consent').set(H(ravi1)).send({ clientId: A, channel: 'email', status: 'opted_out' }).expect(200);
    const c = (await t.sql<{ status: string; opted_out_source: string }>(`SELECT status, opted_out_source FROM comm_consent WHERE address = 'ravi@alpha.example' AND channel = 'email'`))[0]!;
    expect(c).toEqual({ status: 'opted_out', opted_out_source: 'portal' });
    expect(JSON.stringify(await t.sql(`SELECT diff FROM audit_log WHERE action = 'portal.consent_opted_out'`))).not.toContain('ravi@alpha.example');
    const r = (await t.http().post('/v1/portal/profile/requests').set(H(ravi1)).send({ clientId: A, changes: { phone: '+919820022222', role: 'CFO' } }).expect(201)).body;
    const raw = (await t.sql<{ changes_enc: Buffer }>('SELECT changes_enc FROM portal_profile_request WHERE id = $1', [r.id]))[0]!.changes_enc;
    expect(raw.toString('latin1')).not.toContain('9820022222');
    const pending = (await t.http().get('/v1/portal-admin/profile-requests').set(H(P)).expect(200)).body;
    expect(pending[0]).toMatchObject({ id: r.id, fields: ['phone', 'role'], changes: { phone: '+919820022222', role: 'CFO' } });
    await t.http().post(`/v1/portal-admin/profile-requests/${r.id}/decide`).set(H(P)).send({ approve: true }).expect(204);
    expect((await t.sql<{ phone: string; role: string }>('SELECT phone, role FROM contact WHERE id = $1', [ravi.A]))[0]).toEqual({ phone: '+919820022222', role: 'CFO' });
    await t.http().post(`/v1/portal-admin/profile-requests/${r.id}/decide`).set(H(P)).send({ approve: true }).expect(409);
    expect(JSON.stringify(await t.sql(`SELECT diff FROM audit_log WHERE action LIKE 'portal.profile%'`))).not.toContain('9820022222');
  });

  it('revoking a client hides it (404); disabling the person ends their sessions', async () => {
    t.app.get(Clock).set(new Date(NOW.getTime() + 3 * 3600_000)); // past the hourly OTP cap used up above
    const s = await portalLogin('ravi@alpha.example');
    t.app.get(Clock).set(NOW);
    const acc = (await t.sql<{ id: string }>('SELECT id FROM portal_access WHERE client_id = $1', [B]))[0]!.id;
    await t.http().patch(`/v1/portal-admin/access/${acc}`).set(H(P)).send({ revoked: true }).expect(204);
    await t.http().get(`/v1/portal/clients/${B}/dashboard`).set(H(s)).expect(404);
    await t.http().get(`/v1/portal/clients/${A}/dashboard`).set(H(s)).expect(200);
    await t.http().put(`/v1/portal-admin/clients/${A}/enabled`).set(H(P)).send({ enabled: false }).expect(204);
    await t.http().get(`/v1/portal/clients/${A}/dashboard`).set(H(s)).expect(404);
    await t.http().put(`/v1/portal-admin/clients/${A}/enabled`).set(H(P)).send({ enabled: true }).expect(204);
    await t.http().patch(`/v1/portal-admin/users/${s.portalUserId}`).set(H(P)).send({ status: 'disabled' }).expect(204);
    await t.http().get('/v1/portal/me').set(H(s)).expect(401);
    await t.http().post('/v1/portal/auth/otp/request').send({ firm: FIRM, identifier: 'ravi@alpha.example' }).expect(202);
    const users = (await t.http().get('/v1/portal-admin/users').set(H(P)).expect(200)).body;
    expect(users.find((u: { id: string }) => u.id === s.portalUserId).status).toBe('disabled');
  });

  it('white-label settings: firm-wide settings:edit, palette accents only, public branding by slug', async () => {
    await t.http().put('/v1/portal-admin/settings').set(H(S)).send({ displayName: 'X' }).expect(403);
    await t.http().put('/v1/portal-admin/settings').set(H(P)).send({ accent: '#ff0000' }).expect(400);
    await t.http().put('/v1/portal-admin/settings').set(H(P)).send({ displayName: 'Portal & Co Client Desk', accent: 'teal', customDomain: 'clients.portalco.in' }).expect(200);
    expect((await t.http().get(`/v1/portal/branding/${FIRM}`).expect(200)).body).toMatchObject({ displayName: 'Portal & Co Client Desk', accent: 'teal', customDomain: 'clients.portalco.in', logoUrl: null });
    await t.http().get('/v1/portal/branding/no-such-firm').expect(404);
  });

  it('audit trail carries no contact PII from portal actions', async () => {
    const all = JSON.stringify(await t.sql(`SELECT diff FROM audit_log WHERE action LIKE 'portal.%'`));
    for (const pii of ['ravi@alpha.example', '9820011111', 'gita@gamma.example', 'Ravi Kumar']) expect(all).not.toContain(pii);
  });
});
