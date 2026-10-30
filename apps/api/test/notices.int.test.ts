import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let M: Session; let S: Session;
let clientA: string; let clientB: string;
const NOW = new Date('2026-10-29T10:00:00+05:30');
const H = (s: Session) => bearer(s.accessToken);
const pull = async (s: Session) => (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(s)).expect(200)).body.changes as Array<{ table: string; id: string; fields: Record<string, unknown> }>;

beforeAll(async () => {
  t = await bootApp();
  t.app.get(Clock).set(NOW);
  P = await t.signup('noticefirm');
  M = await t.addUser(P, 'noticefirm', 'Meera', 'manager');
  S = await t.addUser(P, 'noticefirm', 'Sita', 'senior');
  await t.sql('UPDATE app_user SET manager_id = $1 WHERE id = $2', [M.userId, S.userId]);
  clientA = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Alpha Traders', entityType: 'PROPRIETORSHIP', staffIds: [S.userId] }).expect(201)).body.id;
  clientB = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Beta Hidden Pvt Ltd', entityType: 'PRIVATE_COMPANY' }).expect(201)).body.id;
}, 60_000);
afterAll(() => t?.close());

describe('notices (M7)', () => {
  let noticeId: string;
  it('creates a notice with a linked reply task due = response due − buffer', async () => {
    noticeId = (await t.http().post('/v1/notices').set(H(P)).send({ clientId: clientA, authority: 'income_tax', section: '143(2)', title: 'Scrutiny AY 2025-26',
      issueDate: '2026-10-15', responseDue: '2026-11-20', assessmentYear: '2025-26', demandPaise: 12_500_000, assigneeId: S.userId }).expect(201)).body.id;
    const n = (await t.http().get(`/v1/notices/${noticeId}`).set(H(P)).expect(200)).body;
    expect(n).toMatchObject({ status: 'received', level: 'assessing_officer', receivedOn: '2026-10-29', demandPaise: 12_500_000 });
    const task = (await t.http().get(`/v1/tasks/${n.taskId}`).set(H(P)).expect(200)).body;
    expect(task).toMatchObject({ statutoryDue: '2026-11-20', actBy: '2026-11-13', assigneeId: S.userId, source: 'auto', clientId: clientA });
    expect((await t.http().post('/v1/notices').set(H(P)).send({ clientId: clientA, authority: 'gst', level: 'itat', title: 'x' }).expect(400)).body.code).toBe('invalid:level');
    expect((await t.http().post('/v1/notices').set(H(P)).send({ clientId: clientA, authority: 'gst', title: 'x', issueDate: '2026-10-10', responseDue: '2026-10-01' }).expect(400)).body.code).toBe('due_before_issue');
  });

  it('status workflow: invalid transitions 400, closing needs an outcome', async () => {
    expect((await t.http().post(`/v1/notices/${noticeId}/status`).set(H(P)).send({ status: 'hearing' }).expect(400)).body.code).toBe('invalid_transition');
    await t.http().post(`/v1/notices/${noticeId}/status`).set(H(S)).send({ status: 'under_review' }).expect(204);
    await t.http().post(`/v1/notices/${noticeId}/status`).set(H(S)).send({ status: 'drafting' }).expect(204);
    expect((await t.http().post(`/v1/notices/${noticeId}/status`).set(H(S)).send({ status: 'closed' }).expect(400)).body.code).toBe('outcome_required');
    expect((await t.http().post(`/v1/notices/${noticeId}/status`).set(H(S)).send({ status: 'submitted', outcome: 'dropped' }).expect(400)).body.code).toBe('outcome_only_on_close');
    await t.http().post(`/v1/notices/${noticeId}/status`).set(H(S)).send({ status: 'submitted' }).expect(204);
    const audit = await t.sql<{ action: string }>(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY seq`, [noticeId]);
    expect(audit.map((x) => x.action).filter((x) => x === 'notice.status')).toHaveLength(3);
  });

  it('extraction suggestions are not applied until the user confirms chosen fields', async () => {
    const text = 'GOODS AND SERVICES TAX\nGSTIN: 27AAACA1234A1Z5\nShow cause notice u/s 73 in FORM DRC-01\nReference No: ZD2710260012345\nDated: 20/10/2026\nFinancial Year: 2022-23\nReply on or before 25/11/2026\nTax payable Rs. 2,40,000';
    const ex = (await t.http().post('/v1/notices/extract').set(H(S)).field('clientId', clientA).attach('file', Buffer.from(text), { filename: 'drc01.txt', contentType: 'text/plain' }).expect(201)).body;
    expect(ex.status).toBe('pending');
    const m = Object.fromEntries((ex.suggestions as Array<{ field: string; value: unknown }>).map((s) => [s.field, s.value]));
    expect(m).toMatchObject({ authority: 'gst', section: '73', issueDate: '2026-10-20', responseDue: '2026-11-25', financialYear: '2022-23', demandPaise: 24_000_000 });
    // Nothing created yet.
    expect((await t.http().get(`/v1/notices?clientId=${clientA}`).set(H(P)).expect(200)).body.total).toBe(1);
    expect((await t.http().post(`/v1/notices/extractions/${ex.id}/confirm`).set(H(S)).send({ fields: { pan: 'X' } }).expect(400)).body.code).toBe('invalid:fields');
    // Confirm only some fields, correcting one; demand is NOT confirmed so stays 0.
    const r = (await t.http().post(`/v1/notices/extractions/${ex.id}/confirm`).set(H(S)).send({ fields: { authority: 'gst', section: '73', responseDue: '2026-11-24' }, title: 'DRC-01 FY 2022-23' }).expect(201)).body;
    const n = (await t.http().get(`/v1/notices/${r.noticeId}`).set(H(S)).expect(200)).body;
    expect(n).toMatchObject({ authority: 'gst', section: '73', responseDue: '2026-11-24', demandPaise: 0, issueDate: null, financialYear: null });
    expect(n.documents).toEqual([expect.objectContaining({ documentId: ex.documentId, kind: 'notice' })]);
    expect((await t.http().post(`/v1/notices/extractions/${ex.id}/confirm`).set(H(S)).send({ fields: {} }).expect(409)).body.code).toBe('extraction_decided');
    // Extraction against an existing notice leaves it untouched until confirmed.
    const ex2 = (await t.http().post('/v1/notices/extract').set(H(S)).field('clientId', clientA).field('noticeId', noticeId).attach('file', Buffer.from('Demand of Rs. 99,999 u/s 156'), { filename: 'order.txt', contentType: 'text/plain' }).expect(201)).body;
    expect((await t.http().get(`/v1/notices/${noticeId}`).set(H(S))).body.demandPaise).toBe(12_500_000);
    await t.http().post(`/v1/notices/extractions/${ex2.id}/discard`).set(H(S)).expect(204);
    expect((await t.http().get(`/v1/notices/${noticeId}`).set(H(S))).body.demandPaise).toBe(12_500_000);
    const diff = (await t.sql<{ diff: Record<string, unknown> }>(`SELECT diff FROM audit_log WHERE action = 'notice.extracted' ORDER BY seq LIMIT 1`))[0]!.diff;
    expect(JSON.stringify(diff)).not.toContain('27AAACA1234A1Z5');
  });

  it('hearing creates a calendar event + reminder; adjournment keeps history', async () => {
    const h = (await t.http().post(`/v1/notices/${noticeId}/hearings`).set(H(S)).send({ startsAt: '2026-10-30T11:00:00+05:30', venue: 'Ward 3(1), Aayakar Bhavan' }).expect(201)).body.id;
    const [row] = await t.sql<{ calendar_event_id: string; owner_id: string }>('SELECT calendar_event_id, owner_id FROM notice_hearing WHERE id = $1', [h]);
    const [ev] = await t.sql<{ kind: string; owner_id: string; client_id: string; starts_at: Date }>('SELECT kind, owner_id, client_id, starts_at FROM calendar_event WHERE id = $1', [row!.calendar_event_id]);
    expect(ev).toMatchObject({ kind: 'hearing', owner_id: S.userId, client_id: clientA });
    const rem = await t.sql<{ fire_at: Date; category: string }>(`SELECT fire_at, category FROM notification WHERE entity_id = $1`, [h]);
    expect(rem).toEqual([{ category: 'notice.hearing', fire_at: new Date('2026-10-29T11:00:00+05:30') }]);
    expect((await t.http().get(`/v1/notices/${noticeId}`).set(H(S))).body.status).toBe('hearing');
    const items = (await t.http().get('/v1/calendar/events?from=2026-10-29&to=2026-11-30').set(H(S)).expect(200)).body as Array<{ kind: string }>;
    expect(items.some((i) => i.kind === 'hearing')).toBe(true);
    const h2 = (await t.http().post(`/v1/notices/hearings/${h}/adjourn`).set(H(S)).send({ startsAt: '2026-11-10T11:00:00+05:30', reason: 'AO on leave' }).expect(201)).body.id;
    const both = await t.sql<{ id: string; status: string; adjourned_from: string | null }>('SELECT id, status, adjourned_from FROM notice_hearing WHERE notice_id = $1 ORDER BY created_at', [noticeId]);
    expect(both).toEqual([{ id: h, status: 'adjourned', adjourned_from: null }, { id: h2, status: 'scheduled', adjourned_from: h }]);
    expect((await t.sql<{ deleted_at: Date | null }>('SELECT deleted_at FROM calendar_event WHERE id = $1', [row!.calendar_event_id]))[0]!.deleted_at).not.toBeNull();
    await t.http().post(`/v1/notices/hearings/${h}/adjourn`).set(H(S)).send({ startsAt: '2026-11-12T11:00:00+05:30' }).expect(409);
  });

  it('escalation: overdue reply and unprepared hearing notify the assignee once (idempotent) with manager escalation', async () => {
    const overdue = (await t.http().post('/v1/notices').set(H(P)).send({ clientId: clientA, authority: 'tds', title: 'Short deduction 24Q', issueDate: '2026-09-01', responseDue: '2026-10-20', assigneeId: S.userId }).expect(201)).body.id;
    const near = (await t.http().post('/v1/notices').set(H(P)).send({ clientId: clientA, authority: 'roc', title: 'ROC adjudication', responseDue: '2026-12-31', assigneeId: S.userId }).expect(201)).body.id;
    await t.http().post(`/v1/notices/${near}/status`).set(H(P)).send({ status: 'under_review' }).expect(204);
    await t.http().post(`/v1/notices/${near}/status`).set(H(P)).send({ status: 'submitted' }).expect(204);
    await t.http().post(`/v1/notices/${near}/hearings`).set(H(P)).send({ startsAt: '2026-10-31T15:00:00+05:30', virtualLink: 'https://vc.example.in/room/1' }).expect(201);
    const r1 = (await t.http().post('/v1/practice/run').set(H(P)).send({ asOf: '2026-10-29' }).expect(201)).body;
    expect(r1.escalations).toBe(2);
    const r2 = (await t.http().post('/v1/practice/run').set(H(P)).send({ asOf: '2026-10-29' }).expect(201)).body;
    expect(r2.escalations).toBe(0);
    const ns = await t.sql<{ category: string; requires_ack: boolean; user_id: string }>(`SELECT category, requires_ack, user_id FROM notification WHERE dedupe_key LIKE 'notice-overdue:%' OR dedupe_key LIKE 'hearing-prep:%' ORDER BY category`);
    expect(ns).toEqual([{ category: 'notice.hearing', requires_ack: true, user_id: S.userId }, { category: 'notice.response_due', requires_ack: true, user_id: S.userId }]);
    expect((await t.sql(`SELECT 1 FROM job_queue WHERE kind = 'notification.escalate'`)).length).toBe(2);
    expect((await t.http().get('/v1/notices?overdue=true').set(H(P)).expect(200)).body.items.map((x: { id: string }) => x.id)).toEqual([overdue]);
  });

  it('ageing by bucket and authority/level with demand totals', async () => {
    await t.sql(`UPDATE notice SET received_on = '2026-07-01' WHERE title = 'Short deduction 24Q'`);
    const a = (await t.http().get('/v1/notices/reports/ageing?asOf=2026-10-29').set(H(P)).expect(200)).body;
    expect(a.open).toBe(4);
    expect(a.overdue).toBe(1);
    expect(a.demandPaise).toBe(12_500_000);
    expect(a.buckets.find((b: { bucket: string }) => b.bucket === '91-180').count).toBe(1);
    expect(a.byAuthority.find((g: { authority: string }) => g.authority === 'income_tax')).toMatchObject({ level: 'assessing_officer', count: 1, demandPaise: 12_500_000 });
  });

  it('visibility: invisible client notices answer 404, are excluded from lists/reports and sync; devices cannot write notices', async () => {
    const hidden = (await t.http().post('/v1/notices').set(H(P)).send({ clientId: clientB, authority: 'gst', title: 'Hidden GST notice', responseDue: '2026-11-30' }).expect(201)).body.id;
    await t.http().get(`/v1/notices/${hidden}`).set(H(S)).expect(404);
    await t.http().post(`/v1/notices/${hidden}/status`).set(H(S)).send({ status: 'under_review' }).expect(404);
    await t.http().post('/v1/notices').set(H(S)).send({ clientId: clientB, authority: 'gst', title: 'x' }).expect(404);
    expect((await t.http().get('/v1/notices?limit=500').set(H(S)).expect(200)).body.items.some((n: { id: string }) => n.id === hidden)).toBe(false);
    expect((await t.http().get('/v1/notices/reports/ageing?asOf=2026-10-29').set(H(S)).expect(200)).body.open).toBe(4);
    const sp = await pull(S);
    expect(sp.some((c) => c.table === 'notice' && c.id === hidden)).toBe(false);
    expect(sp.some((c) => c.table === 'notice' && c.id === noticeId)).toBe(true);
    expect(sp.some((c) => c.table === 'notice_hearing')).toBe(true);
    const res = (await t.http().post('/v1/sync/push').set(H(S)).send({ mutations: [{ key: `k-${randomUUID()}`, table: 'notice', id: noticeId, baseVersion: 1, patch: { status: 'closed' } }] }).expect(200)).body.results;
    expect(res[0].status).toBe('rejected');
    // Revoking access sends a tombstone (revocation) for the notice.
    await t.http().put(`/v1/clients/${clientA}/access`).set(H(P)).send({ staffIds: [] }).expect(204);
    await t.http().get(`/v1/notices/${noticeId}`).set(H(S)).expect(404);
  });
});
