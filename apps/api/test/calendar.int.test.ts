import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MockChannelHub, type MockOAuthProvider, OAUTH_PROVIDERS } from '../src/comm/channels.js';
import { Clock } from '../src/common/clock.js';
import { uuidv7 } from '../src/db/ids.js';
import { JobQueueService } from '../src/jobs/job-queue.service.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let S: Session;
let hub: MockChannelHub; let jobs: JobQueueService;
const NOW = new Date('2026-10-15T09:00:00+05:30'); // Thursday
const H = (s: Session) => bearer(s.accessToken);
const ist = (s: string) => new Date(`${s}+05:30`).toISOString();

beforeAll(async () => {
  t = await bootApp();
  t.app.get(Clock).set(NOW);
  hub = t.app.get(MockChannelHub); jobs = t.app.get(JobQueueService);
  P = await t.signup('calfirm');
  S = await t.addUser(P, 'calfirm', 'Sita', 'senior');
}, 60_000);
afterAll(() => t?.close());

describe('calendar events, projections and ICS', () => {
  let secret: string;
  it('shows own/attended events, task dates, leave and holidays; client-linked only while visible', async () => {
    secret = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Secret Pvt Ltd', entityType: 'PRIVATE_COMPANY' }).expect(201)).body.id;
    await t.http().post('/v1/calendar/events').set(H(P)).send({ title: 'Board prep', startsAt: ist('2026-10-21T15:00:00'), endsAt: ist('2026-10-21T16:00:00'), clientId: secret, attendeeIds: [S.userId] }).expect(201);
    await t.http().post('/v1/calendar/events').set(H(S)).send({ title: 'Busy block', startsAt: ist('2026-10-20T11:00:00'), endsAt: ist('2026-10-20T12:00:00') }).expect(201);
    await t.http().post('/v1/calendar/events').set(H(S)).send({ title: 'x', startsAt: ist('2026-10-20T11:00:00'), endsAt: ist('2026-10-20T10:00:00') }).expect(400);
    await t.http().post('/v1/calendar/events').set(H(S)).send({ title: 'x', startsAt: ist('2026-10-20T11:00:00'), endsAt: ist('2026-10-20T12:00:00'), clientId: secret }).expect(400); // invisible client
    await t.http().post('/v1/hr/holidays').set(H(P)).send({ date: '2026-10-16', name: 'Dussehra' }).expect(201);
    const lt = uuidv7();
    await t.sql(`INSERT INTO leave_type (id, tenant_id, key, name) VALUES ($1,$2,'casual','Casual leave')`, [lt, P.tenantId]);
    await t.sql(`INSERT INTO leave_request (id, tenant_id, user_id, leave_type_id, from_date, to_date, days, status) VALUES ($1,$2,$3,$4,'2026-10-19','2026-10-19',1,'approved')`, [uuidv7(), P.tenantId, S.userId, lt]);
    await t.sql(`INSERT INTO task (id, tenant_id, title, status, act_by, assignee_id) VALUES ($1,$2,'File TDS return','open','2026-10-17',$3)`, [uuidv7(), P.tenantId, S.userId]);
    const items = (await t.http().get('/v1/calendar/events?from=2026-10-15&to=2026-10-31').set(H(S)).expect(200)).body as Array<{ source: string; title: string }>;
    expect(items.map((i) => `${i.source}:${i.title}`)).toEqual(['holiday:Dussehra', 'task:File TDS return', 'leave:Casual leave', 'event:Busy block']);
    expect((await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(S))).body.changes.filter((c: { table: string }) => c.table === 'calendar_event')).toHaveLength(1);
    await t.http().put(`/v1/clients/${secret}/access`).set(H(P)).send({ staffIds: [S.userId] }).expect(204);
    const after = (await t.http().get('/v1/calendar/events?from=2026-10-15&to=2026-10-31').set(H(S))).body as Array<{ title: string; clientName: string | null; editable: boolean }>;
    expect(after.find((i) => i.title === 'Board prep')).toMatchObject({ clientName: 'Secret Pvt Ltd', editable: false });
  });

  it('devices may write own meetings but not appointment/external events', async () => {
    const id = uuidv7();
    const r = (await t.http().post('/v1/sync/push').set(H(S)).send({ mutations: [{ key: `k-${randomUUID()}`, table: 'calendar_event', id, baseVersion: 0,
      patch: { kind: 'personal', title: 'Gym', starts_at: ist('2026-10-22T07:00:00'), ends_at: ist('2026-10-22T08:00:00'), all_day: false } }] }).expect(200)).body.results[0];
    expect(r.status).toBe('applied');
    expect((await t.sql<{ owner_id: string }>('SELECT owner_id FROM calendar_event WHERE id = $1', [id]))[0]!.owner_id).toBe(S.userId);
  });

  it('ICS feed: titles only, invisible clients excluded, names masked on request, revocable', async () => {
    await t.http().put(`/v1/clients/${secret}/access`).set(H(P)).send({ staffIds: [] }).expect(204);
    const plain = (await t.http().post('/v1/calendar/feeds').set(H(S)).send({}).expect(201)).body;
    const path = (u: string) => u.replace(/^.*\/v1/, '/v1');
    let ics = (await t.http().get(path(plain.url)).expect(200)).text;
    expect(ics).toContain('SUMMARY:Busy block');
    expect(ics).toContain('SUMMARY:File TDS return');
    expect(ics).not.toContain('Board prep'); // client no longer visible to Sita
    await t.http().put(`/v1/clients/${secret}/access`).set(H(P)).send({ staffIds: [S.userId] }).expect(204);
    ics = (await t.http().get(path(plain.url)).expect(200)).text;
    expect(ics).not.toContain('Board prep'); // invited, not accepted yet
    const board = (await t.http().get('/v1/calendar/events?from=2026-10-21&to=2026-10-21').set(H(S))).body.find((i: { title: string }) => i.title === 'Board prep');
    expect(board.invited).toBe(true);
    await t.http().post(`/v1/calendar/events/${board.id}/respond`).set(H(S)).send({ accept: true }).expect(204);
    ics = (await t.http().get(path(plain.url)).expect(200)).text;
    expect(ics).toContain('SUMMARY:Board prep — Secret Pvt Ltd');
    const masked = (await t.http().post('/v1/calendar/feeds').set(H(S)).send({ maskClients: true }).expect(201)).body;
    const m = (await t.http().get(path(masked.url)).expect(200)).text;
    expect(m).toContain('SUMMARY:Client meeting');
    expect(m).not.toContain('Secret');
    expect(m).not.toMatch(/DESCRIPTION|LOCATION/);
    expect(JSON.stringify((await t.http().get('/v1/calendar/feeds').set(H(S))).body)).not.toContain(plain.url.split('/').pop());
    await t.http().delete(`/v1/calendar/feeds/${plain.id}`).set(H(S)).expect(204);
    await t.http().get(path(plain.url)).expect(404);
    await t.http().get(path(plain.url).replace(/[^/]+$/, 'x'.repeat(32))).expect(404);
  });
});

describe('appointments', () => {
  let tok: string; let raceId: string;
  it('availability excludes holidays, leave and busy events', async () => {
    await t.http().post('/v1/booking/pages').set(H(S)).send({ slug: 'meet-sita', title: 'Meet Sita', hostUserIds: [P.userId], workingHours: {} }).expect(403);
    await t.http().post('/v1/booking/pages').set(H(S)).send({ slug: 'meet-sita', title: 'Meet Sita', slotMinutes: 60, createTask: true,
      workingHours: { 1: [['10:00', '13:00']], 2: [['10:00', '13:00']], 3: [['10:00', '13:00']], 4: [['10:00', '13:00']], 5: [['10:00', '13:00']] } }).expect(201);
    const r = (await t.http().get('/v1/book/calfirm/meet-sita?from=2026-10-16&to=2026-10-20').expect(200)).body;
    // Fri 16 holiday, Sat/Sun closed, Mon 19 leave, Tue 20 has an 11:00–12:00 event.
    expect(r.slots).toEqual([ist('2026-10-20T10:00:00'), ist('2026-10-20T12:00:00')]);
    expect(r).toMatchObject({ firm: 'calfirm & Co', title: 'Meet Sita', slotMinutes: 60 });
    await t.http().get('/v1/book/nofirm/meet-sita').expect(404);
  });

  it('prevents double booking under a race; confirmation goes through the channel layer', async () => {
    const body = (n: string) => ({ startsAt: ist('2026-10-20T10:00:00'), name: `Racer ${n}`, email: `race${n}@example.in`, purpose: 'Discuss ITR notice', consent: true });
    const res = await Promise.all([t.http().post('/v1/book/calfirm/meet-sita').send(body('1')), t.http().post('/v1/book/calfirm/meet-sita').send(body('2'))]);
    expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
    raceId = res.find((x) => x.status === 201)!.body.id;
    expect(res.find((x) => x.status === 409)!.body.code).toBe('slot_unavailable');
    const ap = (await t.http().get('/v1/booking/appointments').set(H(S)).expect(200)).body;
    expect(ap).toHaveLength(1);
    expect(ap[0].taskId).toBeTruthy();
    const mail = hub.outbox.filter((m) => m.channel === 'email' && m.to.startsWith('race'));
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toMatch(/confirmed for Tue, 20 Oct.*2026.*10:00 IST/);
    expect((await t.http().get('/v1/book/calfirm/meet-sita?from=2026-10-20&to=2026-10-20')).body.slots).toEqual([ist('2026-10-20T12:00:00')]);
  });

  it('reschedule and cancel via signed, rotating links; no PII in the audit log', async () => {
    const b = (await t.http().post('/v1/book/calfirm/meet-sita').send({ startsAt: ist('2026-10-20T12:00:00'), name: 'Ravi Kumar', phone: '98765 43210', email: 'ravi.k@example.in', purpose: 'GST registration' }).expect(201)).body;
    tok = b.manageToken;
    expect((await t.http().get(`/v1/book/manage/${tok}`).expect(200)).body).toMatchObject({ status: 'booked', purpose: 'GST registration' });
    await t.http().post(`/v1/book/manage/${tok}/reschedule`).send({ startsAt: ist('2026-10-20T10:00:00') }).expect(409); // taken
    const rs = (await t.http().post(`/v1/book/manage/${tok}/reschedule`).send({ startsAt: ist('2026-10-21T10:00:00') }).expect(200)).body;
    await t.http().get(`/v1/book/manage/${tok}`).expect(404); // old link revoked
    expect((await t.sql<{ s: Date }>('SELECT e.starts_at AS s FROM appointment a JOIN calendar_event e ON e.id = a.event_id WHERE a.id = $1', [b.id]))[0]!.s.toISOString()).toBe(ist('2026-10-21T10:00:00'));
    await t.http().get(`/v1/book/manage/${tok.slice(0, -2)}xx`).expect(404);
    await t.http().post(`/v1/book/manage/${rs.manageToken}/cancel`).expect(200);
    await t.http().post(`/v1/book/manage/${rs.manageToken}/cancel`).expect(404); // nonce rotated on cancel too
    expect((await t.sql<{ d: boolean }>('SELECT e.deleted_at IS NOT NULL AS d FROM appointment a JOIN calendar_event e ON e.id = a.event_id WHERE a.id = $1', [b.id]))[0]!.d).toBe(true);
    const audit = JSON.stringify(await t.sql(`SELECT diff FROM audit_log WHERE entity = 'appointment'`));
    for (const pii of ['Ravi', 'ravi.k', '9876543210', 'Racer', 'race1']) expect(audit).not.toContain(pii);
  });

  it('sends reminders at the configured offsets, once each', async () => {
    const count = () => hub.outbox.filter((m) => m.channel === 'email' && m.text.includes('coming up')).length;
    await jobs.runOnce(100, new Date(ist('2026-10-19T10:00:00')));
    expect(count()).toBe(1);
    await jobs.runOnce(100, new Date(ist('2026-10-20T09:00:00')));
    expect(count()).toBe(2);
    await jobs.runOnce(100, new Date(ist('2026-10-20T09:30:00')));
    expect(count()).toBe(2);
    expect((await t.sql<{ r: string[] }>('SELECT reminders_sent AS r FROM appointment WHERE id = $1', [raceId]))[0]!.r).toHaveLength(2);
  });
});

describe('external calendar sync', () => {
  it('mirrors external events read-only and pushes own meetings (client names masked)', async () => {
    const oauth = t.app.get<Record<string, MockOAuthProvider>>(OAUTH_PROVIDERS).mock!;
    const st = await t.http().post('/v1/comm/connections').set(H(S)).send({ provider: 'mock', purpose: 'calendar' }).expect(201);
    const { id, authUrl } = st.body;
    const state = new URL(authUrl).searchParams.get('state')!;
    await t.http().get(`/v1/comm/oauth/callback?state=${encodeURIComponent(state)}&code=mock:sita@gmail.example`).set('Cookie', String(st.headers['set-cookie']).split(';')[0]!).expect(200);
    oauth.events.set('sita@gmail.example', [{ id: 'g1', etag: 'e1', title: 'Dentist', startsAt: new Date(ist('2026-10-22T17:00:00')), endsAt: new Date(ist('2026-10-22T18:00:00')), allDay: false }]);
    const r = (await t.http().post(`/v1/comm/connections/${id}/sync`).set(H(S)).expect(200)).body;
    expect(r).toMatchObject({ pulled: 1, pushed: 1, conflicts: 0 });
    expect(oauth.pushed.map((p) => p.title)).toEqual(['Busy block']);
    const items = (await t.http().get('/v1/calendar/events?from=2026-10-22&to=2026-10-22').set(H(S))).body as Array<{ title: string; kind: string; editable: boolean }>;
    expect(items.find((i) => i.title === 'Dentist')).toMatchObject({ kind: 'external', editable: false });
    const ext = (await t.sql<{ id: string; version: number }>(`SELECT id, version FROM calendar_event WHERE kind = 'external'`))[0]!;
    const res = (await t.http().post('/v1/sync/push').set(H(S)).send({ mutations: [{ key: `k-${randomUUID()}`, table: 'calendar_event', id: ext.id, baseVersion: ext.version, patch: { title: 'x' } }] })).body.results[0];
    expect(res.reason).toBe('forbidden');
    for (const tok of oauth.issued) expect(JSON.stringify(await t.sql('SELECT diff FROM audit_log'))).not.toContain(tok);
  });
});

describe('booking review fixes', () => {
  it('public bookings never upgrade consent or link a client by themselves; staff confirm the suggestion', async () => {
    const cid = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Booker Ltd', entityType: 'PRIVATE_COMPANY', email: 'boss@booker.in', phone: '+919877700001', staffIds: [S.userId] }).expect(201)).body.id;
    await t.http().post('/v1/comm/consents').set(H(P)).send({ clientId: cid, channel: 'whatsapp', status: 'opted_out', source: 'whatsapp' }).expect(201);
    const b = (await t.http().post('/v1/book/calfirm/meet-sita').send({ startsAt: ist('2026-10-22T10:00:00'), name: '<a href="https://evil.example">Boss</a>', email: 'boss@booker.in', phone: '+919877700001', purpose: 'Audit <script>x</script>', consent: true }).expect(201)).body;
    const cons = await t.sql<{ channel: string; status: string }>(`SELECT channel, status FROM comm_consent WHERE address IN ('boss@booker.in', '+919877700001') ORDER BY channel`);
    expect(cons).toEqual([{ channel: 'email', status: 'pending_verification' }, { channel: 'sms', status: 'pending_verification' }, { channel: 'whatsapp', status: 'opted_out' }]);
    const ap = (await t.sql<{ client_id: string | null; suggested_client_id: string | null }>('SELECT client_id, suggested_client_id FROM appointment WHERE id = $1', [b.id]))[0]!;
    expect(ap).toEqual({ client_id: null, suggested_client_id: cid });
    // Fallback confirmation is plain text: the booker's markup is never sent as HTML.
    const mail = hub.outbox.filter((m) => m.to === 'boss@booker.in').at(-1)!;
    expect(mail.html).toBeNull();
    await t.http().post(`/v1/booking/appointments/${b.id}/link-client`).set(H(S)).send({ clientId: cid }).expect(204);
    expect((await t.sql<{ c: string }>('SELECT e.client_id AS c FROM appointment a JOIN calendar_event e ON e.id = a.event_id WHERE a.id = $1', [b.id]))[0]!.c).toBe(cid);
  });

  it('reschedule respects the page state and horizon and notifies the host', async () => {
    const b = (await t.http().post('/v1/book/calfirm/meet-sita').send({ startsAt: ist('2026-10-23T10:00:00'), name: 'Mover', email: 'mover@example.in', purpose: 'Move me' }).expect(201)).body;
    await t.http().post(`/v1/book/manage/${b.manageToken}/reschedule`).send({ startsAt: ist('2027-03-01T10:00:00') }).expect(409); // beyond horizon
    const r = (await t.http().post(`/v1/book/manage/${b.manageToken}/reschedule`).send({ startsAt: ist('2026-10-23T11:00:00') }).expect(200)).body;
    expect((await t.sql(`SELECT 1 FROM notification WHERE user_id = $1 AND entity_id = $2 AND title LIKE 'Appointment moved%'`, [S.userId, b.id])).length).toBe(1);
    const page = (await t.http().get('/v1/booking/pages').set(H(S))).body.find((p: { slug: string }) => p.slug === 'meet-sita');
    await t.http().patch(`/v1/booking/pages/${page.id}`).set(H(S)).send({ active: false }).expect(200);
    await t.http().post(`/v1/book/manage/${r.manageToken}/reschedule`).send({ startsAt: ist('2026-10-23T12:00:00') }).expect(409);
    await t.http().patch(`/v1/booking/pages/${page.id}`).set(H(S)).send({ active: true }).expect(200);
  });
});
