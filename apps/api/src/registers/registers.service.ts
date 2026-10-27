import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { can, clientCtx } from '@worko/domain';
import PDFDocument from 'pdfkit';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, Params } from '../clients/scope.js';
import { DbService } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { DocumentsService } from '../documents/documents.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { visibilityOf } from '../sync/registry.js';
import { SyncService } from '../sync/sync.service.js';
import type { Readable } from 'node:stream';

export type Kind = 'inward' | 'outward';
const TABLE: Record<Kind, 'inward_entry' | 'outward_entry'> = { inward: 'inward_entry', outward: 'outward_entry' };
const DATE: Record<Kind, string> = { inward: 'received_on', outward: 'sent_on' };

@Injectable()
export class RegistersService {
  constructor(private db: DbService, private sync: SyncService, private realtime: RealtimeService, private audit: AuditService, private docs: DocumentsService) {}

  list(a: RequestActor, kind: Kind, q: { q?: string; clientId?: string; from?: string; to?: string; pending?: boolean; limit: number; offset: number }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params(); const t = TABLE[kind]; const d = DATE[kind];
      const where = ['e.deleted_at IS NULL', 'c.deleted_at IS NULL', clientScopeSql(a, 'clients', 'view', p), clientScopeSql(a, 'registers', 'view', p)];
      if (q.clientId) where.push(`e.client_id = ${p.add(q.clientId)}`);
      if (q.from) where.push(`e.${d} >= ${p.add(q.from)}`);
      if (q.to) where.push(`e.${d} <= ${p.add(q.to)}`);
      if (q.pending) where.push(kind === 'inward' ? 'e.returnable AND e.returned_on IS NULL' : 'e.to_be_received_back AND e.received_back_on IS NULL');
      if (q.q) {
        const term = p.add(q.q);
        const person = kind === 'inward' ? 'e.from_name' : 'e.to_name'; const phone = kind === 'inward' ? 'e.from_phone' : 'e.to_phone';
        where.push(`(e.number ILIKE '%' || ${term} || '%' OR e.description ILIKE '%' || ${term} || '%' OR ${person} ILIKE '%' || ${term} || '%'
          OR ${phone} LIKE '%' || ${term} || '%' OR c.name ILIKE '%' || ${term} || '%'${kind === 'outward' ? ` OR e.tracking_no ILIKE '%' || ${term} || '%'` : ''})`);
      }
      const rows = (await tx.query(`SELECT e.*, c.name AS client_name, count(*) OVER () AS total FROM ${t} e JOIN client c ON c.id = e.client_id
        WHERE ${where.join(' AND ')} ORDER BY e.${d} DESC, e.number DESC LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`, p.values)).rows;
      return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total: _t, tenant_id: _x, field_versions: _f, ...r }) => r) };
    });
  }

  async create(a: RequestActor, kind: Kind, patch: Record<string, unknown>) {
    const id = uuidv7();
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const res = await this.sync.applyInTx(tx, a, { table: TABLE[kind], id, baseVersion: 0, patch });
      return { ...res, number: (await tx.query(`SELECT number FROM ${TABLE[kind]} WHERE id = $1`, [id])).rows[0].number as string };
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r.cursor });
    return { id, number: r.number };
  }

  async update(a: RequestActor, kind: Kind, id: string, patch: Record<string, unknown>) {
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const cur = (await tx.query(`SELECT version FROM ${TABLE[kind]} WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
      if (!cur) throw new NotFoundException();
      return this.sync.applyInTx(tx, a, { table: TABLE[kind], id, baseVersion: cur.version, patch });
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r.cursor });
  }

  private async entry(a: RequestActor, kind: Kind, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params([id]);
      const e = (await tx.query(`SELECT e.*, c.name AS client_name, t.name AS firm_name FROM ${TABLE[kind]} e JOIN client c ON c.id = e.client_id JOIN tenant t ON t.id = e.tenant_id
        WHERE e.id = $1 AND e.deleted_at IS NULL AND c.deleted_at IS NULL AND ${clientScopeSql(a, 'clients', 'view', p)} AND ${clientScopeSql(a, 'registers', 'view', p)}`, p.values)).rows[0];
      if (!e) throw new NotFoundException();
      return e;
    });
  }

  /** Signature (drawn on phone/tablet) stored as a client document and linked to the entry. */
  async attachSignature(a: RequestActor, kind: Kind, id: string, file: { buffer: Buffer; mimetype: string; originalname: string; size: number }) {
    const e = await this.entry(a, kind, id);
    const ctx = await this.db.tenantTx(a.tenantId, async (tx) => clientCtx(visibilityOf((await tx.query('SELECT * FROM client WHERE id = $1', [e.client_id])).rows[0])));
    if (!can(a, 'registers', 'edit', ctx)) throw new ForbiddenException();
    const doc = await this.docs.upload(a, { ...file, originalname: `Signature ${e.number}.png` },
      { clientId: e.client_id, category: 'Signatures', fy: e.fy, tags: [kind, e.number] }, null);
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const res = await this.sync.serverPatch(tx, a, TABLE[kind], id, { signature_doc_id: doc.id });
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: `${TABLE[kind]}.signed`, entity: TABLE[kind], entityId: id, diff: { documentId: doc.id } });
      return res;
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r?.cursor ?? 0 });
    return { documentId: doc.id };
  }

  /** Printable receipt (A5) — the paper the giver/receiver signs, or a PDF to send on WhatsApp/email. */
  async receipt(a: RequestActor, kind: Kind, id: string): Promise<{ name: string; pdf: Buffer }> {
    const e = await this.entry(a, kind, id);
    let signature: Buffer | null = null;
    if (e.signature_doc_id) {
      const url = await this.docs.downloadUrl(a, e.signature_doc_id).catch(() => null);
      if (url) {
        const f = await this.docs.openSigned(url.url.split('/').pop()!, null);
        signature = await streamToBuffer(f.stream);
      }
    }
    const doc = new PDFDocument({ size: 'A5', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((r) => doc.on('end', () => r()));
    const title = kind === 'inward' ? 'Inward receipt — documents received' : 'Outward receipt — documents handed over';
    doc.fontSize(14).text(e.firm_name, { align: 'center' }).moveDown(0.3).fontSize(11).text(title, { align: 'center' }).moveDown();
    const row = (k: string, v: unknown) => { if (v) doc.fontSize(9).font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(String(v)); };
    row('Number', e.number);
    row('Date', (e[DATE[kind]] as Date).toISOString().slice(0, 10));
    row('Client', e.client_name);
    row(kind === 'inward' ? 'Received from' : 'Handed to', [kind === 'inward' ? e.from_name : e.to_name, kind === 'inward' ? e.from_phone : e.to_phone].filter(Boolean).join(', '));
    row('Mode', e.mode);
    if (kind === 'outward') { row('Courier', e.courier_name); row('Tracking no.', e.tracking_no); }
    row('Description', e.description);
    const items = (e.items ?? []) as Array<{ description: string; qty: number; original: boolean }>;
    if (items.length) {
      doc.moveDown(0.5).font('Helvetica-Bold').text('Items').font('Helvetica');
      items.forEach((it, n) => doc.text(`${n + 1}. ${it.description} × ${it.qty}${it.original ? ' (original)' : ''}`));
    }
    if (kind === 'inward' && e.returnable) row('To be returned by', e.due_back ? (e.due_back as Date).toISOString().slice(0, 10) : 'on completion');
    if (kind === 'outward' && e.to_be_received_back) row('To be received back', 'Yes');
    doc.moveDown(2);
    if (signature) { try { doc.image(signature, { fit: [160, 60] }); } catch { /* unsupported image type */ } }
    doc.fontSize(9).text('Signature', { underline: false }).moveDown(0.2).text('____________________________');
    doc.end();
    await done;
    return { name: `${e.number.replace(/\//g, '-')}.pdf`, pdf: Buffer.concat(chunks) };
  }
}

async function streamToBuffer(s: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(parts);
}
