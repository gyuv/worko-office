import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AGEING_BUCKETS, ageingBucket, buildTallyXml, daysBetween, invoiceVoucher, receiptVoucher, type AgeingBucket, type TallyVoucher } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Params } from '../clients/scope.js';
import { tabular } from '../common/export.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { requireFirmWide } from '../tasks/system-actor.js';
import { clientFor, d, n, scopeSql } from './common.js';

type Buckets = Record<AgeingBucket, number>;
const zero = (): Buckets => Object.fromEntries(AGEING_BUCKETS.map((b) => [b, 0])) as Buckets;
const OPEN = `i.deleted_at IS NULL AND i.kind IN ('invoice','debit_note') AND i.status IN ('issued','partially_paid') AND i.balance_paise > 0`;

@Injectable()
export class BillingReportsService {
  constructor(private db: DbService, private audit: AuditService) {}

  /** Receivables by days past due, per visible client. `total` always equals the sum of the clients' open balances. */
  ageing(a: RequestActor, asOf: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const rows = (await tx.query(`SELECT i.client_id, c.name, i.due_date, i.balance_paise FROM invoice i JOIN client c ON c.id = i.client_id
        WHERE ${OPEN} AND c.deleted_at IS NULL AND ${scopeSql(a, 'billing', 'view', p)} ORDER BY lower(c.name), c.id`, p.values)).rows;
      const p2 = new Params();
      const adv = (await tx.query(`SELECT r.client_id, sum(r.unallocated_paise) AS s FROM receipt r JOIN client c ON c.id = r.client_id
        WHERE r.deleted_at IS NULL AND r.unallocated_paise > 0 AND c.deleted_at IS NULL AND ${scopeSql(a, 'billing', 'view', p2)} GROUP BY r.client_id`, p2.values)).rows;
      const advance = new Map(adv.map((r) => [r.client_id as string, n(r.s)]));
      const by = new Map<string, { clientId: string; clientName: string; buckets: Buckets; totalPaise: number; advancePaise: number }>();
      const totals = zero(); let total = 0;
      for (const r of rows) {
        const b = ageingBucket(daysBetween(d(r.due_date)!, asOf));
        const g = by.get(r.client_id) ?? { clientId: r.client_id, clientName: r.name, buckets: zero(), totalPaise: 0, advancePaise: advance.get(r.client_id) ?? 0 };
        g.buckets[b] += n(r.balance_paise); g.totalPaise += n(r.balance_paise);
        totals[b] += n(r.balance_paise); total += n(r.balance_paise);
        by.set(r.client_id, g);
      }
      return { asOf, clients: [...by.values()], totals: { ...totals, totalPaise: total, advancePaise: [...advance.values()].reduce((s, x) => s + x, 0) } };
    });
  }

  /** A client's open receivables, unapplied advances and balance (mobile "client outstanding"). */
  outstanding(a: RequestActor, clientId: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await clientFor(tx, a, clientId, 'billing', 'view');
      const items = (await tx.query(`SELECT i.id, i.kind, i.number, i.issue_date, i.due_date, i.total_paise, i.balance_paise, i.status FROM invoice i
        WHERE i.client_id = $1 AND ${OPEN} ORDER BY i.due_date, i.number`, [clientId])).rows
        .map((r) => ({ id: r.id, kind: r.kind, number: r.number, issueDate: d(r.issue_date), dueDate: d(r.due_date), totalPaise: n(r.total_paise), balancePaise: n(r.balance_paise), status: r.status }));
      const adv = n((await tx.query('SELECT COALESCE(sum(unallocated_paise),0) AS s FROM receipt WHERE client_id = $1 AND deleted_at IS NULL', [clientId])).rows[0].s);
      const due = items.reduce((s, x) => s + x.balancePaise, 0);
      return { clientId, items, outstandingPaise: due, advancePaise: adv, netPaise: due - adv };
    });
  }

  async exportInvoices(a: RequestActor, q: { from?: string; to?: string; format: 'csv' | 'xlsx' }) {
    const rows = await this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = ['i.deleted_at IS NULL', "i.status <> 'draft'", 'c.deleted_at IS NULL', scopeSql(a, 'billing', 'export', p)];
      if (q.from) where.push(`i.issue_date >= ${p.add(q.from)}::date`);
      if (q.to) where.push(`i.issue_date <= ${p.add(q.to)}::date`);
      const r = (await tx.query(`SELECT i.*, c.name AS client_name, e.name AS entity_name FROM invoice i JOIN client c ON c.id = i.client_id JOIN firm_entity e ON e.id = i.entity_id
        WHERE ${where.join(' AND ')} ORDER BY i.issue_date, i.number`, p.values)).rows;
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'invoice.exported', entity: 'invoice', diff: { format: q.format, from: q.from ?? null, to: q.to ?? null, rows: r.length } });
      return r;
    });
    const rupees = (p: unknown) => n(p) / 100;
    return tabular(`invoices-${q.from ?? 'all'}-${q.to ?? 'all'}`, 'Invoices',
      ['Entity', 'Type', 'Number', 'Date', 'Due', 'Client', 'Client GSTIN', 'Place of supply', 'Taxable', 'CGST', 'SGST', 'IGST', 'Reimbursements', 'Round off', 'Total', 'Balance', 'Status'],
      rows.map((i) => [i.entity_name, i.kind, i.number, d(i.issue_date), d(i.due_date), i.client_name, i.client_gstin, i.place_of_supply, rupees(i.taxable_paise), rupees(i.cgst_paise),
        rupees(i.sgst_paise), rupees(i.igst_paise), rupees(i.reimbursement_paise), rupees(i.round_off_paise), rupees(i.total_paise), rupees(i.balance_paise), i.status]), q.format);
  }

  async exportReceipts(a: RequestActor, q: { from?: string; to?: string; format: 'csv' | 'xlsx' }) {
    const rows = await this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = ['r.deleted_at IS NULL', 'c.deleted_at IS NULL', scopeSql(a, 'receipts', 'export', p)];
      if (q.from) where.push(`r.received_on >= ${p.add(q.from)}::date`);
      if (q.to) where.push(`r.received_on <= ${p.add(q.to)}::date`);
      const r = (await tx.query(`SELECT r.*, c.name AS client_name FROM receipt r JOIN client c ON c.id = r.client_id WHERE ${where.join(' AND ')} ORDER BY r.received_on, r.number`, p.values)).rows;
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'receipt.exported', entity: 'receipt', diff: { format: q.format, from: q.from ?? null, to: q.to ?? null, rows: r.length } });
      return r;
    });
    const rupees = (p: unknown) => n(p) / 100;
    return tabular(`receipts-${q.from ?? 'all'}-${q.to ?? 'all'}`, 'Receipts',
      ['Number', 'Date', 'Client', 'Mode', 'Reference', 'Amount', 'TDS', 'TDS section', 'Allocated', 'Advance'],
      rows.map((r) => [r.number, d(r.received_on), r.client_name, r.mode, r.reference, rupees(r.amount_paise), rupees(r.tds_paise), r.tds_section, rupees(r.allocated_paise), rupees(r.unallocated_paise)]), q.format);
  }

  // ---------- Tally ----------

  private async vouchers(tx: Tx, entityId: string, from: string, to: string, force: boolean) {
    const done = force ? '' : `AND NOT EXISTS (SELECT 1 FROM tally_export_log l WHERE l.voucher_kind = 'invoice' AND l.source_id = i.id)`;
    const invs = (await tx.query(`SELECT i.*, c.name AS client_name FROM invoice i JOIN client c ON c.id = i.client_id WHERE i.entity_id = $1 AND i.number IS NOT NULL
      AND i.status <> 'cancelled' AND i.deleted_at IS NULL AND i.issue_date BETWEEN $2::date AND $3::date ${done} ORDER BY i.issue_date, i.number`, [entityId, from, to])).rows;
    const out: Array<{ kind: 'invoice' | 'receipt'; v: TallyVoucher }> = [];
    for (const i of invs) {
      const lines = (await tx.query('SELECT l.taxable_paise, l.total_paise, l.reimbursement, s.key FROM invoice_line l LEFT JOIN service_type s ON s.id = l.service_type_id WHERE l.invoice_id = $1 ORDER BY l.sort', [i.id])).rows;
      out.push({ kind: 'invoice', v: invoiceVoucher({ id: i.id, kind: i.kind, number: i.number, date: d(i.issue_date)!, clientId: i.client_id, clientName: i.client_name,
        lines: lines.map((l) => ({ serviceKey: l.key, taxablePaise: n(l.taxable_paise), reimbursement: l.reimbursement, totalPaise: n(l.total_paise) })),
        cgstPaise: n(i.cgst_paise), sgstPaise: n(i.sgst_paise), igstPaise: n(i.igst_paise), roundOffPaise: n(i.round_off_paise), totalPaise: n(i.total_paise) }) });
    }
    const rdone = force ? '' : `AND NOT EXISTS (SELECT 1 FROM tally_export_log l WHERE l.voucher_kind = 'receipt' AND l.source_id = r.id)`;
    const recs = (await tx.query(`SELECT r.*, c.name AS client_name FROM receipt r JOIN client c ON c.id = r.client_id WHERE r.entity_id = $1 AND r.deleted_at IS NULL
      AND r.received_on BETWEEN $2::date AND $3::date ${rdone} ORDER BY r.received_on, r.number`, [entityId, from, to])).rows;
    for (const r of recs) {
      out.push({ kind: 'receipt', v: receiptVoucher({ id: r.id, number: r.number, date: d(r.received_on)!, clientId: r.client_id, clientName: r.client_name, mode: r.mode,
        amountPaise: n(r.amount_paise), tdsPaise: n(r.tds_paise), reference: r.reference }) });
    }
    return out;
  }

  private async ledgerMap(tx: Tx, entityId: string) {
    const rows = (await tx.query('SELECT account_key, ledger_name, entity_id FROM tally_ledger_map WHERE entity_id IS NULL OR entity_id = $1 ORDER BY entity_id NULLS FIRST', [entityId])).rows;
    return Object.fromEntries(rows.map((r) => [r.account_key as string, r.ledger_name as string])); // entity-specific rows come last and win
  }

  /** XML + validation errors (unmapped ledgers, unbalanced vouchers); nothing recorded. Skips vouchers already exported unless `force`. */
  async tallyDryRun(a: RequestActor, q: { entityId: string; from: string; to: string; force?: boolean }) {
    requireFirmWide(a, 'billing', 'export');
    return this.db.tenantTx(a.tenantId, (tx) => this.tallyBuild(tx, q));
  }

  private async tallyBuild(tx: Tx, q: { entityId: string; from: string; to: string; force?: boolean }) {
    const e = (await tx.query('SELECT * FROM firm_entity WHERE id = $1 AND deleted_at IS NULL', [q.entityId])).rows[0];
    if (!e) throw new NotFoundException('Entity not found');
    const vs = await this.vouchers(tx, q.entityId, q.from, q.to, !!q.force);
    const out = buildTallyXml(e.name, vs.map((x) => x.v), await this.ledgerMap(tx, q.entityId));
    return { ...out, vouchers: vs, invoices: vs.filter((x) => x.kind === 'invoice').length, receipts: vs.filter((x) => x.kind === 'receipt').length };
  }

  /** Records the exported vouchers (sync log) so re-exports are idempotent; refuses while validation errors remain. */
  async tallyExport(a: RequestActor, q: { entityId: string; from: string; to: string; force?: boolean }) {
    requireFirmWide(a, 'billing', 'export');
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const b = await this.tallyBuild(tx, q);
      if (b.errors.length) throw new BadRequestException({ message: 'Fix the Tally mapping first', code: 'tally_validation', issues: b.errors });
      const batch = uuidv7();
      for (const x of b.vouchers) {
        await tx.query(`INSERT INTO tally_export_log (id, tenant_id, batch_id, voucher_kind, source_id, voucher_number, exported_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (tenant_id, voucher_kind, source_id) DO UPDATE SET batch_id = $3, exported_by = $7, exported_at = now(), times = tally_export_log.times + 1`,
          [uuidv7(), a.tenantId, batch, x.kind, x.v.id, x.v.number, a.userId]);
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'tally.exported', entity: 'firm_entity', entityId: q.entityId,
        diff: { batchId: batch, from: q.from, to: q.to, force: !!q.force, invoices: b.invoices, receipts: b.receipts } });
      return { batchId: batch, xml: b.xml, count: b.count, invoices: b.invoices, receipts: b.receipts };
    });
  }
}
