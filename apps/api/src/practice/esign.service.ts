import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { can, clientCtx, effectiveScope, normalizeAddress, type CommChannel } from '@worko/domain';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import PDFDocument from 'pdfkit';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { publicBase } from '../billing/providers.js';
import { visibilityOf } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { CommService } from '../comm/comm.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { DocumentsService } from '../documents/documents.service.js';
import { insertNotifications } from '../notifications/insert.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { STORAGE, type StorageAdapter } from '../storage/storage.js';
import { systemActor } from '../tasks/system-actor.js';
import { assertEsignConfig, ESIGN_PROVIDERS, esignProvider, mockEsignAllowed, type EsignProvider } from './esign.provider.js';

type SignerIn = { kind: 'contact'; contactId: string; order?: number } | { kind: 'staff'; userId: string; order?: number };
type ItemIn = { documentId: string; version?: number; signers: SignerIn[] };
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// ---------- Signed signer links (revocable: the nonce rotates on retry/cancel) ----------
const linkKey = () => createHash('sha256').update(`esign-link:${process.env.JWT_SIGNING_KEY ?? 'worko-dev-only-signing-key'}`).digest();
export function signerLink(tenantId: string, signerId: string, nonce: string) {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, s: signerId, n: nonce })).toString('base64url');
  return `${payload}.${createHmac('sha256', linkKey()).update(payload).digest('base64url')}`;
}
function verifyLink(token: string): { t: string; s: string; n: string } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = createHmac('sha256', linkKey()).update(payload).digest(); const got = Buffer.from(sig, 'base64url');
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try { const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { t: string; s: string; n: string }; return isUuid(p.t) && isUuid(p.s) && typeof p.n === 'string' ? p : null; } catch { return null; }
}

async function toBuffer(s: Readable) { const parts: Buffer[] = []; for await (const c of s) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return Buffer.concat(parts); }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const fmtIst = (d: Date) => `${d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' })} IST`;

@Injectable()
export class EsignService implements OnModuleInit {
  constructor(private db: DbService, private audit: AuditService, private realtime: RealtimeService, private clock: Clock, private comm: CommService, private docs: DocumentsService,
    @Inject(STORAGE) private storage: StorageAdapter, @Inject(ESIGN_PROVIDERS) private providers: Record<string, EsignProvider>) {}

  onModuleInit() { assertEsignConfig(); }
  private provider() { const p = this.providers[esignProvider()]; if (!p) throw new Error('Unknown e-sign provider'); return p; }

  /** Document visible for documents:<action> (client docs: clients:view too; firm docs: firm-wide), else 404/403. */
  private async docFor(tx: Tx, a: RequestActor, id: string, action: 'view' | 'edit') {
    const d = (await tx.query('SELECT * FROM document WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
    if (!d) throw new NotFoundException('Document not found');
    if (!d.client_id) {
      if (!a.superAdmin && effectiveScope(a, 'documents', action)?.scope !== 'all') throw new NotFoundException('Document not found');
      return d;
    }
    const c = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [d.client_id])).rows[0];
    const ctx = c && clientCtx(visibilityOf(c));
    if (!c || !can(a, 'clients', 'view', ctx) || !can(a, 'documents', 'view', ctx)) throw new NotFoundException('Document not found');
    if (!can(a, 'documents', action, ctx)) throw new ForbiddenException();
    return d;
  }
  private async visibleItem(tx: Tx, a: RequestActor, docId: string) { try { await this.docFor(tx, a, docId, 'view'); return true; } catch { return false; } }

  async create(a: RequestActor, b: { title: string; mode: 'parallel' | 'sequential'; items: ItemIn[] }) {
    if (process.env.NODE_ENV === 'production' && esignProvider() === 'mock') throw new BadRequestException({ message: 'E-sign provider not configured', code: 'esign_not_configured' });
    const prov = this.provider();
    const id = uuidv7();
    const plan = await this.db.tenantTx(a.tenantId, async (tx) => {
      const items: Array<{ itemId: string; doc: Record<string, unknown>; version: number; sha256: string; signers: Array<{ id: string; order: number; name: string; email: string | null; phone: string | null; kind: string; userId: string | null; contactId: string | null; nonce: string }> }> = [];
      for (const it of b.items) {
        const d = await this.docFor(tx, a, it.documentId, 'edit');
        const version = it.version ?? d.current_version;
        const v = (await tx.query('SELECT sha256, mime FROM document_version WHERE document_id = $1 AND version = $2', [d.id, version])).rows[0];
        if (!v) throw new BadRequestException({ message: 'Unknown document version', code: 'invalid:version' });
        if (v.mime !== 'application/pdf') throw new BadRequestException({ message: 'Only PDFs can be e-signed', code: 'pdf_required' });
        if (d.legal_hold) throw new BadRequestException({ message: 'Document is under legal hold', code: 'legal_hold' });
        const signers = [];
        for (const [n, s] of it.signers.entries()) {
          if (s.kind === 'contact') {
            const ct = (await tx.query('SELECT id, client_id, name, email, phone FROM contact WHERE id = $1 AND deleted_at IS NULL', [s.contactId])).rows[0];
            if (!ct || ct.client_id !== d.client_id) throw new BadRequestException({ message: 'Signer must be a contact of the document client', code: 'invalid:signers' });
            signers.push({ id: uuidv7(), order: b.mode === 'sequential' ? s.order ?? n + 1 : 1, name: ct.name, email: ct.email, phone: ct.phone, kind: 'contact', userId: null, contactId: ct.id, nonce: randomBytes(12).toString('base64url') });
          } else {
            const u = (await tx.query(`SELECT id, name, email FROM app_user WHERE id = $1 AND status = 'active' AND deleted_at IS NULL AND kind = 'staff'`, [s.userId])).rows[0];
            if (!u) throw new BadRequestException({ message: 'Unknown staff signer', code: 'invalid:signers' });
            signers.push({ id: uuidv7(), order: b.mode === 'sequential' ? s.order ?? n + 1 : 1, name: u.name, email: u.email, phone: null, kind: 'staff', userId: u.id, contactId: null, nonce: randomBytes(12).toString('base64url') });
          }
        }
        items.push({ itemId: uuidv7(), doc: d, version, sha256: v.sha256, signers });
      }
      await tx.query('INSERT INTO esign_request (id, tenant_id, title, bulk, mode, provider, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, a.tenantId, b.title, items.length > 1, b.mode, prov.name, a.userId]);
      for (const it of items) {
        await tx.query('INSERT INTO esign_item (id, tenant_id, request_id, document_id, document_version, client_id, original_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [it.itemId, a.tenantId, id, it.doc.id, it.version, it.doc.client_id, it.sha256]);
        for (const s of it.signers) await tx.query(`INSERT INTO esign_signer (id, tenant_id, item_id, request_id, ord, kind, contact_id, user_id, name, email, phone, link_nonce) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [s.id, a.tenantId, it.itemId, id, s.order, s.kind, s.contactId, s.userId, s.name, s.email, s.phone, s.nonce]);
      }
      // Metadata only: document ids and signer counts, never signer contact details.
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'esign.requested', entity: 'esign_request', entityId: id,
        diff: { mode: b.mode, provider: prov.name, items: items.map((i) => ({ documentId: i.doc.id, version: i.version, signers: i.signers.length })) } });
      return items.map((i) => i.itemId);
    });
    for (const itemId of plan) await this.send(a.tenantId, itemId, a.userId);
    await this.db.tenantTx(a.tenantId, (tx) => this.rollup(tx, id));
    return { id, ...(await this.summary(a.tenantId, id)) };
  }

  /** Creates the provider transaction for one item and notifies the signers whose turn it is. Failure marks the item failed (retryable). */
  private async send(tenantId: string, itemId: string, by: string | null) {
    const prov = this.provider();
    const it = await this.db.tenantTx(tenantId, async (tx) => {
      const it = (await tx.query(`SELECT i.*, d.name AS doc_name, r.mode FROM esign_item i JOIN document d ON d.id = i.document_id JOIN esign_request r ON r.id = i.request_id WHERE i.id = $1`, [itemId])).rows[0];
      const signers = (await tx.query(`SELECT * FROM esign_signer WHERE item_id = $1 AND status <> 'cancelled' ORDER BY ord, id`, [itemId])).rows;
      return { ...it, signers };
    });
    let res: { txnId: string; signerUrls: Record<string, string> } | null = null; let error: string | null = null;
    try {
      res = await prov.createTransaction({ itemId, documentId: it.document_id, fileName: it.doc_name, sha256: it.original_sha256, mode: it.mode,
        signers: it.signers.map((s: Record<string, unknown>) => ({ signerId: s.id as string, name: s.name as string, email: (s.email as string) ?? null, phone: (s.phone as string) ?? null, order: s.ord as number })) });
    } catch (e) { error = String((e as Error).message ?? 'error').slice(0, 300); }
    const deliver: string[] = [];
    let cursor = 0;
    await this.db.tenantTx(tenantId, async (tx) => {
      if (!res) {
        await tx.query(`UPDATE esign_item SET status = 'failed', error = $2, attempts = attempts + 1, updated_at = now() WHERE id = $1`, [itemId, error]);
        await this.audit.record(tx, tenantId, { actorId: by, deviceId: 'server', action: 'esign.item_failed', entity: 'esign_request', entityId: it.request_id, diff: { itemId, error } });
        return;
      }
      await tx.query(`UPDATE esign_item SET status = 'sent', provider_txn_id = $2, error = NULL, attempts = attempts + 1, updated_at = now() WHERE id = $1`, [itemId, res.txnId]);
      for (const [sid, url] of Object.entries(res.signerUrls)) await tx.query('UPDATE esign_signer SET provider_signer_ref = $3 WHERE id = $1 AND item_id = $2', [sid, itemId, url.slice(0, 2000)]);
      const r = await this.notifyDue(tx, tenantId, itemId, by);
      deliver.push(...r.messages); cursor = r.cursor;
    });
    if (cursor) this.realtime.publish({ type: 'changed', tenantId, cursor });
    for (const m of deliver) await this.comm.deliverNow(tenantId, m, this.clock.now());
  }

  /** Notifies signers whose turn it is (parallel: all; sequential: lowest unsigned order). Clients via the comm pipeline (consent applies), staff in-app. */
  private async notifyDue(tx: Tx, tenantId: string, itemId: string, by: string | null) {
    const signers = (await tx.query(`SELECT s.*, i.request_id, d.name AS doc_name, r.mode FROM esign_signer s JOIN esign_item i ON i.id = s.item_id JOIN document d ON d.id = i.document_id
      JOIN esign_request r ON r.id = s.request_id WHERE s.item_id = $1 AND s.status <> 'cancelled' ORDER BY s.ord, s.id`, [itemId])).rows;
    const pending = signers.filter((s) => s.status !== 'signed');
    const turn = pending.length ? (signers[0].mode === 'sequential' ? pending.filter((s) => s.ord === pending[0].ord) : pending) : [];
    const messages: string[] = []; let cursor = 0;
    for (const s of turn.filter((x) => x.status === 'pending')) {
      const url = `${publicBase()}/esign/sign/${signerLink(tenantId, s.id, s.link_nonce)}`;
      const text = `Please e-sign "${s.doc_name}": ${url}`;
      let outcome = 'notified';
      if (s.kind === 'staff') {
        const r = await insertNotifications(tx, tenantId, { userIds: [s.user_id], category: 'esign.request', priority: 'high', title: `Signature requested: ${String(s.doc_name).slice(0, 120)}`,
          body: 'Open the signing link from the request.', entityType: 'esign_request', entityId: s.request_id, dedupeKey: `esign:${s.id}:${s.link_nonce}` });
        cursor = Math.max(cursor, r.cursor);
      } else {
        const ct = (await tx.query('SELECT client_id FROM contact WHERE id = $1', [s.contact_id])).rows[0];
        const channel: CommChannel = s.email ? 'email' : 'whatsapp';
        const address = normalizeAddress(channel, s.email ?? s.phone);
        if (!address) outcome = 'no_address';
        else {
          const q = await this.comm.queueTx(tx, tenantId, { clientId: ct?.client_id ?? null, contactId: s.contact_id, channel, address, category: 'transactional', subject: 'Document for your e-signature',
            text, createdBy: by, now: this.clock.now(), meta: { esignRequestId: s.request_id }, format: 'text' });
          if ('error' in q) outcome = q.error; else messages.push(q.id);
        }
      }
      await tx.query(`UPDATE esign_signer SET status = 'notified', notified_at = $2, updated_at = now() WHERE id = $1`, [s.id, this.clock.now()]);
      await this.audit.record(tx, tenantId, { actorId: by, deviceId: 'server', action: 'esign.signer_notified', entity: 'esign_request', entityId: s.request_id, diff: { signerId: s.id, kind: s.kind, outcome } });
    }
    return { messages, cursor };
  }

  private async rollup(tx: Tx, requestId: string) {
    const r = (await tx.query(`SELECT r.status, count(*) FILTER (WHERE i.status = 'signed') AS signed, count(*) FILTER (WHERE i.status = 'failed') AS failed,
      count(*) FILTER (WHERE i.status IN ('pending','sent')) AS open, count(*) AS total FROM esign_request r JOIN esign_item i ON i.request_id = r.id WHERE r.id = $1 GROUP BY r.status`, [requestId])).rows[0];
    if (!r || r.status === 'cancelled') return;
    const next = Number(r.open) > 0 ? 'in_progress' : Number(r.failed) > 0 ? 'partially_failed' : 'completed';
    await tx.query(`UPDATE esign_request SET status = $2, completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END, version = version + 1, updated_at = now() WHERE id = $1 AND status <> $2`, [requestId, next]);
  }

  private async summary(tenantId: string, id: string) {
    return this.db.tenantTx(tenantId, async (tx) => {
      const r = (await tx.query('SELECT status FROM esign_request WHERE id = $1', [id])).rows[0];
      const items = (await tx.query('SELECT id, document_id AS "documentId", status, error FROM esign_item WHERE request_id = $1 ORDER BY id', [id])).rows;
      return { status: r.status as string, items };
    });
  }

  list(a: RequestActor, q: { status?: string; limit: number; offset: number }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const rows = (await tx.query(`SELECT r.*, (SELECT array_agg(i.document_id) FROM esign_item i WHERE i.request_id = r.id) AS docs FROM esign_request r
        WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.created_at DESC LIMIT 1000`, [q.status ?? null])).rows;
      const out = [];
      for (const r of rows) {
        let visible = 0; for (const d of (r.docs ?? []) as string[]) if (await this.visibleItem(tx, a, d)) visible++;
        if (visible) out.push({ id: r.id, title: r.title, bulk: r.bulk, mode: r.mode, provider: r.provider, status: r.status, items: (r.docs ?? []).length, visibleItems: visible, createdAt: r.created_at, completedAt: r.completed_at });
      }
      return { total: out.length, items: out.slice(q.offset, q.offset + q.limit) };
    });
  }

  get(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const r = (await tx.query('SELECT * FROM esign_request WHERE id = $1', [id])).rows[0];
      if (!r) throw new NotFoundException();
      const items = [];
      for (const i of (await tx.query('SELECT i.*, d.name AS doc_name FROM esign_item i JOIN document d ON d.id = i.document_id WHERE i.request_id = $1 ORDER BY i.id', [id])).rows) {
        if (!(await this.visibleItem(tx, a, i.document_id))) continue;
        const signers = (await tx.query(`SELECT id, ord, kind, contact_id AS "contactId", user_id AS "userId", name, status, notified_at AS "notifiedAt", signed_at AS "signedAt", masked_id AS "maskedId"
          FROM esign_signer WHERE item_id = $1 ORDER BY ord, id`, [i.id])).rows;
        items.push({ id: i.id, documentId: i.document_id, documentName: i.doc_name, documentVersion: i.document_version, clientId: i.client_id, status: i.status, error: i.error, attempts: i.attempts,
          providerTxnId: i.provider_txn_id, signedVersion: i.signed_version, certificateDocumentId: i.certificate_document_id, originalSha256: i.original_sha256, signedSha256: i.signed_sha256, signers });
      }
      if (!items.length) throw new NotFoundException();
      return { id: r.id, title: r.title, bulk: r.bulk, mode: r.mode, provider: r.provider, status: r.status, createdAt: r.created_at, completedAt: r.completed_at, items };
    });
  }

  private async editableRequest(tx: Tx, a: RequestActor, id: string) {
    const r = (await tx.query('SELECT * FROM esign_request WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new NotFoundException();
    const items = (await tx.query('SELECT * FROM esign_item WHERE request_id = $1', [id])).rows;
    for (const i of items) await this.docFor(tx, a, i.document_id, 'edit');
    return { r, items };
  }

  async retry(a: RequestActor, id: string) {
    const ids = await this.db.tenantTx(a.tenantId, async (tx) => {
      const { r, items } = await this.editableRequest(tx, a, id);
      if (r.status === 'cancelled') throw new ConflictException({ message: 'Request cancelled', code: 'esign_cancelled' });
      const failed = items.filter((i) => i.status === 'failed').map((i) => i.id as string);
      if (!failed.length) throw new ConflictException({ message: 'Nothing to retry', code: 'nothing_to_retry' });
      // New nonces: links sent for the failed attempt stop working.
      await tx.query(`UPDATE esign_signer SET status = 'pending', link_nonce = encode(gen_random_bytes(12), 'hex'), notified_at = NULL WHERE item_id = ANY($1::uuid[]) AND status <> 'signed'`, [failed]);
      await tx.query(`UPDATE esign_item SET status = 'pending' WHERE id = ANY($1::uuid[])`, [failed]);
      await tx.query(`UPDATE esign_request SET status = 'in_progress' WHERE id = $1`, [id]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'esign.retried', entity: 'esign_request', entityId: id, diff: { items: failed } });
      return failed;
    });
    for (const i of ids) await this.send(a.tenantId, i, a.userId);
    await this.db.tenantTx(a.tenantId, (tx) => this.rollup(tx, id));
    return this.summary(a.tenantId, id);
  }

  async cancel(a: RequestActor, id: string) {
    const txns = await this.db.tenantTx(a.tenantId, async (tx) => {
      const { r, items } = await this.editableRequest(tx, a, id);
      if (['completed', 'cancelled'].includes(r.status)) throw new ConflictException({ message: 'Request already finished', code: 'esign_finished' });
      const open = items.filter((i) => ['pending', 'sent', 'failed'].includes(i.status));
      await tx.query(`UPDATE esign_item SET status = 'cancelled', updated_at = now() WHERE id = ANY($1::uuid[])`, [open.map((i) => i.id)]);
      await tx.query(`UPDATE esign_signer SET status = 'cancelled', link_nonce = encode(gen_random_bytes(12), 'hex') WHERE item_id = ANY($1::uuid[]) AND status <> 'signed'`, [open.map((i) => i.id)]);
      await tx.query(`UPDATE esign_request SET status = 'cancelled', cancelled_at = $2, cancelled_by = $3, version = version + 1 WHERE id = $1`, [id, this.clock.now(), a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'esign.cancelled', entity: 'esign_request', entityId: id, diff: { items: open.length } });
      return open.map((i) => i.provider_txn_id as string | null).filter((x): x is string => !!x);
    });
    for (const t of txns) await this.provider().cancel(t).catch(() => undefined);
  }

  // ---------- Public: signer link + provider webhook ----------
  /** Resolves a signer link to the provider's signing URL. Uniform 404 for bad/revoked links; 409 when it isn't this signer's turn yet. */
  async openLink(token: string) {
    const p = verifyLink(token);
    if (!p) throw new NotFoundException();
    const s = await this.db.tenantTx(p.t, async (tx) => (await tx.query(`SELECT s.*, i.status AS item_status, i.provider_txn_id, i.document_id, d.name AS doc_name, r.mode FROM esign_signer s JOIN esign_item i ON i.id = s.item_id
      JOIN document d ON d.id = i.document_id JOIN esign_request r ON r.id = s.request_id WHERE s.id = $1`, [p.s])).rows[0]);
    if (!s || s.link_nonce.length !== p.n.length || !timingSafeEqual(Buffer.from(s.link_nonce), Buffer.from(p.n)) || s.item_status !== 'sent' || !['pending', 'notified'].includes(s.status)) throw new NotFoundException();
    if (s.mode === 'sequential' && (await this.earlierUnsigned(p.t, s.item_id, s.ord))) throw new ConflictException({ message: 'Waiting for an earlier signer', code: 'not_your_turn' });
    return { documentName: s.doc_name as string, signerName: s.name as string, signingUrl: (s.provider_signer_ref as string) ?? null };
  }

  private earlierUnsigned(tenantId: string, itemId: string, ord: number) {
    return this.db.tenantTx(tenantId, async (tx) => !!(await tx.query(`SELECT 1 FROM esign_signer WHERE item_id = $1 AND ord < $2 AND status NOT IN ('signed','cancelled') LIMIT 1`, [itemId, ord])).rowCount);
  }

  async webhook(providerName: string, tenantId: string, raw: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const prov = this.providers[providerName];
    if (!prov || (providerName === 'mock' && !mockEsignAllowed()) || (providerName !== 'mock' && esignProvider() !== providerName)) throw new NotFoundException();
    if (!isUuid(tenantId) || !(await this.db.systemTx((tx) => tx.query('SELECT 1 FROM tenant WHERE id = $1', [tenantId]))).rowCount) throw new NotFoundException();
    if (!raw || !prov.verifyWebhook(raw, headers)) throw new UnauthorizedException({ message: 'Bad signature', code: 'bad_signature' });
    let events;
    try { events = prov.parseWebhook(raw); } catch { throw new BadRequestException('Unrecognised payload'); }
    const results: Array<{ eventId: string; outcome: string }> = [];
    for (const ev of events) {
      const r = await this.db.tenantTx(tenantId, async (tx) => {
        const ins = await tx.query(`INSERT INTO esign_webhook_event (id, tenant_id, provider, event_id, body_sha256, outcome) VALUES ($1,$2,$3,$4,$5,'received')
          ON CONFLICT (tenant_id, provider, event_id) DO NOTHING RETURNING id`, [uuidv7(), tenantId, prov.name, ev.eventId, sha(raw)]);
        if (!ins.rowCount) return { outcome: 'duplicate' };
        const done = async (o: string, extra: Record<string, unknown> = {}) => {
          await tx.query('UPDATE esign_webhook_event SET outcome = $3 WHERE provider = $1 AND event_id = $2', [prov.name, ev.eventId, o]);
          await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'esign.webhook', entity: 'esign_request', entityId: (extra.requestId as string) ?? null, diff: { provider: prov.name, eventId: ev.eventId, kind: ev.kind, outcome: o } });
          return { outcome: o, ...extra };
        };
        const it = (await tx.query(`SELECT i.*, r.mode FROM esign_item i JOIN esign_request r ON r.id = i.request_id WHERE i.provider_txn_id = $1 FOR UPDATE OF i`, [ev.txnId])).rows[0];
        if (!it) return done('unknown_txn');
        if (it.status !== 'sent') return done('item_not_open', { requestId: it.request_id });
        const s = (await tx.query('SELECT * FROM esign_signer WHERE id::text = $1 AND item_id = $2 FOR UPDATE', [ev.signerRef, it.id])).rows[0];
        if (!s) return done('unknown_signer', { requestId: it.request_id });
        if (s.status === 'signed') return done('already_signed', { requestId: it.request_id });
        if (it.mode === 'sequential' && (await tx.query(`SELECT 1 FROM esign_signer WHERE item_id = $1 AND ord < $2 AND status NOT IN ('signed','cancelled') LIMIT 1`, [it.id, s.ord])).rowCount) {
          return done('out_of_order', { requestId: it.request_id });
        }
        if (ev.kind !== 'signed') {
          await tx.query(`UPDATE esign_signer SET status = 'declined', updated_at = now() WHERE id = $1`, [s.id]);
          await tx.query(`UPDATE esign_item SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [it.id, ev.kind === 'declined' ? 'signer_declined' : 'provider_failed']);
          await this.rollup(tx, it.request_id);
          return done(`signer_${ev.kind}`, { requestId: it.request_id });
        }
        await tx.query(`UPDATE esign_signer SET status = 'signed', signed_at = $2, masked_id = $3, signer_name_as_per_id = $4, updated_at = now() WHERE id = $1`,
          [s.id, ev.at ?? this.clock.now(), ev.maskedId, ev.nameAsPerId?.slice(0, 200) ?? null]);
        const left = (await tx.query(`SELECT count(*)::int AS n FROM esign_signer WHERE item_id = $1 AND status NOT IN ('signed','cancelled')`, [it.id])).rows[0].n;
        let messages: string[] = [];
        if (left && it.mode === 'sequential') messages = (await this.notifyDue(tx, tenantId, it.id, null)).messages;
        return { ...(await done('signed', { requestId: it.request_id })), finalize: left === 0 ? (it.id as string) : null, messages };
      });
      results.push({ eventId: ev.eventId, outcome: r.outcome });
      for (const m of (r as { messages?: string[] }).messages ?? []) await this.comm.deliverNow(tenantId, m, this.clock.now());
      const fin = (r as { finalize?: string | null }).finalize;
      if (fin) await this.finalize(tenantId, fin);
    }
    return { received: events.length, results };
  }

  /** All signed: store the provider's signed file as a new version of the document + an audit-trail certificate (separate document, D119). */
  private async finalize(tenantId: string, itemId: string) {
    const sys = systemActor(tenantId);
    const it = await this.db.tenantTx(tenantId, async (tx) => {
      const it = (await tx.query(`SELECT i.*, d.name AS doc_name, d.fy, v.storage_key, t.name AS firm_name, r.provider FROM esign_item i JOIN document d ON d.id = i.document_id
        JOIN document_version v ON v.document_id = i.document_id AND v.version = i.document_version JOIN tenant t ON t.id = i.tenant_id JOIN esign_request r ON r.id = i.request_id WHERE i.id = $1`, [itemId])).rows[0];
      const signers = (await tx.query(`SELECT name, kind, masked_id, signer_name_as_per_id, signed_at FROM esign_signer WHERE item_id = $1 AND status = 'signed' ORDER BY ord, signed_at`, [itemId])).rows;
      return { ...it, signers };
    });
    try {
      const original = await toBuffer(await this.storage.get(it.storage_key));
      if (sha(original) !== it.original_sha256) throw new Error('original_hash_mismatch');
      const signed = await this.provider().fetchSigned(it.provider_txn_id, original);
      const up = await this.docs.upload(sys, { buffer: signed, mimetype: 'application/pdf', originalname: it.doc_name, size: signed.length },
        { documentId: it.document_id, note: `e-signed (${it.provider} txn ${it.provider_txn_id})` }, null);
      const cert = await certificatePdf({ firm: it.firm_name, document: it.doc_name, version: it.document_version, signedVersion: up.version, originalSha256: it.original_sha256,
        signedSha256: sha(signed), provider: it.provider, txnId: it.provider_txn_id, generatedAt: this.clock.now(),
        signers: it.signers.map((s: Record<string, unknown>) => ({ name: s.name as string, kind: s.kind as string, maskedId: (s.masked_id as string) ?? null, nameAsPerId: (s.signer_name_as_per_id as string) ?? null, at: s.signed_at as Date })) });
      const c = await this.docs.upload(sys, { buffer: cert, mimetype: 'application/pdf', originalname: `E-sign certificate — ${it.doc_name}.pdf`.slice(0, 280), size: cert.length },
        { clientId: it.client_id, fy: it.fy, category: 'E-sign certificates', tags: ['esign', String(it.provider_txn_id)] }, null);
      await this.db.tenantTx(tenantId, async (tx) => {
        await tx.query(`UPDATE esign_item SET status = 'signed', signed_version = $2, certificate_document_id = $3, signed_sha256 = $4, updated_at = now() WHERE id = $1`, [itemId, up.version, c.id, sha(signed)]);
        await this.rollup(tx, it.request_id);
        await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'esign.completed', entity: 'esign_request', entityId: it.request_id,
          diff: { itemId, documentId: it.document_id, signedVersion: up.version, certificateDocumentId: c.id, originalSha256: it.original_sha256, signedSha256: sha(signed) } });
        const owner = (await tx.query('SELECT created_by FROM esign_request WHERE id = $1', [it.request_id])).rows[0]?.created_by;
        if (owner) {
          const r = await insertNotifications(tx, tenantId, { userIds: [owner], category: 'esign.request', title: `Signed: ${String(it.doc_name).slice(0, 150)}`, entityType: 'esign_request', entityId: it.request_id, dedupeKey: `esign-done:${itemId}` });
          if (r.cursor) this.realtime.publish({ type: 'changed', tenantId, cursor: r.cursor });
        }
      });
    } catch (e) {
      await this.db.tenantTx(tenantId, async (tx) => {
        await tx.query(`UPDATE esign_item SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [itemId, `finalize: ${String((e as Error).message).slice(0, 200)}`]);
        await this.rollup(tx, it.request_id);
      });
    }
  }
}

export async function certificatePdf(c: { firm: string; document: string; version: number; signedVersion: number; originalSha256: string; signedSha256: string; provider: string; txnId: string;
  generatedAt: Date; signers: Array<{ name: string; kind: string; maskedId: string | null; nameAsPerId: string | null; at: Date }> }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `E-sign audit trail — ${c.document}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<void>((r) => doc.on('end', () => r()));
  doc.fontSize(14).text(c.firm, { align: 'center' }).moveDown(0.3).fontSize(12).text('E-signature audit trail certificate', { align: 'center' }).moveDown();
  const row = (k: string, v: string) => doc.fontSize(9).font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(v);
  row('Document', c.document); row('Original version', String(c.version)); row('Signed version', String(c.signedVersion));
  row('SHA-256 of original', c.originalSha256); row('SHA-256 of signed file', c.signedSha256); row('Provider', c.provider); row('Provider transaction', c.txnId);
  doc.moveDown(0.5).font('Helvetica-Bold').text('Signers').font('Helvetica');
  c.signers.forEach((s, n) => doc.text(`${n + 1}. ${s.name} (${s.kind})${s.nameAsPerId ? ` — name as per ID: ${s.nameAsPerId}` : ''}${s.maskedId ? ` — ID ${s.maskedId}` : ''} — signed ${fmtIst(new Date(s.at))}`));
  doc.moveDown().fontSize(8).text(`Generated ${fmtIst(c.generatedAt)}. Hashes let anyone check the files have not changed since signing.`);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
