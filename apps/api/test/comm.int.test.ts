import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Clock } from '../src/common/clock.js';
import { DEV_COMM_WEBHOOK_SECRET, MockChannelHub, type MockOAuthProvider, OAUTH_PROVIDERS } from '../src/comm/channels.js';
import { JobQueueService } from '../src/jobs/job-queue.service.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let M: Session; let S: Session;
let hub: MockChannelHub; let clock: Clock; let jobs: JobQueueService;
const NOW = new Date('2026-10-15T11:00:00+05:30'); // Thursday, outside quiet hours
const H = (s: Session) => bearer(s.accessToken);

async function client(name: string, contact: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const r = await t.http().post('/v1/clients').set(H(P)).send({ name, entityType: 'PRIVATE_COMPANY', contacts: [{ name: `${name} Owner`, isPrimary: true, ...contact }], ...extra }).expect(201);
  return r.body.id as string;
}
const sign = (raw: string) => createHmac('sha256', DEV_COMM_WEBHOOK_SECRET).update(raw).digest('hex');
function webhook(events: Array<Record<string, unknown>>, opts: { sig?: string; tenant?: string } = {}) {
  const raw = JSON.stringify({ events });
  return t.http().post(`/v1/comm/webhooks/mock/${opts.tenant ?? P.tenantId}`).set('Content-Type', 'application/json').set('x-worko-signature', opts.sig ?? sign(raw)).send(raw);
}
async function template(body: Record<string, unknown>, approve = true) {
  const id = (await t.http().post('/v1/comm/templates').set(H(P)).send(body).expect(201)).body.id;
  if (approve) {
    await t.http().post(`/v1/comm/templates/${id}/submit`).set(H(P)).expect(200);
    await t.http().post(`/v1/comm/templates/${id}/decide`).set(H(P)).send({ approve: true }).expect(200);
  }
  return id as string;
}

beforeAll(async () => {
  t = await bootApp();
  clock = t.app.get(Clock); clock.set(NOW);
  hub = t.app.get(MockChannelHub); jobs = t.app.get(JobQueueService);
  P = await t.signup('commfirm');
  M = await t.addUser(P, 'commfirm', 'Mira', 'manager');
  S = await t.addUser(P, 'commfirm', 'Sohan', 'senior');
}, 60_000);
afterAll(() => t?.close());

describe('templates', () => {
  it('validates placeholders, refuses secrets and resets approval on edit', async () => {
    const bad = await t.http().post('/v1/comm/templates').set(H(P)).send({ name: 'bad_one', channel: 'whatsapp', category: 'utility', body: 'Hi {{client.nme}} your {{vault.password}}' }).expect(400);
    expect(bad.body.issues).toEqual(['unknown_variable:client.nme', 'forbidden_variable:vault.password']);
    await t.http().post('/v1/comm/templates').set(H(P)).send({ name: 'no_subject', channel: 'email', category: 'utility', body: 'Hi' }).expect(400);
    const id = await template({ name: 'gst_reminder', channel: 'whatsapp', category: 'utility', body: 'Dear {{contact.name}}, please share {{period}} purchase data. — {{firm.name}}' }, false);
    await t.http().post(`/v1/comm/templates/${id}/decide`).set(H(P)).send({ approve: true }).expect(409); // not submitted
    await t.http().post(`/v1/comm/templates/${id}/submit`).set(H(P)).expect(200);
    await t.http().post(`/v1/comm/templates/${id}/decide`).set(H(M)).send({ approve: true }).expect(403); // team-scope approve is not firm-wide
    await t.http().post(`/v1/comm/templates/${id}/decide`).set(H(P)).send({ approve: true }).expect(200);
    const edited = await t.http().patch(`/v1/comm/templates/${id}`).set(H(P)).send({ body: 'Dear {{contact.name}}, please share {{period}} data.' }).expect(200);
    expect(edited.body.status).toBe('draft');
    const pv = await t.http().post(`/v1/comm/templates/${id}/render`).set(H(P)).send({ vars: { 'contact.name': '<b>Ravi</b>' } }).expect(200);
    expect(pv.body).toMatchObject({ body: 'Dear <b>Ravi</b>, please share  data.', missing: ['period'] });
    // Audit carries metadata, not the body.
    const audit = await t.sql<{ diff: unknown }>(`SELECT diff FROM audit_log WHERE entity = 'comm_template'`);
    expect(JSON.stringify(audit)).not.toContain('purchase data');
  });
});

describe('consent, STOP, quiet hours and caps', () => {
  let cid: string; let tplMarketing: string;
  beforeAll(async () => {
    cid = await client('Laxmi Traders', { phone: '+919811100001', whatsapp: '+919811100001', email: 'owner@laxmi.in' }, { managerId: M.userId });
    tplMarketing = await template({ name: 'diwali_greeting', channel: 'whatsapp', category: 'marketing', body: 'Happy Diwali {{contact.name}}! — {{firm.name}}' });
  });

  it('marketing needs an opt-in; STOP via webhook opts out; START opts back in', async () => {
    const refused = await t.http().post('/v1/comm/messages').set(H(P)).send({ clientId: cid, channel: 'whatsapp', templateId: tplMarketing }).expect(409);
    expect(refused.body.code).toBe('not_opted_in');
    await t.http().post('/v1/comm/consents').set(H(P)).send({ clientId: cid, channel: 'whatsapp', status: 'opted_in', source: 'written' }).expect(201);
    const ok = await t.http().post('/v1/comm/messages').set(H(P)).send({ clientId: cid, channel: 'whatsapp', templateId: tplMarketing }).expect(201);
    expect(ok.body.status).toBe('sent');
    expect(hub.outbox.at(-1)).toMatchObject({ to: '+919811100001', text: 'Happy Diwali Laxmi Traders Owner! — commfirm & Co', template: { name: 'diwali_greeting' } });

    // Client replies "Stop" from a differently formatted number → matched, opted out, manager notified (no text in the notification).
    const r = await webhook([{ id: 'ev-stop-1', channel: 'whatsapp', from: '098111 00001', text: ' Stop ', ref: 'wamid.1' }]).expect(200);
    expect(r.body.results).toEqual([{ eventId: 'ev-stop-1', outcome: 'matched' }]);
    const [c] = (await t.http().get(`/v1/comm/consents?clientId=${cid}`).set(H(P)).expect(200)).body;
    expect(c).toMatchObject({ channel: 'whatsapp', address: '+919811100001', status: 'opted_out', optedOutSource: 'keyword:whatsapp', keyword: 'STOP' });
    const notes = await t.sql<{ category: string; body: string }>(`SELECT category, body FROM notification WHERE user_id = $1 AND entity_id = $2`, [M.userId, cid]);
    expect(notes).toEqual([{ category: 'whatsapp.reply', body: 'Keyword STOP — consent updated' }]);
    expect((await t.http().post('/v1/comm/messages').set(H(P)).send({ clientId: cid, channel: 'whatsapp', templateId: tplMarketing }).expect(409)).body.code).toBe('opted_out');
    // Opt-out also blocks transactional (firm policy default), even inside the 24h session window.
    expect((await t.http().post('/v1/comm/messages').set(H(P)).send({ clientId: cid, channel: 'whatsapp', body: 'Your GSTR-3B is filed' }).expect(409)).body.code).toBe('opted_out');
    // Email is a separate channel with no opt-out: transactional allowed without explicit consent.
    expect((await t.http().post('/v1/comm/messages').set(H(P)).send({ clientId: cid, channel: 'email', subject: 'Filed', body: 'Your GSTR-3B is filed' }).expect(201)).body.status).toBe('sent');
    await webhook([{ id: 'ev-start-1', channel: 'whatsapp', from: '+91 98111 00001', text: 'START', ref: 'wamid.2' }]).expect(200);
    expect((await t.http().get(`/v1/comm/consents?clientId=${cid}`).set(H(P))).body.find((x: { channel: string }) => x.channel === 'whatsapp').status).toBe('opted_in');
  });

  it('free-text WhatsApp only inside the 24-hour window; a STOP cancels a queued message', async () => {
    const cold = await client('Cold Client', { phone: '+919811100009', whatsapp: '+919811100009' });
    expect((await t.http().post('/v1/comm/messages').set(H(P)).send({ clientId: cold, channel: 'whatsapp', body: 'Hello' }).expect(409)).body.code).toBe('template_required');
    // Quiet hours: 22:30 IST → queued for 08:00; a STOP before then cancels it at send time.
    clock.set(new Date('2026-10-15T22:30:00+05:30'));
    const q = await t.http().post('/v1/comm/messages').set(H(P)).send({ clientId: cid, channel: 'whatsapp', body: 'Documents received, thanks' }).expect(201);
    expect(q.body).toMatchObject({ status: 'queued', sendAt: '2026-10-16T02:30:00.000Z' });
    const before = hub.outbox.length;
    await jobs.runOnce(50, new Date('2026-10-15T23:00:00+05:30'));
    expect(hub.outbox.length).toBe(before);
    await jobs.runOnce(50, new Date('2026-10-16T08:01:00+05:30'));
    expect(hub.outbox.length).toBe(before + 1);
    const q2 = await t.http().post('/v1/comm/messages').set(H(P)).send({ clientId: cid, channel: 'email', subject: 'Late', body: 'Late night note' }).expect(201);
    expect(q2.body.status).toBe('queued');
    await t.http().post('/v1/comm/consents').set(H(P)).send({ clientId: cid, channel: 'email', status: 'opted_out', source: 'email' }).expect(201);
    await jobs.runOnce(50, new Date('2026-10-16T08:05:00+05:30'));
    expect(hub.outbox.length).toBe(before + 1);
    expect((await t.sql<{ status: string; error: string }>('SELECT status, error FROM comm_message WHERE id = $1', [q2.body.id]))[0]).toEqual({ status: 'cancelled', error: 'opted_out' });
    clock.set(NOW);
  });

  it('caps block (or warn) past the monthly budget; usage meters cost by channel', async () => {
    const before = (await t.http().get('/v1/comm/usage?month=2026-10').set(H(P)).expect(200)).body.byChannel.find((c: { channel: string }) => c.channel === 'whatsapp').costPaise;
    const s = (await t.http().get('/v1/comm/settings').set(H(P)).expect(200)).body;
    await t.http().put('/v1/comm/settings').set(H(M)).send(s).expect(403);
    await t.http().put('/v1/comm/settings').set(H(P)).send({ ...s, caps: { ...s.caps, monthlyPaise: { ...s.caps.monthlyPaise, whatsapp: before + 100 } } }).expect(200);
    expect((await t.http().post('/v1/comm/messages').set(H(P)).send({ clientId: cid, channel: 'whatsapp', templateId: tplMarketing }).expect(201)).body.costPaise).toBe(88);
    expect((await t.http().post('/v1/comm/messages').set(H(P)).send({ clientId: cid, channel: 'whatsapp', templateId: tplMarketing }).expect(409)).body.code).toBe('over_cap');
    await t.http().put('/v1/comm/settings').set(H(P)).send({ ...s, caps: { ...s.caps, mode: 'warn', monthlyPaise: { ...s.caps.monthlyPaise, whatsapp: before + 100 } } }).expect(200);
    expect((await t.http().post('/v1/comm/messages').set(H(P)).send({ clientId: cid, channel: 'whatsapp', templateId: tplMarketing }).expect(201)).body.capWarning).toBe(true);
    const u = (await t.http().get('/v1/comm/usage?month=2026-10').set(H(P)).expect(200)).body.byChannel.find((c: { channel: string }) => c.channel === 'whatsapp');
    expect(u).toMatchObject({ costPaise: before + 176, capPaise: before + 100, overCap: true, capWarnings: 1 });
    // A firm rate replaces the (unverified) card rate from its effective date.
    await t.http().post('/v1/comm/rates').set(H(P)).send({ channel: 'whatsapp', category: 'marketing', paise: 70, effectiveFrom: '2026-10-01' }).expect(201);
    const rates = (await t.http().get('/v1/comm/rates').set(H(P)).expect(200)).body;
    expect(rates.filter((r: { channel: string; category: string }) => r.channel === 'whatsapp' && r.category === 'marketing')).toEqual([expect.objectContaining({ paise: 70, source: 'firm' })]);
    expect(rates.find((r: { channel: string; category: string }) => r.channel === 'sms').verified).toBe(false);
    await t.http().put('/v1/comm/settings').set(H(P)).send(s).expect(200);
  });
});

describe('webhook hardening', () => {
  it('rejects bad signatures without writing, dedupes replays and is locked down in production', async () => {
    const count = async () => Number((await t.sql<{ n: string }>('SELECT count(*) AS n FROM comm_webhook_event'))[0]!.n);
    const n0 = await count();
    await webhook([{ id: 'ev-x', channel: 'sms', from: '+919800011111', text: 'hi' }], { sig: 'deadbeef' }).expect(401);
    await webhook([{ id: 'ev-x', channel: 'sms', from: '+919800011111', text: 'hi' }], { tenant: '00000000-0000-0000-0000-000000000000' }).expect(404);
    expect(await count()).toBe(n0);
    const first = await webhook([{ id: 'ev-sms-1', channel: 'sms', from: '+919800011111', text: 'Who is this?', ref: 'sms-1' }]).expect(200);
    expect(first.body.results[0].outcome).toBe('unmatched');
    expect((await webhook([{ id: 'ev-sms-1', channel: 'sms', from: '+919800011111', text: 'Who is this?', ref: 'sms-1' }]).expect(200)).body.results[0].outcome).toBe('duplicate');
    expect(Number((await t.sql<{ n: string }>(`SELECT count(*) AS n FROM comm_message WHERE provider_ref = 'sms-1'`))[0]!.n)).toBe(1);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { await webhook([{ id: 'ev-prod', channel: 'sms', from: '+919800011111', text: 'x' }]).expect(404); } finally { process.env.NODE_ENV = env; }
    // Meta provider without an app secret verifies nothing.
    await t.http().post(`/v1/comm/webhooks/meta/${P.tenantId}`).set('Content-Type', 'application/json').set('x-hub-signature-256', 'sha256=00').send('{}').expect(401);
  });
});

describe('client timeline and triage inbox', () => {
  it('merges messages/notes/calls, pages, is client-scoped (404) and assigns unmatched inbound', async () => {
    const cid = await client('Om Steels', { phone: '+919822200002', email: 'om@steels.in' }, { managerId: M.userId });
    for (const i of [1, 2, 3]) {
      clock.set(new Date(NOW.getTime() + i * 60_000));
      await t.http().post(`/v1/clients/${cid}/timeline`).set(H(P)).send({ channel: i === 2 ? 'call' : 'note', body: `entry ${i}`, callMinutes: i === 2 ? 12 : null, direction: 'in' }).expect(201);
    }
    clock.set(NOW);
    await t.http().get(`/v1/clients/${cid}/timeline`).set(H(S)).expect(404); // senior (own scope) cannot see this client
    await t.http().post(`/v1/clients/${cid}/timeline`).set(H(S)).send({ channel: 'note', body: 'x' }).expect(404);
    const p1 = (await t.http().get(`/v1/clients/${cid}/timeline?limit=2`).set(H(P)).expect(200)).body;
    expect(p1.items.map((x: { body: string }) => x.body)).toEqual(['entry 3', 'entry 2']);
    expect(p1.items[1]).toMatchObject({ channel: 'call', callMinutes: 12, direction: 'in' });
    const p2 = (await t.http().get(`/v1/clients/${cid}/timeline?limit=2&before=${p1.nextBefore}`).set(H(P)).expect(200)).body;
    expect(p2.items.map((x: { body: string }) => x.body)).toEqual(['entry 1']);
    expect(p2.nextBefore).toBeNull();
    // Manager sees it (team scope via managerId).
    expect((await t.http().get(`/v1/clients/${cid}/timeline`).set(H(M)).expect(200)).body.items).toHaveLength(3);

    // Unmatched inbound → inbox (communication:assign: manager yes, senior no) → assign → timeline.
    await webhook([{ id: 'ev-un-1', channel: 'whatsapp', from: '+919833300003', text: 'Hi, this is Om Steels accounts', ref: 'w-un-1' }]).expect(200);
    await t.http().get('/v1/comm/inbox').set(H(S)).expect(403);
    const inbox = (await t.http().get('/v1/comm/inbox').set(H(M)).expect(200)).body;
    const item = inbox.find((x: { address: string }) => x.address === '+919833300003');
    expect(item.triage).toBe('unmatched');
    await t.http().post(`/v1/comm/inbox/${item.id}/assign`).set(H(M)).send({ clientId: cid }).expect(200);
    const tl = (await t.http().get(`/v1/clients/${cid}/timeline?channel=whatsapp`).set(H(P)).expect(200)).body.items;
    expect(tl).toEqual([expect.objectContaining({ direction: 'in', body: 'Hi, this is Om Steels accounts', status: 'received' })]);
    // Matched inbound lands directly on the timeline (client email).
    clock.set(new Date(NOW.getTime() + 10 * 60_000));
    await webhook([{ id: 'ev-m-2', channel: 'sms', from: '9822200002', text: 'Sent the bank statement', ref: 's-m-2' }]).expect(200);
    clock.set(NOW);
    expect((await t.http().get(`/v1/clients/${cid}/timeline?limit=1`).set(H(P))).body.items[0]).toMatchObject({ channel: 'sms', body: 'Sent the bank statement' });
  });
});

describe('broadcasts', () => {
  let tpl: string; const ids: Record<string, string> = {};
  beforeAll(async () => {
    tpl = await template({ name: 'itr_deadline', channel: 'whatsapp', category: 'marketing', body: 'Dear {{contact.name}}, ITR due {{due_date}}. — {{firm.name}}' });
    const mk = (n: string, phone: string | null) => client(`BC ${n}`, phone ? { phone, whatsapp: phone } : { email: `${n}@bc.in` }, { tags: ['newsletter'], managerId: M.userId });
    ids.a = await mk('A', '+919844400001'); ids.b = await mk('B', '+919844400002'); ids.c = await mk('C', '+919844400003');
    ids.d = await mk('D', '+919844400004'); ids.e = await mk('E', null); ids.f = await mk('F', '+919844400006');
    for (const k of ['a', 'b', 'c']) await t.http().post('/v1/comm/consents').set(H(P)).send({ clientId: ids[k], channel: 'whatsapp', status: 'opted_in', source: 'form' }).expect(201);
    await t.http().post('/v1/comm/consents').set(H(P)).send({ clientId: ids.d, channel: 'whatsapp', status: 'opted_out', source: 'verbal' }).expect(201);
  });

  it('dry-run counts equal send results; resumes after a provider outage without double sends', async () => {
    const b = (await t.http().post('/v1/comm/broadcasts').set(H(M)).send({ name: 'ITR reminder', channel: 'whatsapp', templateId: tpl, filters: { tags: ['newsletter'] }, variables: { due_date: '31 Oct' } }).expect(201)).body.id;
    await t.http().post('/v1/comm/broadcasts').set(H(M)).send({ name: 'x', channel: 'whatsapp', templateId: tpl, filters: {}, variables: { 'vault.secret': 'x' } }).expect(400);
    const pv = (await t.http().post(`/v1/comm/broadcasts/${b}/preview`).set(H(M)).expect(200)).body;
    expect(pv).toMatchObject({ audience: 6, eligible: 3, optedOut: 1, notOptedIn: 1, noContact: 1, overCap: 0, unitPaise: 70, costPaise: 210, needsApproval: false }); // firm rate (70) from the caps test
    await t.http().get(`/v1/comm/broadcasts/${b}`).set(H(S)).expect(404);
    const sent = (await t.http().post(`/v1/comm/broadcasts/${b}/send`).set(H(M)).send({}).expect(200)).body;
    expect(sent.status).toBe('scheduled');
    await t.http().post(`/v1/comm/broadcasts/${b}/send`).set(H(M)).send({}).expect(409);
    hub.throwOnce.add('+919844400002');
    const before = hub.outbox.length;
    await jobs.runOnce(50, NOW); // B's outage stops the batch → job backs off; whoever went before B stays sent
    expect(hub.outbox.slice(before).map((m) => m.to)).not.toContain('+919844400002');
    expect((await t.sql<{ status: string }>(`SELECT status FROM broadcast_recipient WHERE broadcast_id = $1 AND address = '+919844400002'`, [b]))[0]!.status).toBe('sending');
    await jobs.runOnce(50, new Date(NOW.getTime() + 3600_000));
    const mine = hub.outbox.slice(before).map((m) => m.to);
    expect(mine.sort()).toEqual(['+919844400001', '+919844400002', '+919844400003']);
    expect(hub.outbox.slice(before)[0]!.text).toBe('Dear BC A Owner, ITR due 31 Oct. — commfirm & Co');
    const g = (await t.http().get(`/v1/comm/broadcasts/${b}`).set(H(M)).expect(200)).body;
    expect(g).toMatchObject({ status: 'completed', spentPaise: 210, progress: { total: 6, done: 6, counts: { sent: 3, skipped_optout: 2, skipped_nocontact: 1 } } });
    expect(g.progress.counts.sent).toBe(pv.eligible);
    expect(g.progress.counts.skipped_optout).toBe(pv.optedOut + pv.notOptedIn);
    await jobs.runOnce(50, new Date(NOW.getTime() + 7200_000));
    expect(hub.outbox.length).toBe(before + 3);
    const rec = (await t.http().get(`/v1/comm/broadcasts/${b}/recipients?status=sent`).set(H(M)).expect(200)).body;
    expect(rec.every((r: { address: string }) => r.address.startsWith('•'))).toBe(true);
    const csv = await t.http().get(`/v1/comm/broadcasts/${b}/export`).set(H(M)).expect(200);
    expect(csv.text).toContain('BC A');
    await t.http().get(`/v1/comm/broadcasts/${b}/export`).set(H(S)).expect(403);
    // Broadcast messages show on the client timeline.
    expect((await t.http().get(`/v1/clients/${ids.a}/timeline?channel=whatsapp`).set(H(P))).body.items[0].broadcastId).toBe(b);
  });

  it('marketing above the threshold needs firm-wide approval by someone else; cancel stops sending', async () => {
    const s = (await t.http().get('/v1/comm/settings').set(H(P))).body;
    await t.http().put('/v1/comm/settings').set(H(P)).send({ ...s, broadcast: { ...s.broadcast, approvalThreshold: 2 } }).expect(200);
    const b = (await t.http().post('/v1/comm/broadcasts').set(H(M)).send({ name: 'Diwali', channel: 'whatsapp', templateId: tpl, filters: { tags: ['newsletter'] }, variables: { due_date: 'x' } }).expect(201)).body.id;
    expect((await t.http().post(`/v1/comm/broadcasts/${b}/send`).set(H(M)).send({}).expect(200)).body.status).toBe('pending_approval');
    expect((await t.sql(`SELECT 1 FROM notification WHERE category = 'broadcast.approval' AND user_id = $1`, [P.userId])).length).toBe(1);
    await jobs.runOnce(50, NOW);
    await t.http().post(`/v1/comm/broadcasts/${b}/approve`).set(H(M)).expect(403);
    await t.http().post(`/v1/comm/broadcasts/${b}/approve`).set(H(P)).expect(200);
    const before = hub.outbox.length;
    await jobs.runOnce(50, NOW);
    expect(hub.outbox.length).toBe(before + 3);

    // Scheduled in the future, then cancelled → nothing sent.
    const c = (await t.http().post('/v1/comm/broadcasts').set(H(P)).send({ name: 'Later', channel: 'whatsapp', templateId: tpl, filters: { clientIds: [ids.a!] }, variables: { due_date: 'x' } }).expect(201)).body.id;
    expect((await t.http().post(`/v1/comm/broadcasts/${c}/send`).set(H(P)).send({ scheduledAt: '2026-10-20T10:00:00+05:30' }).expect(200)).body.status).toBe('scheduled');
    expect((await t.http().post(`/v1/comm/broadcasts/${c}/cancel`).set(H(P)).expect(200)).body.cancelledRecipients).toBe(1);
    await jobs.runOnce(50, new Date('2026-10-20T10:05:00+05:30'));
    expect(hub.outbox.length).toBe(before + 3);
    expect((await t.http().get(`/v1/comm/broadcasts/${c}`).set(H(P))).body.status).toBe('cancelled');
    await t.http().put('/v1/comm/settings').set(H(P)).send(s).expect(200);
  });

  it('per-broadcast cap skips the excess in the dry run and the send', async () => {
    const s = (await t.http().get('/v1/comm/settings').set(H(P))).body;
    await t.http().put('/v1/comm/settings').set(H(P)).send({ ...s, caps: { ...s.caps, perBroadcastPaise: 100 } }).expect(200);
    const b = (await t.http().post('/v1/comm/broadcasts').set(H(P)).send({ name: 'Capped', channel: 'whatsapp', templateId: tpl, filters: { tags: ['newsletter'] }, variables: { due_date: 'x' } }).expect(201)).body.id;
    const pv = (await t.http().post(`/v1/comm/broadcasts/${b}/preview`).set(H(P)).expect(200)).body;
    expect(pv).toMatchObject({ eligible: 1, overCap: 2, costPaise: 70 });
    await t.http().post(`/v1/comm/broadcasts/${b}/send`).set(H(P)).send({}).expect(200);
    await jobs.runOnce(50, NOW);
    expect((await t.http().get(`/v1/comm/broadcasts/${b}`).set(H(P))).body.progress.counts).toMatchObject({ sent: 1, skipped_cap: 2 });
    await t.http().put('/v1/comm/settings').set(H(P)).send(s).expect(200);
  });
});

describe('mailbox OAuth', () => {
  it('connects with a single-use state, imports mail and never exposes tokens (audit, API, sync)', async () => {
    const oauth = t.app.get<Record<string, MockOAuthProvider>>(OAUTH_PROVIDERS).mock!;
    const cid = await client('Sai Foods', { email: 'ravi@saifoods.in' });
    const { id, authUrl } = (await t.http().post('/v1/comm/connections').set(H(P)).send({ provider: 'mock', purpose: 'mail' }).expect(201)).body;
    const state = new URL(authUrl).searchParams.get('state')!;
    await t.http().get(`/v1/comm/oauth/callback?state=${encodeURIComponent(state.replace(/.$/, 'x'))}&code=mock:partner@commfirm.in`).expect(404);
    expect((await t.http().get(`/v1/comm/oauth/callback?state=${encodeURIComponent(state)}&code=mock:partner@commfirm.in`).expect(200)).body.status).toBe('connected');
    await t.http().get(`/v1/comm/oauth/callback?state=${encodeURIComponent(state)}&code=mock:partner@commfirm.in`).expect(404); // single use
    oauth.inbox.set('partner@commfirm.in', [
      { id: 'm1', from: 'Ravi <ravi@saifoods.in>', to: 'partner@commfirm.in', subject: 'Form 16', text: 'Attached Form 16', at: NOW },
      { id: 'm2', from: 'stranger@spam.in', to: 'partner@commfirm.in', subject: 'Offer', text: 'Buy now', at: NOW },
    ]);
    expect((await t.http().post(`/v1/comm/connections/${id}/sync`).set(H(P)).expect(200)).body).toMatchObject({ fetched: 2, matched: 1, unmatched: 1 });
    expect((await t.http().post(`/v1/comm/connections/${id}/sync`).set(H(P)).expect(200)).body.fetched).toBe(0);
    expect((await t.http().get(`/v1/clients/${cid}/timeline`).set(H(P))).body.items[0]).toMatchObject({ channel: 'email', title: 'Form 16', direction: 'in' });
    const list = (await t.http().get('/v1/comm/connections').set(H(P)).expect(200)).body;
    expect(list[0]).toMatchObject({ provider: 'mock', purpose: 'mail', status: 'active', accountEmail: 'partner@commfirm.in' });
    expect(oauth.issued.length).toBe(2);
    const everything = JSON.stringify([list, await t.sql('SELECT diff FROM audit_log'), (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(P))).body,
      await t.sql(`SELECT encode(access_token_enc, 'escape') AS a, encode(refresh_token_enc, 'escape') AS r FROM oauth_connection`)]);
    for (const tok of oauth.issued) expect(everything).not.toContain(tok);
    await t.http().delete(`/v1/comm/connections/${id}`).set(H(P)).expect(204);
    expect((await t.sql<{ a: unknown }>('SELECT access_token_enc AS a FROM oauth_connection WHERE id = $1', [id]))[0]!.a).toBeNull();
  });
});
