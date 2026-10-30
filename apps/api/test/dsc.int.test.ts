import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let A: Session; let S: Session;
let clientA: string; let clientB: string; let contactA: string;
const NOW = new Date('2026-10-29T10:00:00+05:30');
const H = (s: Session) => bearer(s.accessToken);
const base = { holderKind: 'client_contact', dscClass: 'Class 3', dscType: 'sign', issuer: 'eMudhra', validFrom: '2024-12-28' };

beforeAll(async () => {
  t = await bootApp();
  t.app.get(Clock).set(NOW);
  P = await t.signup('dscfirm');
  A = await t.addUser(P, 'dscfirm', 'Asha', 'admin');
  S = await t.addUser(P, 'dscfirm', 'Sita', 'senior');
  const c = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Gamma Exports', entityType: 'PRIVATE_COMPANY', managerId: P.userId, staffIds: [S.userId], contacts: [{ name: 'Gita Director', isPrimary: true }] }).expect(201)).body;
  clientA = c.id;
  contactA = (await t.sql<{ id: string }>('SELECT id FROM contact WHERE client_id = $1', [clientA]))[0]!.id;
  clientB = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Delta Hidden', entityType: 'PRIVATE_COMPANY' }).expect(201)).body.id;
}, 60_000);
afterAll(() => t?.close());

describe('DSC register (M12)', () => {
  it('stores metadata only: no PIN/password column, and such fields are refused', async () => {
    const cols = (await t.sql<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('dsc','dsc_custody')`)).map((r) => r.column_name);
    expect(cols.filter((c) => /pin|pass|secret|otp/i.test(c))).toEqual([]);
    for (const k of ['pin', 'tokenPin', 'password', 'tokenPassword']) {
      const r = (await t.http().post('/v1/dsc').set(H(P)).send({ ...base, clientId: clientA, contactId: contactA, validTo: '2026-12-28', [k]: '1234' }).expect(400)).body;
      expect(JSON.stringify(r.issues)).toContain('secret_not_allowed');
    }
    const id = (await t.http().post('/v1/dsc').set(H(P)).send({ ...base, clientId: clientA, contactId: contactA, validTo: '2026-12-28', serialNo: 'SER-60' }).expect(201)).body.id;
    expect((await t.http().patch(`/v1/dsc/${id}`).set(H(P)).send({ pin: '0000' }).expect(400)).body.issues).toBeTruthy();
    const d = (await t.http().get(`/v1/dsc/${id}`).set(H(P)).expect(200)).body;
    expect(d).toMatchObject({ holderName: 'Gita Director', daysLeft: 60, custody: 'in_office' });
    expect(Object.keys(d).some((k) => /pin|pass/i.test(k))).toBe(false);
    expect((await t.http().post('/v1/dsc').set(H(P)).send({ ...base, clientId: clientA, contactId: contactA, validTo: '2026-12-28', serialNo: 'SER-60' }).expect(409)).body.code).toBe('dsc_duplicate');
  });

  it('expiry alerts fire once per DSC × threshold; renewal task created once', async () => {
    const mk = (validTo: string, serialNo: string, extra: Record<string, unknown> = {}) => t.http().post('/v1/dsc').set(H(P)).send({ ...base, clientId: clientA, holderName: `Holder ${serialNo}`, validTo, serialNo, ...extra }).expect(201).then((r) => r.body.id as string);
    const d30 = await mk('2026-11-28', 'SER-30');
    const d7 = await mk('2026-11-05', 'SER-7');
    const dExp = await mk('2026-10-20', 'SER-EXP');
    const staff = (await t.http().post('/v1/dsc').set(H(A)).send({ ...base, holderKind: 'staff', holderUserId: S.userId, validTo: '2027-06-30', custody: 'with_staff', custodyUserId: S.userId }).expect(201)).body.id;
    const r1 = (await t.http().post('/v1/practice/run').set(H(P)).send({ asOf: '2026-10-29' }).expect(201)).body;
    expect(r1.expiryAlerts).toBe(4); // 60, 30, 7, expired(0)
    const r2 = (await t.http().post('/v1/practice/run').set(H(P)).send({ asOf: '2026-10-29' }).expect(201)).body;
    expect(r2).toMatchObject({ expiryAlerts: 0, renewalTasks: 0 });
    const rows = await t.sql<{ id: string; alerts_sent: number[]; renewal_task_id: string | null }>('SELECT id, alerts_sent, renewal_task_id FROM dsc WHERE id = ANY($1::uuid[])', [[d30, d7, dExp, staff]]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[d30]!.alerts_sent).toEqual([30]); expect(by[d7]!.alerts_sent).toEqual([7]); expect(by[dExp]!.alerts_sent).toEqual([0]); expect(by[staff]!.alerts_sent).toEqual([]);
    expect(by[d30]!.renewal_task_id).toBeTruthy(); expect(by[d7]!.renewal_task_id).toBeTruthy(); expect(by[staff]!.renewal_task_id).toBeNull();
    const task = (await t.http().get(`/v1/tasks/${by[d7]!.renewal_task_id}`).set(H(P)).expect(200)).body;
    expect(task).toMatchObject({ clientId: clientA, statutoryDue: '2026-11-05', priority: 'urgent' });
    // Two days later the 7-day DSC crosses no new threshold; at 0 days it alerts again (once).
    expect((await t.http().post('/v1/practice/run').set(H(P)).send({ asOf: '2026-10-31' }).expect(201)).body.expiryAlerts).toBe(0);
    expect((await t.http().post('/v1/practice/run').set(H(P)).send({ asOf: '2026-11-05' }).expect(201)).body.expiryAlerts).toBeGreaterThan(0);
    expect((await t.sql<{ alerts_sent: number[] }>('SELECT alerts_sent FROM dsc WHERE id = $1', [d7]))[0]!.alerts_sent).toEqual([7, 0]);
    const notes = await t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM notification WHERE category = 'dsc.expiring' AND entity_id = $1`, [d7]);
    expect(notes[0]!.n).toBe(2);
    // Renewal: a new validity restarts the cycle.
    await t.http().patch(`/v1/dsc/${d7}`).set(H(P)).send({ validFrom: '2026-11-05', validTo: '2028-11-04' }).expect(204);
    expect((await t.sql<{ alerts_sent: number[]; renewal_task_id: string | null }>('SELECT alerts_sent, renewal_task_id FROM dsc WHERE id = $1', [d7]))[0]).toEqual({ alerts_sent: [], renewal_task_id: null });
  });

  it('custody movements log with acknowledgement', async () => {
    const id = (await t.http().post('/v1/dsc').set(H(P)).send({ ...base, clientId: clientA, holderName: 'Token X', validTo: '2027-10-01' }).expect(201)).body.id;
    const m1 = (await t.http().post(`/v1/dsc/${id}/custody`).set(H(P)).send({ to: 'with_staff', toUserId: S.userId, purpose: 'GST filing' }).expect(201)).body.id;
    await t.http().post(`/v1/dsc/${id}/custody`).set(H(P)).send({ to: 'with_staff' }).expect(400);
    await t.http().post(`/v1/dsc/custody/${m1}/acknowledge`).set(H(P)).send({}).expect(403);
    await t.http().post(`/v1/dsc/custody/${m1}/acknowledge`).set(H(S)).send({}).expect(204);
    await t.http().post(`/v1/dsc/custody/${m1}/acknowledge`).set(H(S)).send({}).expect(409);
    const m2 = (await t.http().post(`/v1/dsc/${id}/custody`).set(H(P)).send({ to: 'with_client', counterparty: 'Gita Director' }).expect(201)).body.id;
    expect((await t.http().post(`/v1/dsc/custody/${m2}/acknowledge`).set(H(P)).send({}).expect(400)).body.code).toBe('invalid:name');
    await t.http().post(`/v1/dsc/custody/${m2}/acknowledge`).set(H(P)).send({ name: 'Gita Director' }).expect(204);
    const d = (await t.http().get(`/v1/dsc/${id}`).set(H(P)).expect(200)).body;
    expect(d.custody).toBe('with_client');
    expect(d.custodyLog.map((m: { fromCustody: string; toCustody: string; acknowledgedAt: string | null }) => `${m.fromCustody}>${m.toCustody}:${!!m.acknowledgedAt}`))
      .toEqual(['new>in_office:false', 'in_office>with_staff:true', 'with_staff>with_client:true']);
  });

  it('visibility: client-scoped register, staff DSCs firm-wide or own; read-only sync', async () => {
    const hidden = (await t.http().post('/v1/dsc').set(H(P)).send({ ...base, clientId: clientB, holderName: 'Hidden', validTo: '2027-01-01' }).expect(201)).body.id;
    await t.http().get(`/v1/dsc/${hidden}`).set(H(S)).expect(404);
    const mine = (await t.http().get('/v1/dsc').set(H(S)).expect(200)).body as Array<{ id: string; clientId: string | null }>;
    expect(mine.some((d) => d.id === hidden)).toBe(false);
    expect(mine.some((d) => d.clientId === null)).toBe(true); // own staff DSC
    await t.http().post('/v1/dsc').set(H(S)).send({ ...base, holderKind: 'staff', holderUserId: S.userId, validTo: '2027-01-01' }).expect(403);
    const pulled = (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(S)).expect(200)).body.changes as Array<{ table: string; id: string; fields: Record<string, unknown> }>;
    const dscRows = pulled.filter((c) => c.table === 'dsc');
    expect(dscRows.some((c) => c.id === hidden)).toBe(false);
    expect(dscRows.length).toBeGreaterThan(0);
    expect(Object.keys(dscRows[0]!.fields).some((k) => /pin|pass/i.test(k))).toBe(false);
    const res = (await t.http().post('/v1/sync/push').set(H(S)).send({ mutations: [{ key: `k-${Date.now()}`, table: 'dsc', id: dscRows[0]!.id, baseVersion: 1, patch: { custody: 'with_client' } }] }).expect(200)).body.results[0];
    expect(res.status).toBe('rejected');
  });
});

describe('licences (M12)', () => {
  it('tracks licences per client with renewal alerts and tasks like DSC', async () => {
    const l1 = (await t.http().post('/v1/licences').set(H(P)).send({ clientId: clientA, licenceType: 'fssai', number: '11526999000123', authority: 'FSSAI', validFrom: '2021-11-20', validTo: '2026-11-19' }).expect(201)).body.id;
    const l2 = (await t.http().post('/v1/licences').set(H(P)).send({ clientId: clientA, licenceType: 'trade_licence', validTo: '2027-03-31', renewalDue: '2027-03-01' }).expect(201)).body.id;
    await t.http().post('/v1/licences').set(H(P)).send({ clientId: clientA, licenceType: 'Bad Type', validTo: '2027-03-31' }).expect(400);
    const r = (await t.http().post('/v1/practice/run').set(H(P)).send({ asOf: '2026-10-29' }).expect(201)).body;
    expect(r.renewalTasks).toBeGreaterThanOrEqual(1);
    const rows = await t.sql<{ id: string; alerts_sent: number[]; renewal_task_id: string | null }>('SELECT id, alerts_sent, renewal_task_id FROM licence ORDER BY created_at');
    expect(rows.find((x) => x.id === l1)).toMatchObject({ alerts_sent: [30] });
    expect(rows.find((x) => x.id === l1)!.renewal_task_id).toBeTruthy();
    expect(rows.find((x) => x.id === l2)).toMatchObject({ alerts_sent: [], renewal_task_id: null });
    expect((await t.http().post('/v1/practice/run').set(H(P)).send({ asOf: '2026-10-29' }).expect(201)).body.renewalTasks).toBe(0);
    const due = (await t.http().get('/v1/licences?dueWithinDays=60').set(H(S)).expect(200)).body;
    expect(due.map((x: { id: string }) => x.id)).toEqual([l1]);
    const lb = (await t.http().post('/v1/licences').set(H(P)).send({ clientId: clientB, licenceType: 'iec', validTo: '2030-01-01' }).expect(201)).body.id;
    await t.http().patch(`/v1/licences/${lb}`).set(H(S)).send({ notes: 'x' }).expect(404);
    await t.http().patch(`/v1/licences/${l1}`).set(H(P)).send({ validTo: '2031-11-19', status: 'active' }).expect(204);
    expect((await t.sql<{ alerts_sent: number[] }>('SELECT alerts_sent FROM licence WHERE id = $1', [l1]))[0]!.alerts_sent).toEqual([]);
  });
});
