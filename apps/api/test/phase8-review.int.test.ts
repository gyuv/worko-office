import PDFDocument from 'pdfkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock.js';
import { DEV_ESIGN_WEBHOOK_SECRET, esignHmac, ESIGN_PROVIDERS, type MockEsignProvider } from '../src/practice/esign.provider.js';
import { bearer, bootApp, type Session } from './helpers.js';

/** Regression tests for the Phase 8 review findings (fix numbers in test names). */
let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let M: Session; let S: Session;
let clientA: string; let contactA: string;
const NOW = new Date('2026-10-29T10:00:00+05:30');
const H = (s: Session) => bearer(s.accessToken);
const engagement = async (fy: string, extra: Record<string, unknown> = {}) => {
  const id = (await t.http().post('/v1/audit/engagements').set(H(P)).send({ clientId: clientA, fy, auditType: 'statutory', partnerId: P.userId, ...extra }).expect(201)).body.id as string;
  return (await t.http().get(`/v1/audit/engagements/${id}`).set(H(P)).expect(200)).body as { id: string; taskId: string; procedures: Array<{ id: string }> };
};
const programme = async () => (await t.http().post('/v1/audit/programmes').set(H(P)).send({ name: `Prog ${Math.random()}`, auditType: 'statutory',
  sections: [{ key: 's', title: 'S', procedures: [{ key: 'a', title: 'A', evidence: [] }, { key: 'b', title: 'B', evidence: [] }] }] }).expect(201)).body.id as string;
async function pdf(text: string) {
  const d = new PDFDocument(); const parts: Buffer[] = []; d.on('data', (c: Buffer) => parts.push(c)); const done = new Promise((r) => d.on('end', r)); d.text(text); d.end(); await done; return Buffer.concat(parts);
}
const upload = async (name: string, type = 'application/pdf', documentId?: string) => {
  const r = t.http().post('/v1/documents').set(H(P)).field('clientId', clientA);
  if (documentId) r.field('documentId', documentId);
  return (await r.attach('file', type === 'application/pdf' ? await pdf(name) : Buffer.from(name), { filename: name, contentType: type }).expect(201)).body.id as string;
};
const hook = (events: unknown[]) => {
  const raw = JSON.stringify({ events });
  return t.http().post(`/v1/esign/webhooks/mock/${P.tenantId}`).set('Content-Type', 'application/json').set('x-worko-signature', esignHmac(DEV_ESIGN_WEBHOOK_SECRET, Buffer.from(raw))).send(raw).expect(200);
};

beforeAll(async () => {
  t = await bootApp();
  t.app.get(Clock).set(NOW);
  P = await t.signup('reviewfirm');
  M = await t.addUser(P, 'reviewfirm', 'Mohan', 'manager');
  S = await t.addUser(P, 'reviewfirm', 'Sita', 'senior');
  clientA = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Review Co Pvt Ltd', entityType: 'PRIVATE_COMPANY', managerId: M.userId, staffIds: [S.userId],
    contacts: [{ name: 'Rita MD', email: 'rita@review.example', isPrimary: true }] }).expect(201)).body.id;
  contactA = (await t.sql<{ id: string }>('SELECT id FROM contact WHERE client_id = $1', [clientA]))[0]!.id;
}, 60_000);
afterAll(() => t?.close());

describe('Phase 8 review fixes', () => {
  it('1: UDIN gate holds for bulk/undo done, invoice linking and unbilled candidates', async () => {
    const e = await engagement('2024-25');
    const bulk = (await t.http().post('/v1/tasks/bulk').set(H(P)).send({ ids: [e.taskId], patch: { status: 'done' } }).expect(200)).body;
    expect(bulk.failed).toEqual([{ id: e.taskId, reason: 'udin_required' }]);
    await t.sql(`UPDATE task SET status = 'done' WHERE id = $1`, [e.taskId]);
    expect((await t.http().get(`/v1/billing/unbilled?clientId=${clientA}`).set(H(P)).expect(200)).body.items.some((x: { id: string }) => x.id === e.taskId)).toBe(false);
    expect((await t.http().post('/v1/billing/invoices').set(H(P)).send({ clientId: clientA, lines: [{ description: 'Audit fee', ratePaise: 100_000, taskIds: [e.taskId] }] }).expect(400)).body.code).toBe('udin_required');
  });

  it('2: an engagement cannot adopt a task that is already done', async () => {
    const tid = (await t.http().post('/v1/tasks').set(H(P)).send({ client_id: clientA, title: 'Old audit', status: 'done', checks: [] }).expect(201)).body.id;
    expect((await t.http().post('/v1/audit/engagements').set(H(P)).send({ clientId: clientA, fy: '2023-24', auditType: 'statutory', taskId: tid }).expect(400)).body.code).toBe('task_already_done');
  });

  it('3 + 5: cancel/adjourn withdraw future hearing reminders (sync-visible); links must be https', async () => {
    const n = (await t.http().post('/v1/notices').set(H(P)).send({ clientId: clientA, authority: 'gst', title: 'ASMT-10', responseDue: '2026-12-01', assigneeId: S.userId }).expect(201)).body.id;
    await t.http().post(`/v1/notices/${n}/hearings`).set(H(P)).send({ startsAt: '2026-11-20T11:00:00+05:30', virtualLink: 'http://insecure.example/x' }).expect(400);
    const h = (await t.http().post(`/v1/notices/${n}/hearings`).set(H(P)).send({ startsAt: '2026-11-20T11:00:00+05:30' }).expect(201)).body.id;
    await t.http().patch(`/v1/notices/hearings/${h}`).set(H(P)).send({ virtualLink: 'ftp://x.example/y' }).expect(400);
    await t.http().post(`/v1/notices/hearings/${h}/adjourn`).set(H(P)).send({ startsAt: '2026-11-25T11:00:00+05:30', virtualLink: 'javascript:alert(1)' }).expect(400);
    const v0 = (await t.sql<{ version: number }>('SELECT version FROM notification WHERE entity_id = $1', [h]))[0]!.version;
    const h2 = (await t.http().post(`/v1/notices/hearings/${h}/adjourn`).set(H(P)).send({ startsAt: '2026-11-25T11:00:00+05:30' }).expect(201)).body.id;
    const old = (await t.sql<{ deleted_at: Date | null; version: number }>('SELECT deleted_at, version FROM notification WHERE entity_id = $1', [h]))[0]!;
    expect(old.deleted_at).not.toBeNull(); expect(old.version).toBeGreaterThan(v0);
    const pulled = (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(S)).expect(200)).body.changes as Array<{ table: string; id: string; deleted: boolean }>;
    expect(pulled.filter((c) => c.table === 'notification' && c.deleted).length).toBeGreaterThan(0);
    await t.http().patch(`/v1/notices/hearings/${h2}`).set(H(P)).send({ status: 'cancelled' }).expect(204);
    expect((await t.sql(`SELECT 1 FROM notification WHERE entity_id = $1 AND deleted_at IS NULL`, [h2])).length).toBe(0);
  });

  it('4: confirmed extraction values are validated (400) and move the linked task', async () => {
    const n = (await t.http().post('/v1/notices').set(H(P)).send({ clientId: clientA, authority: 'income_tax', title: 'u/s 142(1)', responseDue: '2026-11-30' }).expect(201)).body.id;
    const ex = (await t.http().post('/v1/notices/extract').set(H(P)).field('clientId', clientA).field('noticeId', n).attach('file', Buffer.from('on or before 10/12/2026'), { filename: 'n.txt', contentType: 'text/plain' }).expect(201)).body;
    for (const bad of [{ responseDue: '2026-13-45' }, { demandPaise: -5 }, { authority: 'martian' }, { assessmentYear: 'last year' }]) {
      expect((await t.http().post(`/v1/notices/extractions/${ex.id}/confirm`).set(H(P)).send({ fields: bad }).expect(400)).body.code).toBe('invalid:fields');
    }
    await t.http().post(`/v1/notices/extractions/${ex.id}/confirm`).set(H(P)).send({ fields: { responseDue: '2026-12-10' } }).expect(201);
    const taskId = (await t.http().get(`/v1/notices/${n}`).set(H(P))).body.taskId;
    expect((await t.http().get(`/v1/tasks/${taskId}`).set(H(P))).body).toMatchObject({ statutoryDue: '2026-12-10', actBy: '2026-12-03' });
  });

  it('6 + 10 + 11: workflow, closed-engagement locks, partner-only evidence changes on reviewed work, UDIN revoke after close', async () => {
    const e = await engagement('2025-26', { programmeId: await programme() });
    const [p1, p2] = e.procedures;
    expect((await t.http().patch(`/v1/audit/engagements/${e.id}`).set(H(P)).send({ status: 'review' }).expect(400)).body.code).toBe('invalid_transition');
    await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(S)).send({ level: 'preparer' }).expect(204);
    await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(M)).send({ level: 'reviewer' }).expect(204);
    const doc = await upload('wp.txt', 'text/plain');
    expect((await t.http().post(`/v1/audit/procedures/${p1!.id}/workpapers`).set(H(S)).send({ documentId: doc }).expect(403)).body.code).toBe('procedure_locked');
    await t.http().post(`/v1/audit/procedures/${p1!.id}/workpapers`).set(H(P)).send({ documentId: doc }).expect(201); // partner may (clears sign-offs)
    for (const lvl of ['preparer', 'reviewer', 'partner'] as const) await t.http().post(`/v1/audit/procedures/${p1!.id}/signoff`).set(H(lvl === 'preparer' ? S : lvl === 'reviewer' ? M : P)).send({ level: lvl }).expect(204);
    await t.http().patch(`/v1/audit/procedures/${p2!.id}`).set(H(S)).send({ notApplicable: true }).expect(204); // N/A by non-partner doesn't count
    await t.http().patch(`/v1/audit/engagements/${e.id}`).set(H(P)).send({ status: 'fieldwork' }).expect(204);
    await t.http().patch(`/v1/audit/engagements/${e.id}`).set(H(P)).send({ status: 'review' }).expect(204);
    expect((await t.http().patch(`/v1/audit/engagements/${e.id}`).set(H(P)).send({ status: 'closed' }).expect(400)).body.code).toBe('signoffs_pending');
    await t.http().patch(`/v1/audit/procedures/${p2!.id}`).set(H(P)).send({ notApplicable: true }).expect(204);
    expect((await t.http().patch(`/v1/audit/engagements/${e.id}`).set(H(P)).send({ status: 'closed' }).expect(400)).body.code).toBe('udin_required');
    const u = (await t.http().post('/v1/audit/udins').set(H(P)).send({ clientId: clientA, engagementId: e.id, udin: '26123456REVIEW0001', documentType: 'Audit report', generatedOn: '2026-10-28', membershipNo: '123456' }).expect(201)).body.id;
    await t.http().patch(`/v1/audit/engagements/${e.id}`).set(H(P)).send({ status: 'closed' }).expect(204);
    // Closed: no evidence changes, sign-offs or reopen; reopen of the engagement is partner-only.
    expect((await t.http().delete(`/v1/audit/workpapers/${(await t.sql<{ id: string }>('SELECT id FROM audit_workpaper WHERE procedure_id = $1', [p1!.id]))[0]!.id}`).set(H(P)).expect(409)).body.code).toBe('engagement_closed');
    expect((await t.http().post(`/v1/audit/procedures/${p1!.id}/reopen`).set(H(P)).send({ reason: 'x' }).expect(409)).body.code).toBe('engagement_closed');
    expect((await t.http().patch(`/v1/audit/engagements/${e.id}`).set(H(M)).send({ status: 'review' }).expect(403)).body.code).toBe('partner_required');
    expect((await t.http().post(`/v1/audit/udins/${u}/revoke`).set(H(M)).send({ reason: 'typo' }).expect(403)).body.code).toBe('partner_required');
    await t.http().post(`/v1/audit/udins/${u}/revoke`).set(H(P)).send({ reason: 'Wrong document type on portal' }).expect(204);
    expect((await t.http().get(`/v1/audit/engagements/${e.id}`).set(H(P))).body.udinRevokedAfterClose).toBe(true);
    expect((await t.sql<{ diff: { reason: string; afterClose: boolean } }>(`SELECT diff FROM audit_log WHERE action = 'udin.revoked' ORDER BY seq DESC LIMIT 1`))[0]!.diff).toMatchObject({ reason: 'Wrong document type on portal', afterClose: true });
  });

  it('7 + 13: retry resets every signer and cancels the old txn; finalize is idempotent; a moved document gets a non-current signed copy', async () => {
    const mock = (t.app.get(ESIGN_PROVIDERS) as Record<string, MockEsignProvider>).mock!;
    const doc = await upload('Agreement.pdf');
    const r = (await t.http().post('/v1/esign/requests').set(H(P)).send({ title: 'Agreement', mode: 'parallel', items: [{ documentId: doc, signers: [{ kind: 'contact', contactId: contactA }, { kind: 'staff', userId: S.userId }] }] }).expect(201)).body;
    const itemId = r.items[0].id;
    const [txn] = (await t.sql<{ provider_txn_id: string }>('SELECT provider_txn_id FROM esign_item WHERE id = $1', [itemId])).map((x) => x.provider_txn_id);
    const signers = await t.sql<{ id: string; kind: string }>('SELECT id, kind FROM esign_signer WHERE item_id = $1 ORDER BY ord, id', [itemId]);
    await hook([{ id: 'r1', txn, signer: signers[0]!.id, type: 'signed', maskedId: 'XXXXXXXX1111' }]);
    await hook([{ id: 'r2', txn, signer: signers[1]!.id, type: 'declined' }]);
    await t.http().post(`/v1/esign/requests/${r.id}/retry`).set(H(P)).expect(201);
    expect(mock.cancelled).toContain(txn);
    expect((await t.sql<{ status: string; masked_id: string | null }>('SELECT status, masked_id FROM esign_signer WHERE item_id = $1', [itemId])).every((x) => x.status === 'notified' && x.masked_id === null)).toBe(true);
    const txn2 = (await t.sql<{ provider_txn_id: string }>('SELECT provider_txn_id FROM esign_item WHERE id = $1', [itemId]))[0]!.provider_txn_id;
    // Document moves on (v2) before signing completes → signed copy stored as v3, not current.
    await upload('Agreement.pdf', 'application/pdf', doc);
    for (const s of signers) await hook([{ id: `f-${s.id}`, txn: txn2, signer: s.id, type: 'signed' }]);
    const item = (await t.sql<{ status: string; signed_version: number; signed_label: string }>('SELECT status, signed_version, signed_label FROM esign_item WHERE id = $1', [itemId]))[0]!;
    expect(item).toMatchObject({ status: 'signed', signed_version: 3, signed_label: 'signed copy of v1' });
    expect((await t.sql<{ current_version: number }>('SELECT current_version FROM document WHERE id = $1', [doc]))[0]!.current_version).toBe(2);
    // Idempotent re-finalize: forcing a failed state with the version already stored doesn't add another version.
    await t.sql(`UPDATE esign_item SET status = 'failed', error = 'finalize: boom', certificate_document_id = NULL, finalize_state = 'version_stored' WHERE id = $1`, [itemId]);
    await t.sql(`UPDATE esign_request SET status = 'partially_failed' WHERE id = $1`, [r.id]);
    await t.http().post(`/v1/esign/requests/${r.id}/retry`).set(H(P)).expect(201);
    expect((await t.sql<{ n: number }>('SELECT count(*)::int AS n FROM document_version WHERE document_id = $1', [doc]))[0]!.n).toBe(3);
    expect((await t.sql<{ status: string; certificate_document_id: string | null }>('SELECT status, certificate_document_id FROM esign_item WHERE id = $1', [itemId]))[0]).toMatchObject({ status: 'signed' });
  });

  it('8: DSC free text that looks like a PIN/password is refused (create, custody, acknowledge)', async () => {
    const base = { holderKind: 'client_contact', clientId: clientA, contactId: contactA, dscClass: 'Class 3', dscType: 'sign', issuer: 'eMudhra', validFrom: '2025-01-01', validTo: '2027-01-01' };
    await t.http().post('/v1/dsc').set(H(P)).send({ ...base, notes: 'token PIN: 4321' }).expect(400);
    await t.http().post('/v1/dsc').set(H(P)).send({ ...base, tokenLabel: 'password=abc' }).expect(400);
    const id = (await t.http().post('/v1/dsc').set(H(P)).send({ ...base, notes: 'Kept in locker 3' }).expect(201)).body.id;
    await t.http().post(`/v1/dsc/${id}/custody`).set(H(P)).send({ to: 'with_client', purpose: 'pwd 1234 for filing' }).expect(400);
    const m = (await t.http().post(`/v1/dsc/${id}/custody`).set(H(P)).send({ to: 'with_client', counterparty: 'Rita' }).expect(201)).body.id;
    await t.http().post(`/v1/dsc/custody/${m}/acknowledge`).set(H(P)).send({ name: 'Rita pin: 0000' }).expect(400);
  });

  it('9: hearing events are revoked with client access; alerts skip users who lost access', async () => {
    const n = (await t.http().post('/v1/notices').set(H(P)).send({ clientId: clientA, authority: 'tds', title: 'TDS default', responseDue: '2026-10-20', assigneeId: S.userId }).expect(201)).body.id;
    await t.http().post(`/v1/notices/${n}/hearings`).set(H(P)).send({ startsAt: '2026-11-02T11:00:00+05:30' }).expect(201);
    const evId = (await t.sql<{ calendar_event_id: string }>('SELECT calendar_event_id FROM notice_hearing WHERE notice_id = $1', [n]))[0]!.calendar_event_id;
    await t.http().put(`/v1/clients/${clientA}/access`).set(H(P)).send({ staffIds: [] }).expect(204);
    expect((await t.sql(`SELECT 1 FROM sync_revocation WHERE table_name = 'calendar_event' AND row_id = $1 AND $2::uuid = ANY(user_ids)`, [evId, S.userId])).length).toBe(1);
    const items = (await t.http().get('/v1/calendar/events?from=2026-10-29&to=2026-11-30').set(H(S)).expect(200)).body as Array<{ id: string }>;
    expect(items.some((i) => i.id === evId)).toBe(false);
    await t.http().post('/v1/practice/run').set(H(P)).send({ asOf: '2026-10-29' }).expect(201);
    expect((await t.sql(`SELECT 1 FROM notification WHERE user_id = $1 AND entity_id = $2 AND category = 'notice.response_due'`, [S.userId, n])).length).toBe(0);
    await t.http().put(`/v1/clients/${clientA}/access`).set(H(P)).send({ staffIds: [S.userId] }).expect(204);
  });

  it('12: a bulk request with invisible items shows only visible items and a redacted title', async () => {
    const hidden = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Hidden Co', entityType: 'PRIVATE_COMPANY' }).expect(201)).body.id;
    const hdoc = (await t.http().post('/v1/documents').set(H(P)).field('clientId', hidden).attach('file', await pdf('h'), { filename: 'h.pdf', contentType: 'application/pdf' }).expect(201)).body.id;
    const vdoc = await upload('visible.pdf');
    const r = (await t.http().post('/v1/esign/requests').set(H(P)).send({ title: 'Hidden Co + Review Co letters', items: [hdoc, vdoc].map((d) => ({ documentId: d, signers: [{ kind: 'staff', userId: P.userId }] })) }).expect(201)).body;
    const g = (await t.http().get(`/v1/esign/requests/${r.id}`).set(H(S)).expect(200)).body;
    expect(g).toMatchObject({ title: 'Restricted bulk request', restricted: true });
    expect(g.items.map((i: { documentId: string }) => i.documentId)).toEqual([vdoc]);
    expect((await t.http().get('/v1/esign/requests').set(H(S)).expect(200)).body.items.find((x: { id: string }) => x.id === r.id)).toMatchObject({ title: 'Restricted bulk request', visibleItems: 1 });
    expect((await t.http().get(`/v1/esign/requests/${r.id}`).set(H(P)).expect(200)).body.title).toBe('Hidden Co + Review Co letters');
  });

  it('14: renewing a DSC or licence closes the old renewal task with a reason', async () => {
    const id = (await t.http().post('/v1/dsc').set(H(P)).send({ holderKind: 'client_contact', clientId: clientA, holderName: 'Renew me', dscClass: 'Class 3', dscType: 'sign', issuer: 'Sify', validFrom: '2024-11-10', validTo: '2026-11-10' }).expect(201)).body.id;
    const l = (await t.http().post('/v1/licences').set(H(P)).send({ clientId: clientA, licenceType: 'fssai', validTo: '2026-11-15' }).expect(201)).body.id;
    await t.http().post('/v1/practice/run').set(H(P)).send({ asOf: '2026-10-29' }).expect(201);
    const dt = (await t.sql<{ renewal_task_id: string }>('SELECT renewal_task_id FROM dsc WHERE id = $1', [id]))[0]!.renewal_task_id;
    const lt = (await t.sql<{ renewal_task_id: string }>('SELECT renewal_task_id FROM licence WHERE id = $1', [l]))[0]!.renewal_task_id;
    await t.http().patch(`/v1/dsc/${id}`).set(H(P)).send({ validFrom: '2026-11-10', validTo: '2028-11-09' }).expect(204);
    await t.http().patch(`/v1/licences/${l}`).set(H(P)).send({ validTo: '2031-11-15' }).expect(204);
    const closed = await t.sql<{ outcome: string; outcome_note: string }>('SELECT outcome, outcome_note FROM task WHERE id = ANY($1::uuid[]) ORDER BY outcome_note', [[dt, lt]]);
    expect(closed.map((c) => c.outcome)).toEqual(['deleted', 'deleted']);
    expect(closed.map((c) => c.outcome_note)).toEqual(['DSC renewed: valid to 2028-11-09', 'Licence renewed: 2031-11-15']);
  });
});
