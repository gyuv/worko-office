import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { maskAddress, normalizeAddress, PORTAL_INBOX_CATEGORY, portalGrantsSchema, PROFILE_FIELDS, type CommChannel } from '@worko/domain';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AuditService } from '../audit/audit.service.js';
import type { PortalActor } from '../auth/context.js';
import { CollectionsService } from '../billing/collections.service.js';
import { InvoicesService } from '../billing/invoices.service.js';
import { publicBase } from '../billing/providers.js';
import { Params } from '../clients/scope.js';
import { CommService } from '../comm/comm.service.js';
import { Clock } from '../common/clock.js';
import { KeyService } from '../crypto/key.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { DocumentsService } from '../documents/documents.service.js';
import { signerLink } from '../practice/esign.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { STORAGE, type StorageAdapter } from '../storage/storage.js';
import { SyncService } from '../sync/sync.service.js';
import { systemActor } from '../tasks/system-actor.js';
import { clientStaff, loadAccess, loadPortalSettings, notifyStaff, portalDocSql, portalWriter, type Access } from './common.js';

type Upload = { buffer: Buffer; mimetype: string; originalname: string; size: number };
const n = (x: unknown) => Number(x ?? 0);
const fileKey = () => createHash('sha256').update(`portal-download:${process.env.JWT_SIGNING_KEY ?? 'worko-dev-only-signing-key'}`).digest();

/**
 * Everything a portal user sees or does (D128). Every query is scoped by `loadAccess` (user × client grant) and returns
 * client-facing fields only: no internal notes, staff-only documents, assignees, time, cost or other clients' rows.
 * Ungranted areas and invisible rows answer 404.
 */
@Injectable()
export class PortalService {
  constructor(private db: DbService, private audit: AuditService, private docs: DocumentsService, private realtime: RealtimeService, private sync: SyncService,
    private invoices: InvoicesService, private collections: CollectionsService, private comm: CommService, private keys: KeyService, private clock: Clock,
    @Inject(STORAGE) private storage: StorageAdapter) {}

  private publish(tenantId: string, cursor: number) { if (cursor) this.realtime.publish({ type: 'changed', tenantId, cursor }); }

  private rec(tx: Tx, p: PortalActor, action: string, entity: string, entityId: string | null, diff: Record<string, unknown> = {}) {
    return this.audit.record(tx, p.tenantId, { actorId: null, deviceId: `portal:${p.sessionId}`, action, entity, entityId: entityId ?? undefined, diff: { portalUserId: p.portalUserId, ...diff } });
  }

  // ---------- Me / dashboard ----------
  me(p: PortalActor) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      const clients = (await tx.query(`SELECT c.id, c.name, a.grants FROM portal_access a JOIN client c ON c.id = a.client_id
        WHERE a.portal_user_id = $1 AND a.revoked_at IS NULL AND c.portal_enabled AND c.deleted_at IS NULL ORDER BY c.name`, [p.portalUserId])).rows;
      const s = await loadPortalSettings(tx);
      const t = (await tx.query('SELECT name, slug FROM tenant WHERE id = current_tenant()')).rows[0];
      return {
        user: { id: p.portalUserId, name: p.name, email: p.email, phone: p.phone },
        clients: clients.map((c) => ({ id: c.id, name: c.name, grants: portalGrantsSchema.parse(c.grants ?? {}) })),
        branding: { firm: t.slug, displayName: s.displayName ?? t.name, accent: s.accent, logoUrl: s.logoDocumentId ? `/v1/portal/branding/${t.slug}/logo` : null,
          supportEmail: s.supportEmail, supportPhone: s.supportPhone, welcomeText: s.welcomeText },
      };
    });
  }

  dashboard(p: PortalActor, clientId: string) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      const acc = await loadAccess(tx, p, clientId);
      const g = acc.grants; const today = this.clock.todayIst();
      const out: Record<string, unknown> = { client: { id: acc.client.id, name: acc.client.name } };
      if (g.requests) out.pendingRequests = await this.requestRows(tx, clientId);
      if (g.invoices) {
        const r = (await tx.query(`SELECT id, number, due_date AS "dueDate", balance_paise FROM invoice WHERE client_id = $1 AND kind = 'invoice' AND status IN ('issued','partially_paid') AND deleted_at IS NULL ORDER BY due_date`, [clientId])).rows;
        out.outstanding = { totalPaise: r.reduce((s, x) => s + n(x.balance_paise), 0), invoices: r.map(({ balance_paise, ...x }) => ({ ...x, balancePaise: n(balance_paise) })) };
      }
      if (g.documents.enabled) {
        const pp = new Params([clientId]);
        out.recentDocuments = (await tx.query(`SELECT d.id, d.name, d.category, d.fy, d.created_at AS "createdAt" FROM document d WHERE d.client_id = $1 AND ${portalDocSql(g, (v) => pp.add(v))}
          ORDER BY d.created_at DESC LIMIT 5`, pp.values)).rows;
      }
      // Due dates of visible compliance items (statutory due only; no assignees, effort or internal status).
      if (g.compliance) {
        out.upcomingDueDates = (await tx.query(`SELECT t.title, t.period_label AS "periodLabel", t.statutory_due AS "dueDate" FROM task t WHERE t.client_id = $1 AND t.deleted_at IS NULL
          AND t.outcome IS NULL AND t.status NOT IN ('done','cancelled') AND t.statutory_due >= $2::date ORDER BY t.statutory_due LIMIT 10`, [clientId, today])).rows;
      }
      if (g.esign) out.pendingSignatures = (await this.esignRows(tx, p, acc)).length;
      return out;
    });
  }

  // ---------- Documents ----------
  documents(p: PortalActor, clientId: string, q: { fy?: string; category?: string }) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      const acc = await loadAccess(tx, p, clientId, 'documents');
      const pp = new Params([clientId]);
      const where = [`d.client_id = $1`, portalDocSql(acc.grants, (v) => pp.add(v))];
      if (q.fy) where.push(`d.fy = ${pp.add(q.fy)}`);
      if (q.category) where.push(`lower(d.category) = lower(${pp.add(q.category)})`);
      return (await tx.query(`SELECT d.id, d.name, d.category, d.fy, d.mime, d.size, d.current_version AS "currentVersion", d.created_at AS "createdAt", d.source = 'portal' AS "fromClient"
        FROM document d WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 500`, pp.values)).rows.map((r) => ({ ...r, size: n(r.size) }));
    });
  }

  private async visibleDoc(tx: Tx, acc: Access, docId: string) {
    const pp = new Params([acc.clientId, docId]);
    const d = (await tx.query(`SELECT d.* FROM document d WHERE d.client_id = $1 AND d.id = $2 AND ${portalDocSql(acc.grants, (v) => pp.add(v))}`, pp.values)).rows[0];
    if (!d) throw new NotFoundException();
    return d;
  }

  /** 2-minute signed URL bound to this portal session (logout/revocation kills it). */
  downloadUrl(p: PortalActor, clientId: string, docId: string) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      const acc = await loadAccess(tx, p, clientId, 'documents');
      const d = await this.visibleDoc(tx, acc, docId);
      const payload = Buffer.from(JSON.stringify({ t: p.tenantId, c: clientId, d: d.id, v: d.current_version, u: p.portalUserId, s: p.sessionId, e: Date.now() + 120_000 })).toString('base64url');
      return { url: `/v1/portal/files/${payload}.${createHmac('sha256', fileKey()).update(payload).digest('base64url')}`, expiresInSeconds: 120 };
    });
  }

  async openFile(token: string, ip: string | null): Promise<{ name: string; mime: string; size: number; stream: Readable }> {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) throw new NotFoundException();
    const expect = createHmac('sha256', fileKey()).update(payload).digest(); const got = Buffer.from(sig, 'base64url');
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) throw new NotFoundException();
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { t: string; c: string; d: string; v: number; u: string; s: string; e: number };
    if (t.e < Date.now()) throw new NotFoundException();
    return this.db.tenantTx(t.t, async (tx) => {
      const live = (await tx.query(`SELECT u.name, u.email, u.phone FROM portal_session s JOIN portal_user u ON u.id = s.portal_user_id WHERE s.id = $1 AND s.portal_user_id = $2 AND s.revoked_at IS NULL AND u.status = 'active'`, [t.s, t.u])).rows[0];
      if (!live) throw new NotFoundException();
      const p: PortalActor = { tenantId: t.t, portalUserId: t.u, sessionId: t.s, name: live.name, email: live.email, phone: live.phone };
      const acc = await loadAccess(tx, p, t.c, 'documents'); // grants re-checked at download time
      await this.visibleDoc(tx, acc, t.d);
      const v = (await tx.query(`SELECT d.name, v.storage_key, v.mime, v.size FROM document d JOIN document_version v ON v.document_id = d.id AND v.version = $2 WHERE d.id = $1`, [t.d, t.v])).rows[0];
      if (!v) throw new NotFoundException();
      await tx.query(`INSERT INTO document_access_log (tenant_id, document_id, user_id, action, ip) VALUES ($1,$2,NULL,'portal_download',$3)`, [t.t, t.d, ip]);
      return { name: v.name, mime: v.mime, size: n(v.size), stream: await this.storage.get(v.storage_key) };
    });
  }

  /**
   * Client upload → the client's "From client" inbox category (never overwrites: always a new document), virus-scanned and
   * type/size-checked by DocumentsService; staff are notified and devices pick it up through sync (realtime cursor).
   */
  async upload(p: PortalActor, clientId: string, file: Upload, m: { name?: string; fy?: string; note?: string }, ip: string | null, notify = true) {
    await this.db.tenantTx(p.tenantId, (tx) => loadAccess(tx, p, clientId, 'documents'));
    const doc = await this.docs.upload(portalWriter(p), file, { clientId, category: PORTAL_INBOX_CATEGORY, fy: m.fy ?? null, name: m.name, note: m.note,
      tags: ['portal'], source: 'portal', portalUserId: p.portalUserId, clientVisible: false }, ip);
    if (notify) {
      const cur = await this.db.tenantTx(p.tenantId, async (tx) => {
        const acc = await loadAccess(tx, p, clientId, 'documents');
        await this.rec(tx, p, 'portal.document_uploaded', 'document', doc.id, { clientId });
        return notifyStaff(tx, p.tenantId, clientStaff(acc.client), { category: 'client.uploaded', title: `${acc.client.name} uploaded a document`, body: 'Received through the client portal',
          entityType: 'document', entityId: doc.id, dedupeKey: `portal-upload:${doc.id}` });
      });
      this.publish(p.tenantId, cur);
    }
    return { id: doc.id };
  }

  // ---------- Requests (PBC items + tasks waiting on the client) ----------
  private async requestRows(tx: Tx, clientId: string) {
    const pbc = (await tx.query(`SELECT i.id, i.title, i.description, i.due_date AS "dueDate", i.status, i.rejection_reason AS "rejectionReason", e.fy, e.audit_type AS "auditType"
      FROM pbc_item i JOIN audit_engagement e ON e.id = i.engagement_id WHERE i.client_id = $1 AND i.deleted_at IS NULL AND i.status IN ('requested','rejected') ORDER BY i.due_date NULLS LAST, i.created_at`, [clientId])).rows;
    const tasks = (await tx.query(`SELECT id, title, period_label AS "periodLabel", pending_issue AS "issue", statutory_due AS "dueDate" FROM task
      WHERE client_id = $1 AND status = 'pending_client' AND outcome IS NULL AND deleted_at IS NULL ORDER BY statutory_due NULLS LAST, created_at`, [clientId])).rows;
    return [...pbc.map((r) => ({ kind: 'pbc' as const, ...r })), ...tasks.map((r) => ({ kind: 'task' as const, ...r }))];
  }

  requests(p: PortalActor, clientId: string) {
    return this.db.tenantTx(p.tenantId, async (tx) => { await loadAccess(tx, p, clientId, 'requests'); return this.requestRows(tx, clientId); });
  }

  /** Client answers a request with a message and/or a file: PBC item → received; task → back to in progress (serverPatch); assignee notified. */
  async respond(p: PortalActor, clientId: string, kind: 'pbc' | 'task', id: string, b: { message?: string }, file: Upload | undefined, ip: string | null) {
    if (!b.message?.trim() && !file) throw new BadRequestException({ message: 'Add a message or a file', code: 'empty_response' });
    // Check the request is open and visible before storing anything.
    await this.db.tenantTx(p.tenantId, async (tx) => { await loadAccess(tx, p, clientId, 'requests'); await this.openRequest(tx, clientId, kind, id); });
    let docId: string | null = null;
    if (file) {
      const acc = await this.db.tenantTx(p.tenantId, (tx) => loadAccess(tx, p, clientId));
      if (!acc.grants.documents.enabled) throw new NotFoundException();
      docId = (await this.upload(p, clientId, file, { note: `Response to ${kind} request` }, ip, false)).id;
    }
    const now = this.clock.now();
    const cur = await this.db.tenantTx(p.tenantId, async (tx) => {
      const acc = await loadAccess(tx, p, clientId, 'requests');
      const row = await this.openRequest(tx, clientId, kind, id, true);
      let c = 0; let notify: string[]; let title: string;
      if (kind === 'pbc') {
        await tx.query(`UPDATE pbc_item SET status = 'received', received_at = $2, responded_at = $2, client_response = $3, document_ids = CASE WHEN $4::uuid IS NULL THEN document_ids ELSE array_append(document_ids, $4::uuid) END,
          version = version + 1, updated_at = now() WHERE id = $1`, [id, now, b.message?.trim() || null, docId]);
        const e = (await tx.query('SELECT manager_id, partner_id FROM audit_engagement WHERE id = $1', [row.engagement_id])).rows[0];
        notify = [e?.manager_id, e?.partner_id, row.created_by].filter(Boolean);
        title = `${acc.client.name} answered: ${String(row.title).slice(0, 120)}`;
      } else {
        const r = await this.sync.serverPatch(tx, portalWriter(p), 'task', id, { status: 'in_progress' });
        c = r?.cursor ?? 0;
        notify = [row.assignee_id, row.manager_id].filter(Boolean);
        if (!notify.length) notify = clientStaff(acc.client);
        title = `${acc.client.name} responded: ${String(row.title).slice(0, 120)}`;
      }
      // The reply lands on the client timeline (portal thread) so the whole team sees it.
      const msgId = uuidv7();
      await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, contact_id, direction, channel, subject, body, status, meta, portal_user_id, document_ids, occurred_at, device_id)
        VALUES ($1,$2,$3,$4,'in','portal',$5,$6,'received',$7,$8,$9,$10,'portal')`,
        [msgId, p.tenantId, clientId, acc.contactId, `Re: ${String(row.title).slice(0, 180)}`, b.message?.trim() ?? '', JSON.stringify({ [kind === 'pbc' ? 'pbcItemId' : 'taskId']: id }), p.portalUserId, docId ? [docId] : [], now]);
      await this.rec(tx, p, 'portal.request_answered', kind === 'pbc' ? 'pbc_item' : 'task', id, { clientId, documentId: docId, messageId: msgId, length: b.message?.length ?? 0 });
      c = Math.max(c, await notifyStaff(tx, p.tenantId, notify, { category: 'portal.response', priority: 'high', title, body: b.message?.slice(0, 300) ?? 'A file was uploaded',
        entityType: kind === 'pbc' ? 'pbc_item' : 'task', entityId: id, dedupeKey: `portal-response:${msgId}` }));
      return c;
    });
    this.publish(p.tenantId, cur);
    return { status: kind === 'pbc' ? 'received' : 'in_progress', documentId: docId };
  }

  private async openRequest(tx: Tx, clientId: string, kind: 'pbc' | 'task', id: string, lock = false) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException();
    const r = kind === 'pbc'
      ? (await tx.query(`SELECT * FROM pbc_item WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL AND status IN ('requested','rejected') ${lock ? 'FOR UPDATE' : ''}`, [id, clientId])).rows[0]
      : (await tx.query(`SELECT * FROM task WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL AND status = 'pending_client' AND outcome IS NULL ${lock ? 'FOR UPDATE' : ''}`, [id, clientId])).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }

  // ---------- Invoices, payments, receipts ----------
  invoiceList(p: PortalActor, clientId: string) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      await loadAccess(tx, p, clientId, 'invoices');
      return (await tx.query(`SELECT id, kind, number, status, issue_date AS "issueDate", due_date AS "dueDate", total_paise, balance_paise FROM invoice
        WHERE client_id = $1 AND status IN ('issued','partially_paid','paid') AND deleted_at IS NULL ORDER BY issue_date DESC, number DESC LIMIT 500`, [clientId])).rows
        .map(({ total_paise, balance_paise, ...r }) => ({ ...r, totalPaise: n(total_paise), balancePaise: n(balance_paise) }));
    });
  }

  private async invoiceRow(tx: Tx, clientId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException();
    const i = (await tx.query(`SELECT * FROM invoice WHERE id = $1 AND client_id = $2 AND status IN ('issued','partially_paid','paid') AND deleted_at IS NULL`, [id, clientId])).rows[0];
    if (!i) throw new NotFoundException();
    return i;
  }

  invoice(p: PortalActor, clientId: string, id: string) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      const acc = await loadAccess(tx, p, clientId, 'invoices');
      const i = await this.invoiceRow(tx, clientId, id);
      const lines = (await tx.query(`SELECT description, sac, qty, rate_paise, discount_paise, gst_rate, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise FROM invoice_line WHERE invoice_id = $1 ORDER BY sort, id`, [id])).rows;
      const link = acc.grants.payments ? (await tx.query(`SELECT url, amount_paise FROM payment_link WHERE invoice_id = $1 AND status = 'created' ORDER BY created_at DESC LIMIT 1`, [id])).rows[0] : null;
      return {
        id: i.id, kind: i.kind, number: i.number, status: i.status, issueDate: i.issue_date, dueDate: i.due_date, placeOfSupply: i.place_of_supply,
        taxablePaise: n(i.taxable_paise), cgstPaise: n(i.cgst_paise), sgstPaise: n(i.sgst_paise), igstPaise: n(i.igst_paise), totalPaise: n(i.total_paise), balancePaise: n(i.balance_paise),
        lines: lines.map((l) => ({ description: l.description, sac: l.sac, qty: Number(l.qty), ratePaise: n(l.rate_paise), discountPaise: n(l.discount_paise), gstRate: Number(l.gst_rate),
          taxablePaise: n(l.taxable_paise), taxPaise: n(l.cgst_paise) + n(l.sgst_paise) + n(l.igst_paise), totalPaise: n(l.total_paise) })),
        payable: acc.grants.payments && ['issued', 'partially_paid'].includes(i.status) && n(i.balance_paise) > 0, paymentUrl: link?.url ?? null,
      };
    });
  }

  async invoicePdf(p: PortalActor, clientId: string, id: string) {
    await this.db.tenantTx(p.tenantId, async (tx) => { await loadAccess(tx, p, clientId, 'invoices'); await this.invoiceRow(tx, clientId, id); });
    return this.invoices.pdf(null, p.tenantId, id);
  }

  /** Pay online: reuse the live link for the current balance, else create one through the payment provider (webhook records the receipt). */
  async pay(p: PortalActor, clientId: string, id: string) {
    const existing = await this.db.tenantTx(p.tenantId, async (tx) => {
      await loadAccess(tx, p, clientId, 'payments');
      const i = await this.invoiceRow(tx, clientId, id);
      if (!['issued', 'partially_paid'].includes(i.status) || n(i.balance_paise) <= 0) throw new ConflictException({ message: 'Nothing to pay', code: 'invoice_not_open' });
      const l = (await tx.query(`SELECT id, url, amount_paise, provider FROM payment_link WHERE invoice_id = $1 AND status = 'created' AND amount_paise = $2 ORDER BY created_at DESC LIMIT 1`, [id, i.balance_paise])).rows[0];
      await this.rec(tx, p, 'portal.payment_started', 'invoice', id, { clientId, reused: !!l });
      return l ? { id: l.id as string, url: l.url as string, amountPaise: n(l.amount_paise), provider: l.provider as string } : null;
    });
    return existing ?? this.collections.paymentLink({ ...systemActor(p.tenantId), deviceId: `portal:${p.sessionId}` }, id);
  }

  receipts(p: PortalActor, clientId: string) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      const acc = await loadAccess(tx, p, clientId);
      if (!acc.grants.payments && !acc.grants.invoices) throw new NotFoundException();
      const rows = (await tx.query(`SELECT r.id, r.number, r.received_on AS "receivedOn", r.amount_paise, r.tds_paise, r.mode,
          coalesce((SELECT json_agg(json_build_object('invoiceNumber', i.number, 'amountPaise', a.amount_paise)) FROM receipt_allocation a JOIN invoice i ON i.id = a.invoice_id WHERE a.receipt_id = r.id), '[]') AS allocations
        FROM receipt r WHERE r.client_id = $1 AND r.deleted_at IS NULL ORDER BY r.received_on DESC, r.number DESC LIMIT 500`, [clientId])).rows;
      return rows.map(({ amount_paise, tds_paise, allocations, ...r }) => ({ ...r, amountPaise: n(amount_paise), tdsPaise: n(tds_paise),
        allocations: (allocations as Array<{ invoiceNumber: string; amountPaise: number }>).map((x) => ({ invoiceNumber: x.invoiceNumber, amountPaise: n(x.amountPaise) })) }));
    });
  }

  // ---------- Messages (portal thread on the client timeline) ----------
  messages(p: PortalActor, clientId: string) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      await loadAccess(tx, p, clientId, 'messages');
      return (await tx.query(`SELECT m.id, m.direction, m.subject, m.body, m.occurred_at AS "at", m.document_ids AS "documentIds",
          CASE WHEN m.direction = 'in' THEN coalesce(pu.name, 'Client') ELSE coalesce(u.name, 'Firm') END AS "from"
        FROM comm_message m LEFT JOIN portal_user pu ON pu.id = m.portal_user_id LEFT JOIN app_user u ON u.id = m.created_by
        WHERE m.client_id = $1 AND m.channel = 'portal' AND m.direction IN ('in','out') AND m.deleted_at IS NULL ORDER BY m.occurred_at, m.id LIMIT 500`, [clientId])).rows;
    });
  }

  async postMessage(p: PortalActor, clientId: string, body: string) {
    const now = this.clock.now();
    const out = await this.db.tenantTx(p.tenantId, async (tx) => {
      const acc = await loadAccess(tx, p, clientId, 'messages');
      const id = uuidv7();
      await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, contact_id, direction, channel, body, status, portal_user_id, occurred_at, device_id)
        VALUES ($1,$2,$3,$4,'in','portal',$5,'received',$6,$7,'portal')`, [id, p.tenantId, clientId, acc.contactId, body, p.portalUserId, now]);
      await this.rec(tx, p, 'portal.message_sent', 'comm_message', id, { clientId, length: body.length });
      const c = await notifyStaff(tx, p.tenantId, clientStaff(acc.client), { category: 'portal.message', title: `Message from ${acc.client.name}`, body: body.slice(0, 300),
        entityType: 'client', entityId: clientId, dedupeKey: `portal-msg:${id}` });
      return { id, cursor: c };
    });
    this.publish(p.tenantId, out.cursor);
    return { id: out.id };
  }

  // ---------- E-sign ----------
  private async esignRows(tx: Tx, p: PortalActor, acc: Access) {
    if (!acc.contactId) return [];
    const rows = (await tx.query(`SELECT s.id, s.link_nonce, s.status, s.ord, r.title, r.mode, d.name AS document FROM esign_signer s JOIN esign_item i ON i.id = s.item_id
      JOIN esign_request r ON r.id = s.request_id JOIN document d ON d.id = i.document_id
      WHERE s.contact_id = $1 AND i.client_id = $2 AND i.status = 'sent' AND s.status IN ('pending','notified') ORDER BY r.created_at`, [acc.contactId, acc.clientId])).rows;
    return rows.map((r) => ({ id: r.id, title: r.title, document: r.document, status: r.status, signUrl: `${publicBase()}/esign/sign/${signerLink(p.tenantId, r.id, r.link_nonce)}` }));
  }
  esign(p: PortalActor, clientId: string) {
    return this.db.tenantTx(p.tenantId, async (tx) => this.esignRows(tx, p, await loadAccess(tx, p, clientId, 'esign')));
  }

  // ---------- Notices (off by default) ----------
  notices(p: PortalActor, clientId: string) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      await loadAccess(tx, p, clientId, 'notices');
      return (await tx.query(`SELECT id, authority, level, section, reference_no AS "referenceNo", title, issue_date AS "issueDate", response_due AS "responseDue", status, demand_paise
        FROM notice WHERE client_id = $1 AND deleted_at IS NULL ORDER BY received_on DESC LIMIT 200`, [clientId])).rows.map(({ demand_paise, ...r }) => ({ ...r, demandPaise: n(demand_paise) }));
    });
  }

  // ---------- Profile & consent ----------
  profile(p: PortalActor) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      const contacts = (await tx.query(`SELECT a.client_id AS "clientId", c.name AS "clientName", ct.id AS "contactId", ct.name, ct.email, ct.phone, ct.whatsapp, ct.role
        FROM portal_access a JOIN client c ON c.id = a.client_id LEFT JOIN contact ct ON ct.id = a.contact_id AND ct.deleted_at IS NULL
        WHERE a.portal_user_id = $1 AND a.revoked_at IS NULL AND c.portal_enabled AND c.deleted_at IS NULL ORDER BY c.name`, [p.portalUserId])).rows;
      const addrs = [p.email, p.phone].filter(Boolean);
      const consent = (await tx.query(`SELECT channel, address, status, updated_at AS "updatedAt" FROM comm_consent WHERE address = ANY($1::text[]) ORDER BY channel`, [addrs])).rows;
      const pending = (await tx.query(`SELECT id, client_id AS "clientId", fields, status, created_at AS "createdAt" FROM portal_profile_request WHERE portal_user_id = $1 ORDER BY created_at DESC LIMIT 20`, [p.portalUserId])).rows;
      return { user: { id: p.portalUserId, name: p.name, email: p.email, phone: p.phone }, contacts, consent, requests: pending };
    });
  }

  async profileRequest(p: PortalActor, b: { clientId: string; changes: Partial<Record<(typeof PROFILE_FIELDS)[number], string | null>> }) {
    const fields = Object.keys(b.changes).filter((k) => (PROFILE_FIELDS as readonly string[]).includes(k));
    if (!fields.length) throw new BadRequestException({ message: 'Nothing to change', code: 'no_changes' });
    const out = await this.db.tenantTx(p.tenantId, async (tx) => {
      const acc = await loadAccess(tx, p, b.clientId);
      if (!acc.contactId) throw new ConflictException({ message: 'No contact is linked to your access; ask the firm', code: 'no_contact' });
      const id = uuidv7();
      const enc = await this.keys.encrypt(tx, p.tenantId, JSON.stringify(b.changes), `portal_profile_request:${id}:changes`);
      await tx.query(`INSERT INTO portal_profile_request (id, tenant_id, portal_user_id, client_id, contact_id, fields, changes_enc) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, p.tenantId, p.portalUserId, b.clientId, acc.contactId, fields, enc]);
      await this.rec(tx, p, 'portal.profile_change_requested', 'portal_profile_request', id, { clientId: b.clientId, fields });
      const c = await notifyStaff(tx, p.tenantId, clientStaff(acc.client), { category: 'portal.response', title: `${acc.client.name}: contact details change requested`, body: `Fields: ${fields.join(', ')}`,
        entityType: 'portal_profile_request', entityId: id, dedupeKey: `portal-profile:${id}` });
      return { id, cursor: c };
    });
    this.publish(p.tenantId, out.cursor);
    return { id: out.id, status: 'pending' };
  }

  /** Consent per channel for the signed-in person's own address, recorded with source `portal`. */
  async setConsent(p: PortalActor, b: { clientId: string; channel: CommChannel; status: 'opted_in' | 'opted_out' }) {
    return this.db.tenantTx(p.tenantId, async (tx) => {
      const acc = await loadAccess(tx, p, b.clientId);
      const address = normalizeAddress(b.channel, b.channel === 'email' ? p.email : p.phone);
      if (!address) throw new BadRequestException({ message: 'No address on file for that channel', code: 'no_address' });
      const id = await this.comm.upsertConsent(tx, p.tenantId, { channel: b.channel, address, clientId: b.clientId, contactId: acc.contactId, status: b.status, source: 'portal', by: null, at: this.clock.now() });
      await this.rec(tx, p, `portal.consent_${b.status}`, 'comm_consent', id, { clientId: b.clientId, channel: b.channel, address: maskAddress(address) });
      return { id, channel: b.channel, status: b.status };
    });
  }
}
