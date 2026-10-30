import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChannelHub } from '../src/comm/channels.js';
import { Clock } from '../src/common/clock.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let M: Session; let S: Session;
let clientA: string; let clientB: string; let engId: string; let taskId: string;
let procs: Array<{ id: string; key: string }>;
const NOW = new Date('2026-10-29T10:00:00+05:30');
const H = (s: Session) => bearer(s.accessToken);
const upload = (s: Session, clientId: string, name: string, body: string, documentId?: string) => {
  const r = t.http().post('/v1/documents').set(H(s)).field('clientId', clientId);
  if (documentId) r.field('documentId', documentId);
  return r.attach('file', Buffer.from(body), { filename: name, contentType: 'text/plain' }).expect(201).then((x) => x.body as { id: string; version: number });
};

beforeAll(async () => {
  t = await bootApp();
  t.app.get(Clock).set(NOW);
  P = await t.signup('auditfirm');
  M = await t.addUser(P, 'auditfirm', 'Mohan', 'manager');
  S = await t.addUser(P, 'auditfirm', 'Sita', 'senior');
  clientA = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Alpha Industries Pvt Ltd', entityType: 'PRIVATE_COMPANY', managerId: M.userId, staffIds: [S.userId],
    contacts: [{ name: 'Anil CFO', email: 'anil@alpha.example', isPrimary: true }] }).expect(201)).body.id;
  clientB = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Beta Opted Out LLP', entityType: 'LLP', contacts: [{ name: 'Bina', email: 'bina@beta.example', isPrimary: true }] }).expect(201)).body.id;
}, 60_000);
afterAll(() => t?.close());

describe('audit programmes and engagements (M8)', () => {
  it('instantiates the programme into an engagement with a linked task', async () => {
    const prog = (await t.http().post('/v1/audit/programmes').set(H(P)).send({ name: 'Statutory audit — company', auditType: 'statutory', sections: [
      { key: 'planning', title: 'Planning', procedures: [{ key: 'engagement_letter', title: 'Engagement letter (SA 210)', evidence: ['Signed letter'] }, { key: 'materiality', title: 'Materiality', evidence: [] }] },
      { key: 'cash', title: 'Cash and bank', procedures: [{ key: 'bank_conf', title: 'Bank confirmations', evidence: ['Confirmations'] }] },
    ] }).expect(201)).body.id;
    await t.http().post('/v1/audit/programmes').set(H(M)).send({ name: 'x', auditType: 'statutory', sections: [{ key: 'a', title: 'A', procedures: [] }] }).expect(403);
    engId = (await t.http().post('/v1/audit/engagements').set(H(P)).send({ clientId: clientA, fy: '2025-26', auditType: 'statutory', programmeId: prog, partnerId: P.userId, reportDue: '2026-11-30' }).expect(201)).body.id;
    const e = (await t.http().get(`/v1/audit/engagements/${engId}`).set(H(S)).expect(200)).body;
    expect(e.procedures).toHaveLength(3);
    expect(e.progress).toEqual({ total: 3, prepared: 0, reviewed: 0, partner: 0 });
    expect(e.udinPortalUrl).toMatch(/^https:\/\//);
    taskId = e.taskId;
    expect((await t.http().get(`/v1/tasks/${taskId}`).set(H(P)).expect(200)).body).toMatchObject({ clientId: clientA, statutoryDue: '2026-11-30' });
    procs = e.procedures;
    expect((await t.http().post('/v1/audit/engagements').set(H(P)).send({ clientId: clientA, fy: '2025-26', auditType: 'statutory' }).expect(409)).body.code).toBe('engagement_exists');
  });

  it('sign-off order, rights and self-review are enforced; reopen leaves a trail', async () => {
    const [p1, p2] = procs;
    expect((await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(M)).send({ level: 'reviewer' }).expect(400)).body.code).toBe('preparer_signoff_required');
    await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(S)).send({ level: 'preparer' }).expect(204);
    expect((await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(S)).send({ level: 'preparer' }).expect(400)).body.code).toBe('already_signed');
    expect((await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(S)).send({ level: 'reviewer' }).expect(403)).body.code).toBe('forbidden');
    expect((await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(P)).send({ level: 'partner' }).expect(400)).body.code).toBe('reviewer_signoff_required');
    await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(M)).send({ level: 'reviewer' }).expect(204);
    expect((await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(M)).send({ level: 'partner' }).expect(403)).body.code).toBe('forbidden');
    await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(P)).send({ level: 'partner' }).expect(204);
    // Self-review refused.
    await t.http().post(`/v1/audit/procedures/${p2!.id}/signoff`).set(H(M)).send({ level: 'preparer' }).expect(204);
    expect((await t.http().post(`/v1/audit/procedures/${p2!.id}/signoff`).set(H(M)).send({ level: 'reviewer' }).expect(400)).body.code).toBe('self_review');
    // Reviewed procedures are locked for edits.
    expect((await t.http().patch(`/v1/audit/procedures/${p1!.id}`).set(H(S)).send({ conclusion: 'ok' }).expect(409)).body.code).toBe('procedure_locked');
    // Reopen: partner only, with reason; trail is append-only.
    await t.http().post(`/v1/audit/procedures/${p1!.id}/reopen`).set(H(M)).send({ reason: 'x' }).expect(403);
    await t.http().post(`/v1/audit/procedures/${p1!.id}/reopen`).set(H(P)).send({ reason: 'Subsequent event found' }).expect(204);
    const trail = (await t.http().get(`/v1/audit/procedures/${p1!.id}/trail`).set(H(S)).expect(200)).body as Array<{ level: string; action: string; reason: string | null }>;
    expect(trail.map((x) => `${x.action}:${x.level}`)).toEqual(['signed:preparer', 'signed:reviewer', 'signed:partner', 'reopened:preparer', 'reopened:reviewer', 'reopened:partner']);
    expect(trail[5]!.reason).toBe('Subsequent event found');
    // The app role cannot rewrite the trail.
    await expect(t.sql(`SET ROLE worko_app; UPDATE audit_signoff_event SET reason = 'x'`)).rejects.toThrow();
  });

  it('evidence changes invalidate sign-offs; a newer document version must be refreshed before signing', async () => {
    const [p1] = procs;
    await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(S)).send({ level: 'preparer' }).expect(204);
    const doc = await upload(S, clientA, 'engagement-letter.txt', 'Engagement letter v1');
    const w = (await t.http().post(`/v1/audit/procedures/${p1!.id}/workpapers`).set(H(S)).send({ documentId: doc.id }).expect(201)).body;
    expect(w).toMatchObject({ documentVersion: 1, invalidated: ['preparer'] });
    await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(S)).send({ level: 'preparer' }).expect(204);
    await upload(S, clientA, 'engagement-letter.txt', 'Engagement letter v2', doc.id);
    expect((await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(M)).send({ level: 'reviewer' }).expect(409)).body.code).toBe('evidence_changed');
    expect((await t.http().post(`/v1/audit/procedures/${p1!.id}/workpapers`).set(H(S)).send({ documentId: doc.id }).expect(201)).body).toMatchObject({ documentVersion: 2, invalidated: ['preparer'] });
    const wps = (await t.http().get(`/v1/audit/procedures/${p1!.id}/workpapers`).set(H(S)).expect(200)).body;
    expect(wps).toEqual([expect.objectContaining({ documentId: doc.id, documentVersion: 2, currentVersion: 2 })]);
    const other = await upload(P, clientB, 'b.txt', 'other client');
    expect((await t.http().post(`/v1/audit/procedures/${p1!.id}/workpapers`).set(H(P)).send({ documentId: other.id }).expect(400)).body.code).toBe('invalid:documentId');
  });

  it('PBC list: statuses and reminders through comm respecting consent', async () => {
    const hub = t.app.get(MockChannelHub);
    const ids = (await t.http().post(`/v1/audit/engagements/${engId}/pbc`).set(H(S)).send({ items: [{ title: 'Bank statements FY 2025-26', dueDate: '2026-10-25' }, { title: 'Fixed asset register', dueDate: '2026-10-28' }, { title: 'Later item', dueDate: '2026-12-31' }] }).expect(201)).body.ids;
    expect((await t.http().patch(`/v1/audit/pbc/${ids[0]}`).set(H(S)).send({ status: 'accepted' }).expect(400)).body.code).toBe('invalid_transition');
    expect((await t.http().patch(`/v1/audit/pbc/${ids[1]}`).set(H(S)).send({ status: 'rejected' }).expect(400)).body.code).toBe('reason_required');
    const before = hub.outbox.length;
    const r = (await t.http().post(`/v1/audit/engagements/${engId}/pbc/remind`).set(H(S)).expect(201)).body;
    expect(r).toEqual({ sent: 1, skipped: [] });
    const msg = hub.outbox[before]!;
    expect(msg).toMatchObject({ channel: 'email', to: 'anil@alpha.example' });
    expect(msg.text).toContain('Bank statements'); expect(msg.text).toContain('Fixed asset register'); expect(msg.text).not.toContain('Later item');
    // Same day again: interval not reached → nothing sent.
    expect((await t.http().post(`/v1/audit/engagements/${engId}/pbc/remind`).set(H(S)).expect(201)).body.sent).toBe(0);
    // Opted-out client gets nothing.
    await t.http().post('/v1/comm/consents').set(H(P)).send({ clientId: clientB, channel: 'email', address: 'bina@beta.example', status: 'opted_out', source: 'email' }).expect(201);
    const engB = (await t.http().post('/v1/audit/engagements').set(H(P)).send({ clientId: clientB, fy: '2025-26', auditType: 'tax_audit_44ab', createTask: false }).expect(201)).body.id;
    await t.http().post(`/v1/audit/engagements/${engB}/pbc`).set(H(P)).send({ items: [{ title: 'Form 3CD data', dueDate: '2026-10-20' }] }).expect(201);
    expect((await t.http().post(`/v1/audit/engagements/${engB}/pbc/remind`).set(H(P)).expect(201)).body).toEqual({ sent: 0, skipped: [{ engagementId: engB, reason: 'opted_out' }] });
    await t.http().patch(`/v1/audit/pbc/${ids[0]}`).set(H(S)).send({ status: 'received' }).expect(204);
    await t.http().patch(`/v1/audit/pbc/${ids[0]}`).set(H(S)).send({ status: 'accepted' }).expect(204);
  });

  it('UDIN: format, membership match, uniqueness and the task close gate (REST + sync)', async () => {
    expect((await t.http().patch(`/v1/tasks/${taskId}`).set(H(P)).send({ status: 'done' }).expect(400)).body.code).toBe('udin_required');
    const push = (await t.http().post('/v1/sync/push').set(H(P)).send({ mutations: [{ key: `k-${Date.now()}`, table: 'task', id: taskId, baseVersion: 1, patch: { status: 'done' } }] }).expect(200)).body.results[0];
    expect(push).toMatchObject({ status: 'rejected', reason: 'udin_required' });
    // Even if the task were done already, closing as billed is refused.
    await t.sql(`UPDATE task SET status = 'done' WHERE id = $1`, [taskId]);
    expect((await t.http().post(`/v1/tasks/${taskId}/close`).set(H(P)).send({ outcome: 'billed' }).expect(400)).body.code).toBe('udin_required');
    expect((await t.http().patch(`/v1/audit/engagements/${engId}`).set(H(P)).send({ status: 'closed' }).expect(400)).body.code).toBe('invalid_transition');
    const base = { clientId: clientA, engagementId: engId, documentType: 'Statutory audit report', generatedOn: '2026-10-28', membershipNo: '123456' };
    await t.http().post('/v1/audit/udins').set(H(P)).send({ ...base, udin: '26123456ABC' }).expect(400);
    expect((await t.http().post('/v1/audit/udins').set(H(P)).send({ ...base, udin: '26654321ABCDEFGH12' }).expect(400)).body.code).toBe('membership_mismatch');
    expect((await t.http().post('/v1/audit/udins').set(H(P)).send({ ...base, udin: '26123456ABCDEFGH12', generatedOn: '2026-10-30' }).expect(400)).body.code).toBe('future_date');
    await t.http().post('/v1/audit/udins').set(H(P)).send({ ...base, udin: '26123456abcdefgh12' }).expect(201);
    expect((await t.http().post('/v1/audit/udins').set(H(P)).send({ ...base, clientId: clientB, engagementId: null, udin: '26123456ABCDEFGH12' }).expect(409)).body.code).toBe('udin_duplicate');
    expect((await t.http().get(`/v1/audit/udins?engagementId=${engId}`).set(H(S)).expect(200)).body[0].udin).toBe('26123456ABCDEFGH12');
    await t.http().post(`/v1/tasks/${taskId}/close`).set(H(P)).send({ outcome: 'billed' }).expect(204);
    await t.http().patch(`/v1/audit/engagements/${engId}`).set(H(P)).send({ status: 'fieldwork' }).expect(204);
    await t.http().patch(`/v1/audit/engagements/${engId}`).set(H(P)).send({ status: 'review' }).expect(204);
    expect((await t.http().patch(`/v1/audit/engagements/${engId}`).set(H(P)).send({ status: 'closed' }).expect(400)).body.code).toBe('signoffs_pending');
    expect((await t.http().get('/v1/audit/udin-portal').set(H(S)).expect(200)).body.url).toMatch(/icai/);
  });

  it('visibility: invisible engagements and UDINs answer 404 / are filtered', async () => {
    const engB = (await t.http().get(`/v1/audit/engagements?clientId=${clientB}`).set(H(P)).expect(200)).body.items[0].id;
    await t.http().get(`/v1/audit/engagements/${engB}`).set(H(S)).expect(404);
    expect((await t.http().get('/v1/audit/engagements').set(H(S)).expect(200)).body.items.map((e: { clientId: string }) => e.clientId)).toEqual([clientA]);
    await t.http().post(`/v1/audit/engagements/${engB}/pbc`).set(H(S)).send({ items: [{ title: 'x' }] }).expect(404);
    await t.http().post('/v1/audit/udins').set(H(S)).send({ clientId: clientB, udin: '26123456ZZZZZZZZ12', documentType: 'x', generatedOn: '2026-10-28', membershipNo: '123456' }).expect(404);
  });
});
