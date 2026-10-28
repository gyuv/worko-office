import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { amountInWords, computeInvoice, formatINR, GST_STATES, supplyTypeOf, type LineInput } from '@worko/domain';
import PDFDocument from 'pdfkit';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Params } from '../clients/scope.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import {
  addDays, billTo, canClient, clientFor, d, entityFor, fyStart, loadSettings, n, nextDocNumber, placeOfSupply, presentInvoice, presentLine, scopeSql,
} from './common.js';

export type LineIn = {
  description: string; sac?: string | null; serviceTypeId?: string | null; qty?: number; ratePaise: number; discountPaise?: number;
  gstRate?: number | null; reimbursement?: boolean; taskIds?: string[];
};
export type DraftIn = { clientId: string; entityId?: string | null; notes?: string | null; lines: LineIn[] };
export type NoteIn = { kind: 'credit_note' | 'debit_note'; date: string; reason: string; lines: Array<{ description: string; taxablePaise: number; gstRate?: number | null; sac?: string | null }> };
export type ListQ = { status?: string[]; kind?: string; clientId?: string; from?: string; to?: string; overdueAsOf?: string; q?: string; limit: number; offset: number };

/** Highest cursor written in a transaction, published after commit. */
export class Cursor { v = 0; bump(c: number | null | undefined) { if (c) this.v = Math.max(this.v, Number(c)); } }

const sqlErr = (e: unknown) => (e as { code?: string }).code;

@Injectable()
export class InvoicesService {
  constructor(private db: DbService, private audit: AuditService, private sync: SyncService, private realtime: RealtimeService) {}

  publish(a: { tenantId: string }, c: Cursor) { if (c.v) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: c.v }); }

  list(a: RequestActor, q: ListQ) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = ['i.deleted_at IS NULL', 'c.deleted_at IS NULL', scopeSql(a, 'billing', 'view', p)];
      if (q.status?.length) where.push(`i.status = ANY(${p.add(q.status)})`);
      if (q.kind) where.push(`i.kind = ${p.add(q.kind)}`);
      if (q.clientId) where.push(`i.client_id = ${p.add(q.clientId)}`);
      if (q.from) where.push(`COALESCE(i.issue_date, i.created_at::date) >= ${p.add(q.from)}::date`);
      if (q.to) where.push(`COALESCE(i.issue_date, i.created_at::date) <= ${p.add(q.to)}::date`);
      if (q.overdueAsOf) where.push(`i.status IN ('issued','partially_paid') AND i.due_date < ${p.add(q.overdueAsOf)}::date`);
      if (q.q) { const t = p.add(q.q); where.push(`(i.number ILIKE '%' || ${t} || '%' OR c.name ILIKE '%' || ${t} || '%')`); }
      const rows = (await tx.query(`SELECT i.*, c.name AS client_name, count(*) OVER () AS total_count FROM invoice i JOIN client c ON c.id = i.client_id
        WHERE ${where.join(' AND ')} ORDER BY COALESCE(i.issue_date, i.created_at::date) DESC, i.number DESC NULLS FIRST, i.id DESC
        LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`, p.values)).rows;
      return { total: Number(rows[0]?.total_count ?? 0), items: rows.map(presentInvoice) };
    });
  }

  /** Invoice row (+client) the actor may `action` on; 404 if invisible. */
  async rowFor(tx: Tx, a: RequestActor, id: string, action: 'view' | 'edit' | 'approve' | 'print' | 'create', lock = false) {
    const i = (await tx.query(`SELECT * FROM invoice WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
    if (!i) throw new NotFoundException();
    const c = (await tx.query('SELECT * FROM client WHERE id = $1', [i.client_id])).rows[0];
    if (!c || c.deleted_at || !canClient(a, 'billing', action, c)) throw new NotFoundException();
    return { inv: i as Record<string, unknown>, client: c as Record<string, unknown> };
  }

  get(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const { inv, client } = await this.rowFor(tx, a, id, 'view');
      const lines = (await tx.query(`SELECT l.*, ARRAY(SELECT t.task_id FROM invoice_task t WHERE t.line_id = l.id AND t.live) AS task_ids
        FROM invoice_line l WHERE l.invoice_id = $1 ORDER BY l.sort, l.id`, [id])).rows;
      const allocations = (await tx.query(`SELECT a.id, a.receipt_id AS "receiptId", r.number AS "receiptNumber", r.received_on, a.amount_paise, a.tds_paise
        FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id WHERE a.invoice_id = $1 ORDER BY a.created_at`, [id])).rows
        .map((x) => ({ id: x.id, receiptId: x.receiptId, receiptNumber: x.receiptNumber, receivedOn: d(x.received_on), amountPaise: n(x.amount_paise), tdsPaise: n(x.tds_paise) }));
      const notes = (await tx.query(`SELECT * FROM invoice WHERE against_invoice_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [id])).rows.map(presentInvoice);
      const messages = (await tx.query(`SELECT kind, step, channel, status, detail, as_of, created_at FROM billing_message WHERE invoice_id = $1 ORDER BY created_at`, [id])).rows
        .map((m) => ({ kind: m.kind, step: m.step, channel: m.channel, status: m.status, detail: m.detail, asOf: d(m.as_of), at: m.created_at }));
      const links = (await tx.query(`SELECT id, provider, url, amount_paise, status, created_at FROM payment_link WHERE invoice_id = $1 ORDER BY created_at`, [id])).rows
        .map((l) => ({ id: l.id, provider: l.provider, url: l.url, amountPaise: n(l.amount_paise), status: l.status, createdAt: l.created_at }));
      return { ...presentInvoice({ ...inv, client_name: client.name }), lines: lines.map(presentLine), allocations, notes, messages, paymentLinks: links };
    });
  }

  // ---------- Drafts ----------

  async create(a: RequestActor, i: DraftIn) {
    const cur = new Cursor();
    const id = await this.db.tenantTx(a.tenantId, (tx) => this.createDraftTx(tx, a, i, 'manual', cur));
    this.publish(a, cur);
    return { id };
  }

  /** Inserts a draft with computed lines; linked tasks become `billed`. Used by REST, auto-billing and retainers. */
  async createDraftTx(tx: Tx, a: RequestActor, i: DraftIn, source: 'manual' | 'auto' | 'retainer', cur: Cursor, extra: { clientServiceId?: string; periodKey?: string } = {}) {
    const client = await clientFor(tx, a, i.clientId, 'billing', 'create');
    const entity = await entityFor(tx, i.entityId);
    const pos = await placeOfSupply(tx, client);
    const id = uuidv7();
    try {
      const r = await tx.query(`INSERT INTO invoice (id, tenant_id, entity_id, client_id, supply_type, supplier_state, place_of_supply, supplier_gstin, client_gstin, bill_to,
          notes, source, client_service_id, period_key, created_by, updated_by, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16) RETURNING sync_cursor`,
        [id, a.tenantId, entity.id, client.id, supplyTypeOf(entity.gstin as string | null, entity.state_code as string, pos.state), entity.state_code, pos.state ?? entity.state_code,
          entity.gstin, pos.gstin, JSON.stringify(billTo(client)), i.notes ?? null, source, extra.clientServiceId ?? null, extra.periodKey ?? null, a.userId, a.deviceId]);
      cur.bump(r.rows[0].sync_cursor);
    } catch (e) {
      if (sqlErr(e) === '23505') throw new ConflictException({ message: 'Already drafted for this period', code: 'retainer_exists' });
      throw e;
    }
    await this.writeLines(tx, a, id, client, i.lines, cur);
    await this.recalc(tx, a, id, cur);
    await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'invoice.drafted', entity: 'invoice', entityId: id,
      diff: { clientId: i.clientId, entityId: entity.id, source, lines: i.lines.length, tasks: i.lines.flatMap((l) => l.taskIds ?? []).length } });
    return id;
  }

  private async writeLines(tx: Tx, a: RequestActor, invoiceId: string, client: Record<string, unknown>, lines: LineIn[], cur: Cursor) {
    const s = await loadSettings(tx);
    for (const [k, l] of lines.entries()) {
      const st = l.serviceTypeId ? (await tx.query('SELECT * FROM service_type WHERE id = $1 AND deleted_at IS NULL', [l.serviceTypeId])).rows[0] : null;
      if (l.serviceTypeId && !st) throw new BadRequestException('Unknown service');
      const gst = l.reimbursement ? 0 : l.gstRate ?? (st?.gst_rate != null ? Number(st.gst_rate) : s.defaultGstRate);
      const sac = l.reimbursement ? null : l.sac ?? st?.sac_code ?? s.defaultSac;
      const lineId = uuidv7();
      await tx.query(`INSERT INTO invoice_line (id, tenant_id, invoice_id, sort, description, sac, service_type_id, qty, rate_paise, discount_paise, gst_rate, reimbursement,
          amount_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,0,0,0,0)`,
        [lineId, a.tenantId, invoiceId, k, l.description, sac, l.serviceTypeId ?? null, l.qty ?? 1, l.ratePaise, l.discountPaise ?? 0, gst, !!l.reimbursement]);
      if (l.taskIds?.length) await this.linkTasks(tx, a, invoiceId, lineId, client, l.taskIds, cur);
    }
  }

  /** A task may be billed only once (unique live link), only for this client, only when done and still open. */
  private async linkTasks(tx: Tx, a: RequestActor, invoiceId: string, lineId: string, client: Record<string, unknown>, taskIds: string[], cur: Cursor) {
    for (const tid of new Set(taskIds)) {
      const t = (await tx.query('SELECT id, client_id, status, outcome FROM task WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [tid])).rows[0];
      if (!t || t.client_id !== client.id) throw new BadRequestException({ message: 'Task not found for this client', code: 'invalid_task' });
      if (t.status !== 'done' || t.outcome) throw new ConflictException({ message: 'Task is not done-and-unbilled', code: 'task_not_billable' });
      try {
        await tx.query('SAVEPOINT link');
        await tx.query('INSERT INTO invoice_task (tenant_id, invoice_id, line_id, task_id) VALUES ($1,$2,$3,$4)', [a.tenantId, invoiceId, lineId, tid]);
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT link');
        if (sqlErr(e) === '23505') throw new ConflictException({ message: 'Task is already on an invoice', code: 'task_already_billed' });
        throw e;
      }
      const r = await this.sync.serverPatch(tx, a, 'task', tid, { outcome: 'billed', outcome_note: `Invoice ${invoiceId}`, closed_at: new Date().toISOString(), closed_by: a.userId });
      cur.bump(r?.cursor);
    }
  }

  /** Draft deleted / invoice cancelled: its tasks become unbilled again (done, no outcome). */
  private async unlinkTasks(tx: Tx, a: RequestActor, invoiceId: string, cur: Cursor) {
    const ids = (await tx.query('UPDATE invoice_task SET live = false WHERE invoice_id = $1 AND live RETURNING task_id', [invoiceId])).rows.map((r) => r.task_id as string);
    for (const tid of ids) {
      const r = await this.sync.serverPatch(tx, a, 'task', tid, { outcome: null, outcome_note: null, closed_at: null, closed_by: null });
      cur.bump(r?.cursor);
    }
    return ids.length;
  }

  /** Recomputes line taxes and header totals from the current place of supply (drafts only). */
  private async recalc(tx: Tx, a: RequestActor, id: string, cur: Cursor) {
    const inv = (await tx.query('SELECT * FROM invoice WHERE id = $1', [id])).rows[0];
    const lines = (await tx.query('SELECT * FROM invoice_line WHERE invoice_id = $1 ORDER BY sort, id', [id])).rows;
    if (!lines.length) throw new BadRequestException('An invoice needs at least one line');
    const input: LineInput[] = lines.map((l) => ({ qty: Number(l.qty), ratePaise: n(l.rate_paise), discountPaise: n(l.discount_paise), gstRate: Number(l.gst_rate), reimbursement: l.reimbursement }));
    let t;
    try { t = computeInvoice(input, inv.supply_type); } catch (e) { throw new BadRequestException((e as Error).message); }
    for (const [k, l] of lines.entries()) {
      const x = t.lines[k]!;
      await tx.query(`UPDATE invoice_line SET amount_paise = $2, taxable_paise = $3, cgst_paise = $4, sgst_paise = $5, igst_paise = $6, total_paise = $7 WHERE id = $1`,
        [l.id, x.amountPaise, x.taxablePaise, x.cgstPaise, x.sgstPaise, x.igstPaise, x.totalPaise]);
    }
    const r = await this.sync.serverPatch(tx, a, 'invoice', id, {
      taxable_paise: t.taxablePaise, cgst_paise: t.cgstPaise, sgst_paise: t.sgstPaise, igst_paise: t.igstPaise, reimbursement_paise: t.reimbursementPaise,
      round_off_paise: t.roundOffPaise, total_paise: t.totalPaise, balance_paise: t.totalPaise,
    });
    cur.bump(r?.cursor);
  }

  async update(a: RequestActor, id: string, i: { entityId?: string | null; notes?: string | null; lines?: LineIn[] }) {
    const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const { inv, client } = await this.rowFor(tx, a, id, 'edit', true);
      if (inv.status !== 'draft') throw new ConflictException({ message: 'Issued invoices are immutable; use a credit or debit note', code: 'invoice_immutable' });
      const patch: Record<string, unknown> = {};
      if (i.notes !== undefined) patch.notes = i.notes;
      const pos = await placeOfSupply(tx, client);
      const entity = await entityFor(tx, i.entityId ?? (inv.entity_id as string));
      Object.assign(patch, { entity_id: entity.id, supplier_state: entity.state_code, supplier_gstin: entity.gstin, place_of_supply: pos.state ?? entity.state_code, client_gstin: pos.gstin,
        supply_type: supplyTypeOf(entity.gstin as string | null, entity.state_code as string, pos.state), bill_to: billTo(client) });
      cur.bump((await this.sync.serverPatch(tx, a, 'invoice', id, patch))?.cursor);
      if (i.lines) {
        await this.unlinkTasks(tx, a, id, cur);
        await tx.query('DELETE FROM invoice_task WHERE invoice_id = $1 AND NOT live', [id]);
        await tx.query('DELETE FROM invoice_line WHERE invoice_id = $1', [id]);
        await this.writeLines(tx, a, id, client, i.lines, cur);
      }
      await this.recalc(tx, a, id, cur);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'invoice.updated', entity: 'invoice', entityId: id, diff: { notes: i.notes, entityId: i.entityId, lines: i.lines?.length } });
    });
    this.publish(a, cur);
  }

  async remove(a: RequestActor, id: string) {
    const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const { inv } = await this.rowFor(tx, a, id, 'edit', true);
      if (inv.status !== 'draft') throw new ConflictException({ message: 'Only drafts can be deleted; cancel or credit an issued invoice', code: 'invoice_immutable' });
      const tasks = await this.unlinkTasks(tx, a, id, cur);
      cur.bump(Number((await tx.query('UPDATE invoice SET deleted_at = now(), updated_by = $2 WHERE id = $1 RETURNING sync_cursor', [id, a.userId])).rows[0].sync_cursor));
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'invoice.deleted', entity: 'invoice', entityId: id, diff: { tasksUnbilled: tasks } });
    });
    this.publish(a, cur);
  }

  // ---------- Issue / cancel / notes ----------

  async issue(a: RequestActor, id: string, i: { issueDate: string; dueDate?: string | null }) {
    const cur = new Cursor();
    const number = await this.db.tenantTx(a.tenantId, async (tx) => {
      const { inv, client } = await this.rowFor(tx, a, id, 'edit', true);
      if (inv.status !== 'draft') throw new ConflictException({ message: 'Already issued', code: 'invoice_not_draft' });
      const s = await loadSettings(tx);
      const due = i.dueDate ?? addDays(i.issueDate, s.dueDays);
      if (due < i.issueDate) throw new BadRequestException({ message: 'Due date before issue date', code: 'due_before_issue' });
      // Refresh the recipient snapshot and taxes one last time, then lock (DB trigger keeps it immutable).
      const pos = await placeOfSupply(tx, client);
      const entity = (await tx.query('SELECT * FROM firm_entity WHERE id = $1', [inv.entity_id])).rows[0];
      cur.bump((await this.sync.serverPatch(tx, a, 'invoice', id, { bill_to: billTo(client), client_gstin: pos.gstin, place_of_supply: pos.state ?? entity.state_code,
        supply_type: supplyTypeOf(entity.gstin, entity.state_code, pos.state) }))?.cursor);
      await this.recalc(tx, a, id, cur);
      const fy = fyStart(i.issueDate);
      const num = await nextDocNumber(tx, a.tenantId, entity, 'invoice', fy);
      cur.bump((await this.sync.serverPatch(tx, a, 'invoice', id, { number: num, fy, issue_date: i.issueDate, due_date: due, status: 'issued', issued_at: new Date().toISOString(), issued_by: a.userId }))?.cursor);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'invoice.issued', entity: 'invoice', entityId: id, diff: { number: num, issueDate: i.issueDate, dueDate: due } });
      return num;
    });
    this.publish(a, cur);
    return { number };
  }

  /**
   * Cancel (D69): only an issued invoice with nothing settled against it (no receipts, TDS or notes). The number stays used
   * (gap-free series) and the tasks become unbilled. Anything partly settled is corrected with a credit note instead.
   */
  async cancel(a: RequestActor, id: string, reason: string) {
    const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const { inv } = await this.rowFor(tx, a, id, 'approve', true);
      if (inv.kind === 'credit_note') throw new ConflictException({ message: 'Credit notes cannot be cancelled', code: 'not_cancellable' });
      if (inv.status === 'draft') throw new ConflictException({ message: 'Delete a draft instead', code: 'invoice_is_draft' });
      if (inv.status === 'cancelled') throw new ConflictException({ message: 'Already cancelled', code: 'already_cancelled' });
      const settled = n(inv.allocated_paise) + n(inv.tds_paise) + n(inv.credited_paise);
      const notes = (await tx.query(`SELECT 1 FROM invoice WHERE against_invoice_id = $1 AND deleted_at IS NULL AND status <> 'cancelled'`, [id])).rowCount;
      if (settled > 0 || notes) throw new ConflictException({ message: 'Payments or notes exist; issue a credit note instead', code: 'invoice_settled' });
      const tasks = await this.unlinkTasks(tx, a, id, cur);
      cur.bump((await this.sync.serverPatch(tx, a, 'invoice', id, { status: 'cancelled', balance_paise: 0, cancelled_at: new Date().toISOString(), cancelled_by: a.userId, cancel_reason: reason }))?.cursor);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'invoice.cancelled', entity: 'invoice', entityId: id, diff: { number: inv.number, reason, tasksUnbilled: tasks } });
    });
    this.publish(a, cur);
  }

  /** Credit/debit note against an issued invoice: same parties and supply type, own series, issued immediately. */
  async note(a: RequestActor, invoiceId: string, i: NoteIn) {
    const cur = new Cursor();
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const { inv } = await this.rowFor(tx, a, invoiceId, 'approve', true);
      if (inv.kind !== 'invoice' || !['issued', 'partially_paid', 'paid'].includes(inv.status as string)) {
        throw new ConflictException({ message: 'Notes need an issued, non-cancelled invoice', code: 'invoice_not_issued' });
      }
      if (i.date < d(inv.issue_date)!) throw new BadRequestException({ message: 'Note dated before the invoice', code: 'note_before_invoice' });
      const s = await loadSettings(tx);
      const firstRate = (await tx.query('SELECT gst_rate FROM invoice_line WHERE invoice_id = $1 AND NOT reimbursement ORDER BY sort LIMIT 1', [invoiceId])).rows[0]?.gst_rate;
      const lines = i.lines.map((l) => ({ ...l, gst: l.gstRate ?? (firstRate != null ? Number(firstRate) : s.defaultGstRate) }));
      const t = computeInvoice(lines.map((l) => ({ qty: 1, ratePaise: l.taxablePaise, gstRate: l.gst })), inv.supply_type as 'intra', { roundToRupee: false });
      if (i.kind === 'credit_note' && t.totalPaise > n(inv.balance_paise)) {
        throw new ConflictException({ message: 'Credit exceeds the outstanding balance', code: 'credit_exceeds_balance' });
      }
      const entity = (await tx.query('SELECT * FROM firm_entity WHERE id = $1', [inv.entity_id])).rows[0];
      const id = uuidv7(); const fy = fyStart(i.date);
      const num = await nextDocNumber(tx, a.tenantId, entity, i.kind, fy);
      const debit = i.kind === 'debit_note';
      const res = await tx.query(`INSERT INTO invoice (id, tenant_id, kind, against_invoice_id, entity_id, client_id, status, number, fy, issue_date, due_date, supply_type, supplier_state,
          place_of_supply, supplier_gstin, client_gstin, bill_to, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, balance_paise, reason, issued_at, issued_by,
          created_by, updated_by, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,'issued',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, now(), $24, $24, $24, $25) RETURNING sync_cursor`,
        [id, a.tenantId, i.kind, invoiceId, inv.entity_id, inv.client_id, num, fy, i.date, debit ? addDays(i.date, s.dueDays) : null, inv.supply_type, inv.supplier_state,
          inv.place_of_supply, inv.supplier_gstin, inv.client_gstin, JSON.stringify(inv.bill_to), t.taxablePaise, t.cgstPaise, t.sgstPaise, t.igstPaise, t.totalPaise,
          debit ? t.totalPaise : 0, i.reason, a.userId, a.deviceId]);
      cur.bump(res.rows[0].sync_cursor);
      await this.insertNoteLines(tx, a.tenantId, id, lines, t.lines);
      if (!debit) await this.recompute(tx, a, invoiceId, cur);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: `invoice.${i.kind}`, entity: 'invoice', entityId: id,
        diff: { against: invoiceId, number: num, totalPaise: t.totalPaise, reason: i.reason } });
      return { id, number: num, totalPaise: t.totalPaise };
    });
    this.publish(a, cur);
    return r;
  }

  private async insertNoteLines(tx: Tx, tenantId: string, noteId: string, lines: Array<{ description: string; sac?: string | null; gst: number; taxablePaise: number }>,
    taxes: Array<{ amountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number }>) {
    // The line trigger allows inserts under a non-draft header only while this transaction-local flag names the note.
    await tx.query("SELECT set_config('worko.note_lines', $1, true)", [noteId]);
    for (const [k, l] of lines.entries()) {
      const x = taxes[k]!;
      await tx.query(`INSERT INTO invoice_line (id, tenant_id, invoice_id, sort, description, sac, qty, rate_paise, discount_paise, gst_rate, reimbursement,
          amount_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise) VALUES ($1,$2,$3,$4,$5,$6,1,$7,0,$8,false,$9,$10,$11,$12,$13,$14)`,
        [uuidv7(), tenantId, noteId, k, l.description, l.sac ?? null, l.taxablePaise, l.gst, x.amountPaise, x.taxablePaise, x.cgstPaise, x.sgstPaise, x.igstPaise, x.totalPaise]);
    }
    await tx.query("SELECT set_config('worko.note_lines', '', true)");
  }

  /**
   * Settlement of a receivable from its allocations and credit notes: balance = total − allocations − TDS − credits.
   * Status follows (issued → partially_paid → paid). Runs in the caller's transaction after any allocation/note change.
   */
  async recompute(tx: Tx, a: RequestActor, id: string, cur: Cursor) {
    const inv = (await tx.query('SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!inv || inv.status === 'draft' || inv.status === 'cancelled' || inv.kind === 'credit_note') return;
    const s = (await tx.query(`SELECT COALESCE(sum(amount_paise),0) AS amt, COALESCE(sum(tds_paise),0) AS tds FROM receipt_allocation WHERE invoice_id = $1`, [id])).rows[0];
    const cr = (await tx.query(`SELECT COALESCE(sum(total_paise),0) AS c FROM invoice WHERE against_invoice_id = $1 AND kind = 'credit_note' AND status <> 'cancelled' AND deleted_at IS NULL`, [id])).rows[0];
    const total = n(inv.total_paise); const alloc = n(s.amt); const tds = n(s.tds); const credited = n(cr.c);
    const balance = total - alloc - tds - credited;
    if (balance < 0) throw new ConflictException({ message: 'Settlement exceeds the invoice total', code: 'over_settled' });
    const status = balance === 0 ? 'paid' : alloc + tds > 0 || credited > 0 ? 'partially_paid' : 'issued';
    if (n(inv.allocated_paise) === alloc && n(inv.tds_paise) === tds && n(inv.credited_paise) === credited && n(inv.balance_paise) === balance && inv.status === status) return;
    cur.bump((await this.sync.serverPatch(tx, a, 'invoice', id, { allocated_paise: alloc, tds_paise: tds, credited_paise: credited, balance_paise: balance, status }))?.cursor);
  }

  async setFollowup(a: RequestActor, id: string, i: { promiseToPay?: string | null; paused?: boolean }) {
    const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const { inv } = await this.rowFor(tx, a, id, 'edit', true);
      if (inv.status === 'draft' || inv.status === 'cancelled') throw new ConflictException({ message: 'Not an open invoice', code: 'invoice_not_open' });
      const patch: Record<string, unknown> = {};
      if (i.promiseToPay !== undefined) patch.promise_to_pay = i.promiseToPay;
      if (i.paused !== undefined) patch.followup_paused = i.paused;
      cur.bump((await this.sync.serverPatch(tx, a, 'invoice', id, patch))?.cursor);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'invoice.followup_set', entity: 'invoice', entityId: id, diff: i });
    });
    this.publish(a, cur);
  }

  // ---------- PDF ----------

  async pdf(a: RequestActor | null, tenantId: string, id: string): Promise<{ name: string; pdf: Buffer }> {
    return this.db.tenantTx(tenantId, async (tx) => {
      const inv = a ? (await this.rowFor(tx, a, id, 'print')).inv : (await tx.query('SELECT * FROM invoice WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
      if (!inv || inv.status === 'draft' && !a) throw new NotFoundException();
      const e = (await tx.query('SELECT * FROM firm_entity WHERE id = $1', [inv.entity_id])).rows[0];
      const lines = (await tx.query('SELECT * FROM invoice_line WHERE invoice_id = $1 ORDER BY sort, id', [id])).rows;
      const against = inv.against_invoice_id ? (await tx.query('SELECT number, issue_date FROM invoice WHERE id = $1', [inv.against_invoice_id])).rows[0] : null;
      const terms = (await loadSettings(tx)).terms;
      return { name: `${(inv.number ?? 'DRAFT').replace(/\//g, '-')}.pdf`, pdf: await renderInvoicePdf(inv, e, lines, against, terms) };
    });
  }
}

const TITLE: Record<string, string> = { invoice: 'Tax Invoice', credit_note: 'Credit Note', debit_note: 'Debit Note' };

/** A4 invoice with the particulars GST requires (// VERIFY AGAINST OFFICIAL DOCS — CGST Rule 46/53). */
async function renderInvoicePdf(inv: Record<string, unknown>, e: Record<string, unknown>, lines: Array<Record<string, unknown>>, against: Record<string, unknown> | null, terms: string | null) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((r) => doc.on('end', () => r()));
  const money = (p: unknown) => formatINR(n(p), { symbol: false });
  const unregistered = inv.supply_type === 'unregistered';
  doc.fontSize(15).font('Helvetica-Bold').text(String(e.name)).font('Helvetica').fontSize(9);
  if (e.address) doc.text(String(e.address));
  doc.text([e.gstin ? `GSTIN: ${e.gstin}` : 'Not registered under GST', e.pan ? `PAN: ${e.pan}` : null, `State: ${GST_STATES[e.state_code as string] ?? ''} (${e.state_code})`].filter(Boolean).join('   '));
  doc.moveDown(0.6).fontSize(13).font('Helvetica-Bold').text(unregistered && inv.kind === 'invoice' ? 'Bill of Supply' : TITLE[inv.kind as string]!, { align: 'center' }).font('Helvetica').fontSize(9);
  if (inv.status === 'draft') doc.fillColor('#b00').text('DRAFT — not a valid invoice', { align: 'center' }).fillColor('#000');
  if (inv.status === 'cancelled') doc.fillColor('#b00').text('CANCELLED', { align: 'center' }).fillColor('#000');
  doc.moveDown(0.4);
  const bt = (inv.bill_to ?? {}) as { name?: string; address?: string };
  const row = (k: string, v: unknown) => { if (v) doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(String(v)); };
  row('Number', inv.number ?? '—'); row('Date', d(inv.issue_date)); row('Due date', d(inv.due_date));
  if (against) row('Against invoice', `${against.number} dated ${d(against.issue_date)}`);
  if (inv.reason) row('Reason', inv.reason);
  doc.moveDown(0.3);
  row('Bill to', bt.name); row('Address', bt.address); row('Recipient GSTIN', inv.client_gstin ?? 'Unregistered');
  row('Place of supply', `${GST_STATES[inv.place_of_supply as string] ?? ''} (${inv.place_of_supply})`);
  doc.moveDown(0.5);
  const cols = [40, 70, 270, 320, 355, 425, 475];
  const head = ['#', 'Description', 'SAC', 'Qty', 'Rate', 'GST %', 'Taxable'];
  const y0 = doc.y; doc.font('Helvetica-Bold');
  head.forEach((h, k) => doc.text(h, cols[k]!, y0, { width: (cols[k + 1] ?? 555) - cols[k]! - 4 }));
  doc.font('Helvetica');
  for (const [k, l] of lines.entries()) {
    const y = doc.y + 4;
    const cells = [String(k + 1), `${l.description}${l.reimbursement ? ' (reimbursement — not a supply)' : ''}`, l.sac ?? '', String(Number(l.qty)), money(l.rate_paise),
      l.reimbursement ? '—' : String(Number(l.gst_rate)), money(l.reimbursement ? l.total_paise : l.taxable_paise)];
    let maxY = y;
    cells.forEach((c, j) => { doc.text(String(c), cols[j]!, y, { width: (cols[j + 1] ?? 555) - cols[j]! - 4 }); maxY = Math.max(maxY, doc.y); });
    doc.y = maxY;
  }
  doc.moveDown(0.8);
  const tot = (k: string, v: unknown) => { if (n(v) !== 0 || k === 'Total') doc.text(`${k}: ${money(v)}`, 330, doc.y, { width: 225, align: 'right' }); };
  tot('Taxable value', inv.taxable_paise); tot('CGST', inv.cgst_paise); tot('SGST', inv.sgst_paise); tot('IGST', inv.igst_paise);
  tot('Reimbursements', inv.reimbursement_paise); tot('Round off', inv.round_off_paise);
  doc.font('Helvetica-Bold'); tot('Total', inv.total_paise); doc.font('Helvetica');
  doc.text(amountInWords(n(inv.total_paise)), 40, doc.y + 4);
  if (inv.status !== 'draft' && inv.kind !== 'credit_note') doc.text(`Balance due: ₹${money(inv.balance_paise)}`.replace('₹', 'Rs. '));
  const bank = (e.bank ?? {}) as Record<string, string>;
  if (bank.accountNo) doc.moveDown(0.5).text(`Bank: ${[bank.name, `A/c ${bank.accountNo}`, bank.ifsc && `IFSC ${bank.ifsc}`, bank.upiId && `UPI ${bank.upiId}`].filter(Boolean).join(', ')}`);
  if (inv.notes) doc.moveDown(0.3).text(String(inv.notes));
  if (terms) doc.moveDown(0.3).fontSize(8).text(terms).fontSize(9);
  doc.moveDown(0.3).fontSize(8).text('Whether tax is payable on reverse charge: No').fontSize(9);
  doc.moveDown(2).text(`For ${e.name}`, { align: 'right' }).moveDown(2).text('Authorised signatory', { align: 'right' });
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
