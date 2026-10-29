import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChannelHub } from '../src/comm/channels.js';
import { Clock } from '../src/common/clock.js';
import { DEV_ESIGN_WEBHOOK_SECRET, esignHmac, ESIGN_PROVIDERS, type MockEsignProvider } from '../src/practice/esign.provider.js';
import { signerLink } from '../src/practice/esign.service.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let S: Session;
let clientA: string; let clientB: string; let contactA: string;
let mock: MockEsignProvider; let hub: MockChannelHub;
const NOW = new Date('2026-10-29T10:00:00+05:30');
const H = (s: Session) => bearer(s.accessToken);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function pdf(text: string): Promise<Buffer> {
  const d = new PDFDocument(); const parts: Buffer[] = [];
  d.on('data', (c: Buffer) => parts.push(c)); const done = new Promise((r) => d.on('end', r));
  d.text(text); d.end(); await done; return Buffer.concat(parts);
}
const upload = async (s: Session, clientId: string, name: string) => {
  const buf = await pdf(name);
  const r = (await t.http().post('/v1/documents').set(H(s)).field('clientId', clientId).attach('file', buf, { filename: name, contentType: 'application/pdf' }).expect(201)).body;
  return { id: r.id as string, buf };
};
const hook = (body: unknown, opts: { tenant?: string; sig?: string } = {}) => {
  const raw = JSON.stringify(body);
  return t.http().post(`/v1/esign/webhooks/mock/${opts.tenant ?? P.tenantId}`).set('Content-Type', 'application/json').set('x-worko-signature', opts.sig ?? esignHmac(DEV_ESIGN_WEBHOOK_SECRET, Buffer.from(raw))).send(raw);
};
const ev = (id: string, txn: string, signer: string, extra: Record<string, unknown> = {}) => ({ events: [{ id, txn, signer, type: 'signed', at: '2026-10-29T05:00:00Z', ...extra }] });

beforeAll(async () => {
  t = await bootApp();
  t.app.get(Clock).set(NOW);
  mock = (t.app.get(ESIGN_PROVIDERS) as Record<string, MockEsignProvider>).mock!;
  hub = t.app.get(MockChannelHub);
  P = await t.signup('esignfirm');
  S = await t.addUser(P, 'esignfirm', 'Sita', 'senior');
  clientA = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Epsilon Pvt Ltd', entityType: 'PRIVATE_COMPANY', staffIds: [S.userId], contacts: [{ name: 'Esha MD', email: 'esha@epsilon.example', isPrimary: true }] }).expect(201)).body.id;
  contactA = (await t.sql<{ id: string }>('SELECT id FROM contact WHERE client_id = $1', [clientA]))[0]!.id;
  clientB = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Zeta Hidden', entityType: 'PRIVATE_COMPANY' }).expect(201)).body.id;
}, 60_000);
afterAll(() => t?.close());

describe('e-signature (M12)', () => {
  let reqId: string; let itemId: string; let txn: string; let doc: { id: string; buf: Buffer };
  let contactSigner: string; let staffSigner: string;
  it('sequential request: provider txn, first signer notified through comm, order enforced on links', async () => {
    doc = await upload(P, clientA, 'Board resolution.pdf');
    const before = hub.outbox.length;
    const r = (await t.http().post('/v1/esign/requests').set(H(P)).send({ title: 'Board resolution', mode: 'sequential',
      items: [{ documentId: doc.id, signers: [{ kind: 'contact', contactId: contactA }, { kind: 'staff', userId: S.userId }] }] }).expect(201)).body;
    reqId = r.id; itemId = r.items[0].id;
    expect(r).toMatchObject({ status: 'in_progress', items: [{ status: 'sent' }] });
    const msg = hub.outbox.slice(before).find((m) => m.to === 'esha@epsilon.example')!;
    expect(msg.text).toMatch(/\/esign\/sign\//);
    const token = msg.text.split('/esign/sign/')[1]!.trim();
    expect((await t.http().get(`/v1/esign/sign/${token}`).expect(200)).body).toMatchObject({ documentName: 'Board resolution.pdf', signerName: 'Esha MD' });
    const signers = await t.sql<{ id: string; kind: string; link_nonce: string; status: string }>('SELECT id, kind, link_nonce, status FROM esign_signer WHERE item_id = $1 ORDER BY ord', [itemId]);
    contactSigner = signers[0]!.id; staffSigner = signers[1]!.id;
    expect(signers.map((s) => s.status)).toEqual(['notified', 'pending']);
    expect((await t.http().get(`/v1/esign/sign/${signerLink(P.tenantId, staffSigner, signers[1]!.link_nonce)}`).expect(409)).body.code).toBe('not_your_turn');
    await t.http().get(`/v1/esign/sign/${signerLink(P.tenantId, staffSigner, 'wrong-nonce')}`).expect(404);
    await t.http().get(`/v1/esign/sign/${token.slice(0, -2)}xx`).expect(404);
    txn = (await t.sql<{ provider_txn_id: string }>('SELECT provider_txn_id FROM esign_item WHERE id = $1', [itemId]))[0]!.provider_txn_id;
    const audit = await t.sql<{ diff: unknown }>(`SELECT diff FROM audit_log WHERE action = 'esign.requested'`);
    expect(JSON.stringify(audit)).not.toContain('esha@epsilon.example');
  });

  it('webhook: signature required, mock locked down, replay-safe, sequential order enforced', async () => {
    await hook(ev('e1', txn, contactSigner), { sig: 'bad' }).expect(401);
    await hook(ev('e1', txn, contactSigner), { tenant: '00000000-0000-4000-8000-000000000000' }).expect(404);
    const env = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    try { await hook(ev('e1', txn, contactSigner)).expect(404); } finally { process.env.NODE_ENV = env; }
    expect((await hook(ev('e0', txn, staffSigner)).expect(200)).body.results[0].outcome).toBe('out_of_order');
    expect((await t.sql<{ status: string }>('SELECT status FROM esign_signer WHERE id = $1', [staffSigner]))[0]!.status).toBe('pending');
    expect((await hook(ev('e1', txn, contactSigner, { maskedId: 'XXXXXXXX1234', name: 'ESHA M D' })).expect(200)).body.results[0].outcome).toBe('signed');
    expect((await hook(ev('e1', txn, contactSigner)).expect(200)).body.results[0].outcome).toBe('duplicate');
    expect((await t.sql(`SELECT 1 FROM notification WHERE category = 'esign.request' AND user_id = $1`, [S.userId])).length).toBe(1);
  });

  it('last signature stores the signed file as a new version + an audit-trail certificate with hashes; never a full Aadhaar number', async () => {
    expect((await hook(ev('e2', txn, staffSigner, { maskedId: '123412341234' })).expect(200)).body.results[0].outcome).toBe('signed');
    const r = (await t.http().get(`/v1/esign/requests/${reqId}`).set(H(P)).expect(200)).body;
    expect(r.status).toBe('completed');
    const it0 = r.items[0];
    expect(it0).toMatchObject({ status: 'signed', signedVersion: 2, originalSha256: sha(doc.buf) });
    expect(it0.signers.map((s: { maskedId: string | null }) => s.maskedId)).toEqual(['XXXXXXXX1234', null]);
    const versions = (await t.http().get(`/v1/documents/${doc.id}/versions`).set(H(P)).expect(200)).body;
    expect(versions[0]).toMatchObject({ version: 2, sha256: it0.signedSha256 });
    expect(versions[0].note).toContain(txn);
    const cert = (await t.sql<{ category: string; mime: string; client_id: string }>('SELECT category, mime, client_id FROM document WHERE id = $1', [it0.certificateDocumentId]))[0];
    expect(cert).toEqual({ category: 'E-sign certificates', mime: 'application/pdf', client_id: clientA });
    await expect(t.sql(`UPDATE esign_signer SET masked_id = '123456789012' WHERE id = $1`, [contactSigner])).rejects.toThrow();
    expect((await hook(ev('e3', txn, staffSigner)).expect(200)).body.results[0].outcome).toBe('item_not_open');
  });

  it('bulk: per-item status, partial failure, retry and cancel', async () => {
    const docs = [await upload(P, clientA, 'Engagement letter 1.pdf'), await upload(P, clientA, 'Engagement letter 2.pdf'), await upload(P, clientA, 'Engagement letter 3.pdf')];
    mock.failDocs.add(docs[1]!.id);
    const r = (await t.http().post('/v1/esign/requests').set(H(P)).send({ title: 'Engagement letters FY 2026-27', items: docs.map((d) => ({ documentId: d.id, signers: [{ kind: 'contact', contactId: contactA }] })) }).expect(201)).body;
    expect(r.items.map((i: { status: string }) => i.status).sort()).toEqual(['failed', 'sent', 'sent']);
    const list = (await t.http().get('/v1/esign/requests').set(H(P)).expect(200)).body.items.find((x: { id: string }) => x.id === r.id);
    expect(list).toMatchObject({ bulk: true, items: 3, status: 'in_progress' });
    const rt = (await t.http().post(`/v1/esign/requests/${r.id}/retry`).set(H(P)).expect(201)).body;
    expect(rt.items.every((i: { status: string }) => i.status === 'sent')).toBe(true);
    expect((await t.http().post(`/v1/esign/requests/${r.id}/retry`).set(H(P)).expect(409)).body.code).toBe('nothing_to_retry');
    // One item gets signed, then the request is cancelled: open items cancel, links die.
    const it1 = (await t.sql<{ id: string; provider_txn_id: string }>('SELECT id, provider_txn_id FROM esign_item WHERE request_id = $1 AND document_id = $2', [r.id, docs[0]!.id]))[0]!;
    const s1 = (await t.sql<{ id: string }>('SELECT id FROM esign_signer WHERE item_id = $1', [it1.id]))[0]!.id;
    await hook(ev('b1', it1.provider_txn_id, s1)).expect(200);
    const s2 = (await t.sql<{ id: string; link_nonce: string }>(`SELECT s.id, s.link_nonce FROM esign_signer s JOIN esign_item i ON i.id = s.item_id WHERE i.request_id = $1 AND i.document_id = $2`, [r.id, docs[2]!.id]))[0]!;
    await t.http().post(`/v1/esign/requests/${r.id}/cancel`).set(H(P)).expect(204);
    await t.http().get(`/v1/esign/sign/${signerLink(P.tenantId, s2.id, s2.link_nonce)}`).expect(404);
    const after = (await t.http().get(`/v1/esign/requests/${r.id}`).set(H(P)).expect(200)).body;
    expect(after.status).toBe('cancelled');
    expect(after.items.map((i: { status: string }) => i.status).sort()).toEqual(['cancelled', 'cancelled', 'signed']);
    expect(mock.cancelled.length).toBe(2);
    await t.http().post(`/v1/esign/requests/${r.id}/cancel`).set(H(P)).expect(409);
  });

  it('visibility and validation: invisible documents 404; only PDFs; signers must belong to the client', async () => {
    const hidden = await upload(P, clientB, 'Hidden.pdf');
    const r = (await t.http().post('/v1/esign/requests').set(H(P)).send({ title: 'Hidden', items: [{ documentId: hidden.id, signers: [{ kind: 'staff', userId: P.userId }] }] }).expect(201)).body;
    await t.http().get(`/v1/esign/requests/${r.id}`).set(H(S)).expect(404);
    expect((await t.http().get('/v1/esign/requests').set(H(S)).expect(200)).body.items.some((x: { id: string }) => x.id === r.id)).toBe(false);
    await t.http().post('/v1/esign/requests').set(H(S)).send({ title: 'x', items: [{ documentId: hidden.id, signers: [{ kind: 'staff', userId: S.userId }] }] }).expect(404);
    expect((await t.http().post('/v1/esign/requests').set(H(P)).send({ title: 'x', items: [{ documentId: hidden.id, signers: [{ kind: 'contact', contactId: contactA }] }] }).expect(400)).body.code).toBe('invalid:signers');
    const txt = (await t.http().post('/v1/documents').set(H(P)).field('clientId', clientA).attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' }).expect(201)).body.id;
    expect((await t.http().post('/v1/esign/requests').set(H(P)).send({ title: 'x', items: [{ documentId: txt, signers: [{ kind: 'contact', contactId: contactA }] }] }).expect(400)).body.code).toBe('pdf_required');
  });
});
