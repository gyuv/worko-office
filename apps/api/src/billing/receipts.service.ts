import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { allocateFifo, formatINR, amountInWords, type Allocation, type ReceiptMode } from '@worko/domain';
import PDFDocument from 'pdfkit';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Params } from '../clients/scope.js';
import { DbService, type Tx } from '../db/db.service.js';
import { SyncService } from '../sync/sync.service.js';
import { uuidv7 } from '../db/ids.js';
import { canClient, clientFor, d, entityFor, fyStart, n, nextDocNumber, presentReceipt, scopeSql } from './common.js';
import { Cursor, InvoicesService } from './invoices.service.js';

export type ReceiptIn = {
  clientId: string; entityId?: string | null; receivedOn: string; amountPaise: number; tdsPaise?: number; tdsSection?: string | null;
  mode: ReceiptMode; reference?: string | null; notes?: string | null;
  /** Manual allocation; omitted = FIFO over the client's open invoices (oldest due first); [] = keep it all as an advance. */
  allocations?: Array<{ invoiceId: string; amountPaise: number; tdsPaise?: number }>;
};

@Injectable()
export class ReceiptsService {
  constructor(private db: DbService, private audit: AuditService, private invoices: InvoicesService, private sync: SyncService) {}

  list(a: RequestActor, q: { clientId?: string; from?: string; to?: string; limit: number; offset: number }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = ['r.deleted_at IS NULL', 'c.deleted_at IS NULL', scopeSql(a, 'receipts', 'view', p)];
      if (q.clientId) where.push(`r.client_id = ${p.add(q.clientId)}`);
      if (q.from) where.push(`r.received_on >= ${p.add(q.from)}::date`);
      if (q.to) where.push(`r.received_on <= ${p.add(q.to)}::date`);
      const rows = (await tx.query(`SELECT r.*, c.name AS client_name, count(*) OVER () AS total_count FROM receipt r JOIN client c ON c.id = r.client_id
        WHERE ${where.join(' AND ')} ORDER BY r.received_on DESC, r.number DESC LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`, p.values)).rows;
      return { total: Number(rows[0]?.total_count ?? 0), items: rows.map(presentReceipt) };
    });
  }

  private async rowFor(tx: Tx, a: RequestActor, id: string, action: 'view' | 'edit' | 'print', lock = false) {
    const r = (await tx.query(`SELECT * FROM receipt WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    const c = (await tx.query('SELECT * FROM client WHERE id = $1', [r.client_id])).rows[0];
    if (!c || c.deleted_at || !canClient(a, 'receipts', action, c)) throw new NotFoundException();
    return { rec: r as Record<string, unknown>, client: c as Record<string, unknown> };
  }

  get(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const { rec, client } = await this.rowFor(tx, a, id, 'view');
      const allocations = (await tx.query(`SELECT a.invoice_id, i.number, a.amount_paise, a.tds_paise FROM receipt_allocation a JOIN invoice i ON i.id = a.invoice_id
        WHERE a.receipt_id = $1 ORDER BY a.created_at, a.id`, [id])).rows.map((x) => ({ invoiceId: x.invoice_id, invoiceNumber: x.number, amountPaise: n(x.amount_paise), tdsPaise: n(x.tds_paise) }));
      return { ...presentReceipt({ ...rec, client_name: client.name }), allocations };
    });
  }

  /** Open receivables (invoices + debit notes) of a client, oldest due first — the FIFO order. */
  static async openItems(tx: Tx, clientId: string, entityId?: string | null) {
    return (await tx.query(`SELECT id, balance_paise, entity_id FROM invoice WHERE client_id = $1 AND deleted_at IS NULL AND status IN ('issued','partially_paid')
      AND kind IN ('invoice','debit_note') AND balance_paise > 0 ${entityId ? 'AND entity_id = $2' : ''} ORDER BY due_date, issue_date, number FOR UPDATE`,
      entityId ? [clientId, entityId] : [clientId])).rows.map((r) => ({ id: r.id as string, balancePaise: n(r.balance_paise) }));
  }

  async create(a: RequestActor, i: ReceiptIn) {
    const cur = new Cursor();
    const r = await this.db.tenantTx(a.tenantId, (tx) => this.createTx(tx, a, i, cur));
    this.invoices.publish(a, cur);
    return r;
  }

  /** Records money received (+ TDS deducted by the client) and allocates it; the rest stays as an advance. */
  async createTx(tx: Tx, a: RequestActor, i: ReceiptIn, cur: Cursor, gateway?: { provider: string; paymentId: string }) {
    if (i.amountPaise + (i.tdsPaise ?? 0) <= 0) throw new BadRequestException('Nothing received');
    if ((i.tdsPaise ?? 0) > 0 && !i.tdsSection) throw new BadRequestException({ message: 'TDS section required', code: 'tds_section_required' });
    const client = await clientFor(tx, a, i.clientId, 'receipts', 'create');
    const entity = await entityFor(tx, i.entityId ?? (await this.inferEntity(tx, client.id as string)));
    const id = uuidv7(); const fy = fyStart(i.receivedOn);
    const number = await nextDocNumber(tx, a.tenantId, entity, 'receipt', fy);
    const ins = await tx.query(`INSERT INTO receipt (id, tenant_id, entity_id, client_id, number, fy, received_on, amount_paise, tds_paise, tds_section, mode, reference, notes,
        unallocated_paise, source, provider, provider_payment_id, created_by, updated_by, device_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19) RETURNING sync_cursor`,
      [id, a.tenantId, entity.id, client.id, number, fy, i.receivedOn, i.amountPaise, i.tdsPaise ?? 0, i.tdsSection ?? null, i.mode, i.reference ?? null, i.notes ?? null,
        i.amountPaise + (i.tdsPaise ?? 0), gateway ? 'gateway' : 'manual', gateway?.provider ?? null, gateway?.paymentId ?? null, a.userId, a.deviceId]);
    cur.bump(ins.rows[0].sync_cursor);
    const allocs = await this.allocateTx(tx, a, id, i.allocations, cur);
    await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'receipt.created', entity: 'receipt', entityId: id,
      diff: { number, clientId: i.clientId, amountPaise: i.amountPaise, tdsPaise: i.tdsPaise ?? 0, tdsSection: i.tdsSection ?? null, mode: i.mode, allocations: allocs, gateway: gateway?.provider } });
    return { id, number, allocations: allocs };
  }

  /** Entity of the client's open receivables; ambiguous (open items in several entities) → the caller must say (D82). */
  private async inferEntity(tx: Tx, clientId: string): Promise<string | null> {
    const ents = (await tx.query(`SELECT DISTINCT entity_id FROM invoice WHERE client_id = $1 AND deleted_at IS NULL AND status IN ('issued','partially_paid')
      AND kind IN ('invoice','debit_note') AND balance_paise > 0`, [clientId])).rows.map((r) => r.entity_id as string);
    if (ents.length > 1) throw new BadRequestException({ message: 'Client owes more than one billing entity; choose entityId', code: 'entity_required' });
    return ents[0] ?? null;
  }

  /** Applies a receipt's unallocated amount (an advance) — FIFO by default or as given. */
  async apply(a: RequestActor, id: string, allocations?: ReceiptIn['allocations']) {
    const cur = new Cursor();
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.rowFor(tx, a, id, 'edit', true);
      const allocs = await this.allocateTx(tx, a, id, allocations, cur);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'receipt.applied', entity: 'receipt', entityId: id, diff: { allocations: allocs } });
      return { allocations: allocs };
    });
    this.invoices.publish(a, cur);
    return r;
  }

  private async allocateTx(tx: Tx, a: RequestActor, receiptId: string, manual: ReceiptIn['allocations'], cur: Cursor): Promise<Allocation[]> {
    const rec = (await tx.query('SELECT * FROM receipt WHERE id = $1 FOR UPDATE', [receiptId])).rows[0];
    // Unallocated cash vs TDS: allocations consume TDS first (same rule as FIFO), so the remaining TDS is what was not yet applied.
    const used = (await tx.query('SELECT COALESCE(sum(amount_paise),0) AS amt, COALESCE(sum(tds_paise),0) AS tds FROM receipt_allocation WHERE receipt_id = $1', [receiptId])).rows[0];
    const cashLeft = n(rec.amount_paise) - n(used.amt); const tdsLeft = n(rec.tds_paise) - n(used.tds);
    let allocs: Allocation[];
    if (!manual) {
      allocs = allocateFifo(cashLeft, tdsLeft, await ReceiptsService.openItems(tx, rec.client_id, rec.entity_id)).allocations;
    } else {
      allocs = manual.map((m) => ({ invoiceId: m.invoiceId, amountPaise: m.amountPaise, tdsPaise: m.tdsPaise ?? 0 })).filter((m) => m.amountPaise + m.tdsPaise > 0);
      const cash = allocs.reduce((s, x) => s + x.amountPaise, 0); const tds = allocs.reduce((s, x) => s + x.tdsPaise, 0);
      if (cash > cashLeft || tds > tdsLeft) throw new BadRequestException({ message: 'Allocations exceed the receipt', code: 'over_allocated' });
      const open = new Map((await ReceiptsService.openItems(tx, rec.client_id, rec.entity_id)).map((o) => [o.id, o.balancePaise]));
      for (const x of allocs) {
        const bal = open.get(x.invoiceId);
        if (bal === undefined) throw new BadRequestException({ message: 'Invoice is not open for this client and entity', code: 'invoice_not_open' });
        if (x.amountPaise + x.tdsPaise > bal) throw new ConflictException({ message: 'Allocation exceeds the invoice balance', code: 'over_settled' });
        open.set(x.invoiceId, bal - x.amountPaise - x.tdsPaise);
      }
    }
    for (const x of allocs) {
      await tx.query('INSERT INTO receipt_allocation (id, tenant_id, receipt_id, invoice_id, amount_paise, tds_paise, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [uuidv7(), a.tenantId, receiptId, x.invoiceId, x.amountPaise, x.tdsPaise, a.userId]);
      await this.invoices.recompute(tx, a, x.invoiceId, cur);
    }
    const total = n((await tx.query('SELECT COALESCE(sum(amount_paise + tds_paise),0) AS s FROM receipt_allocation WHERE receipt_id = $1', [receiptId])).rows[0].s);
    if (total !== n(rec.allocated_paise)) {
      cur.bump((await this.sync.serverPatch(tx, a, 'receipt', receiptId, { allocated_paise: total, unallocated_paise: n(rec.amount_paise) + n(rec.tds_paise) - total }))?.cursor);
    }
    return allocs;
  }

  async pdf(a: RequestActor, id: string): Promise<{ name: string; pdf: Buffer }> {
    const { rec, client, e, allocs } = await this.db.tenantTx(a.tenantId, async (tx) => {
      const x = await this.rowFor(tx, a, id, 'print');
      const ent = (await tx.query('SELECT * FROM firm_entity WHERE id = $1', [x.rec.entity_id])).rows[0];
      const al = (await tx.query('SELECT i.number, a.amount_paise, a.tds_paise FROM receipt_allocation a JOIN invoice i ON i.id = a.invoice_id WHERE a.receipt_id = $1 ORDER BY a.created_at', [id])).rows;
      return { ...x, e: ent, allocs: al };
    });
    const doc = new PDFDocument({ size: 'A5', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((r) => doc.on('end', () => r()));
    const m = (p: unknown) => `Rs. ${formatINR(n(p), { symbol: false })}`;
    doc.fontSize(13).font('Helvetica-Bold').text(String(e.name), { align: 'center' }).font('Helvetica').fontSize(8);
    if (e.address) doc.text(String(e.address), { align: 'center' });
    if (e.gstin) doc.text(`GSTIN: ${e.gstin}`, { align: 'center' });
    doc.moveDown(0.5).fontSize(11).text('Payment Receipt', { align: 'center' }).moveDown(0.5).fontSize(9);
    const row = (k: string, v: unknown) => { if (v) doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(String(v)); };
    row('Receipt no.', rec.number); row('Date', d(rec.received_on)); row('Received from', client.name); row('Amount received', m(rec.amount_paise));
    doc.text(amountInWords(n(rec.amount_paise)));
    if (n(rec.tds_paise)) row(`TDS deducted (${rec.tds_section})`, m(rec.tds_paise));
    row('Mode', String(rec.mode).toUpperCase()); row('Reference', rec.reference);
    if (allocs.length) {
      doc.moveDown(0.4).font('Helvetica-Bold').text('Against').font('Helvetica');
      for (const x of allocs) doc.text(`${x.number}: ${m(n(x.amount_paise) + n(x.tds_paise))}${n(x.tds_paise) ? ` (incl. TDS ${m(x.tds_paise)})` : ''}`);
    }
    if (n(rec.unallocated_paise)) row('Advance (unallocated)', m(rec.unallocated_paise));
    doc.moveDown(2).text(`For ${e.name}`, { align: 'right' }).moveDown(1.5).text('Authorised signatory', { align: 'right' });
    doc.end();
    await done;
    return { name: `${String(rec.number).replace(/\//g, '-')}.pdf`, pdf: Buffer.concat(chunks) };
  }
}
