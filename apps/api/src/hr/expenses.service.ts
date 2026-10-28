import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { can, clientCtx } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { canClient, scopeSql } from '../billing/common.js';
import { Params, visibilityOf } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { requireFirmWide } from '../tasks/system-actor.js';
import { isoDay, num, personScopeSql, requireApprover, requireOwn } from './common.js';

export type ExpenseLineIn = { categoryKey: string; spentOn: string; description: string; amountPaise: number; clientId?: string | null; billable?: boolean; receiptDocId?: string | null };
const n = (v: unknown) => Number(v ?? 0);

const presentClaim = (r: Record<string, unknown>) => ({
  id: r.id, userId: r.user_id, userName: r.user_name ?? null, title: r.title, status: r.status, claimedPaise: n(r.claimed_paise), approvedPaise: num(r.approved_paise),
  advanceSettledPaise: n(r.advance_settled_paise), paidPaise: n(r.paid_paise), submittedAt: r.submitted_at ?? null, decidedBy: r.decided_by ?? null, decidedAt: r.decided_at ?? null,
  decisionNote: r.decision_note ?? null, paidAt: r.paid_at ?? null, payoutRef: r.payout_ref ?? null, version: r.version,
});
const presentLine = (l: Record<string, unknown>) => ({
  id: l.id, categoryKey: l.category_key, spentOn: isoDay(l.spent_on), description: l.description, amountPaise: n(l.amount_paise), approvedPaise: num(l.approved_paise),
  clientId: l.client_id ?? null, billable: l.billable, receiptDocId: l.receipt_doc_id ?? null, policyFlag: l.policy_flag ?? null, decisionNote: l.decision_note ?? null,
  invoiceLineId: l.invoice_line_id ?? null,
});
const presentAdvance = (r: Record<string, unknown>) => ({
  id: r.id, userId: r.user_id, userName: r.user_name ?? null, purpose: r.purpose, amountPaise: n(r.amount_paise), approvedPaise: num(r.approved_paise), status: r.status,
  balancePaise: n(r.balance_paise), decidedBy: r.decided_by ?? null, paidAt: r.paid_at ?? null, payoutRef: r.payout_ref ?? null,
});
/** A billable line already sits on a live (non-cancelled, non-deleted) invoice. */
const LINKED = `EXISTS (SELECT 1 FROM invoice_line il JOIN invoice iv ON iv.id = il.invoice_id WHERE il.id = l.invoice_line_id AND iv.kind = 'invoice' AND iv.deleted_at IS NULL AND iv.status <> 'cancelled')`;

/** Expense claims with per-line partial approval, advances with a balance ledger, payouts, and client re-billing (M14 + M9). */
@Injectable()
export class ExpensesService {
  constructor(private db: DbService, private audit: AuditService, private clock: Clock) {}

  private rec(tx: Tx, a: RequestActor, action: string, entity: string, entityId: string, diff: unknown) {
    return this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action, entity, entityId, diff });
  }

  /** Validates lines (category active; policy limit warn → flag, block → 400; client visible; receipt uploaded by the claimant). */
  private async writeLines(tx: Tx, a: RequestActor, claimId: string, lines: ExpenseLineIn[]) {
    const cats = new Map((await tx.query('SELECT * FROM expense_category WHERE deleted_at IS NULL AND active')).rows.map((c) => [c.key as string, c]));
    let total = 0; const warnings: string[] = [];
    await tx.query('DELETE FROM expense_line WHERE claim_id = $1', [claimId]);
    for (const [k, l] of lines.entries()) {
      const cat = cats.get(l.categoryKey);
      if (!cat) throw new BadRequestException({ message: `Unknown category ${l.categoryKey}`, code: 'invalid_category' });
      let flag: string | null = null;
      if (cat.limit_paise !== null && l.amountPaise > Number(cat.limit_paise)) {
        if (cat.limit_mode === 'block') throw new BadRequestException({ message: `${cat.name} is limited to ₹${Number(cat.limit_paise) / 100} per line`, code: 'over_limit' });
        flag = 'over_limit'; warnings.push(`line ${k + 1}: over ${cat.name} limit`);
      }
      if (l.spentOn > this.clock.todayIst()) throw new BadRequestException({ message: 'Expense date in the future', code: 'future_date' });
      if (l.billable && !l.clientId) throw new BadRequestException({ message: 'A billable expense needs a client', code: 'client_required' });
      if (l.clientId) {
        const c = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [l.clientId])).rows[0];
        if (!c || !can(a, 'clients', 'view', clientCtx(visibilityOf(c)))) throw new BadRequestException({ message: 'Client not found', code: 'invalid_client' });
      }
      if (l.receiptDocId && !(await tx.query('SELECT 1 FROM document WHERE id = $1 AND deleted_at IS NULL AND uploaded_by = $2', [l.receiptDocId, a.userId])).rowCount) {
        throw new BadRequestException({ message: 'Receipt document not found', code: 'invalid_receipt' });
      }
      await tx.query(`INSERT INTO expense_line (id, tenant_id, claim_id, sort, category_key, spent_on, description, amount_paise, client_id, billable, receipt_doc_id, policy_flag)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [uuidv7(), a.tenantId, claimId, k, l.categoryKey, l.spentOn, l.description, l.amountPaise, l.clientId ?? null, !!l.billable, l.receiptDocId ?? null, flag]);
      total += l.amountPaise;
    }
    await tx.query('UPDATE expense_claim SET claimed_paise = $2, updated_by = $3 WHERE id = $1', [claimId, total, a.userId]);
    return { total, warnings };
  }

  async create(a: RequestActor, i: { title: string; lines: ExpenseLineIn[]; submit?: boolean }) {
    requireOwn(a, 'hr');
    const id = uuidv7();
    const w = await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query('INSERT INTO expense_claim (id, tenant_id, user_id, title, updated_by, device_id) VALUES ($1,$2,$3,$4,$3,$5)', [id, a.tenantId, a.userId, i.title, a.deviceId]);
      const r = await this.writeLines(tx, a, id, i.lines);
      if (i.submit) await tx.query(`UPDATE expense_claim SET status = 'submitted', submitted_at = $2 WHERE id = $1`, [id, this.clock.now().toISOString()]);
      await this.rec(tx, a, 'expense_claim.created', 'expense_claim', id, { title: i.title, lines: i.lines.length, claimedPaise: r.total, submitted: !!i.submit });
      return r.warnings;
    });
    return { id, warnings: w };
  }

  private async own(tx: Tx, a: RequestActor, id: string) {
    const c = (await tx.query('SELECT * FROM expense_claim WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE', [id, a.userId])).rows[0];
    if (!c) throw new NotFoundException();
    return c;
  }

  async update(a: RequestActor, id: string, i: { title?: string; lines?: ExpenseLineIn[] }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await this.own(tx, a, id);
      if (c.status !== 'draft') throw new ConflictException({ message: 'Only drafts can be edited', code: 'claim_not_draft' });
      if (i.title) await tx.query('UPDATE expense_claim SET title = $2, updated_by = $3 WHERE id = $1', [id, i.title, a.userId]);
      const r = i.lines ? await this.writeLines(tx, a, id, i.lines) : { warnings: [] };
      await this.rec(tx, a, 'expense_claim.updated', 'expense_claim', id, { title: i.title, lines: i.lines?.length });
      return { warnings: r.warnings };
    });
  }

  async submit(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await this.own(tx, a, id);
      if (c.status !== 'draft') throw new ConflictException({ message: 'Only drafts can be submitted', code: 'claim_not_draft' });
      await tx.query(`UPDATE expense_claim SET status = 'submitted', submitted_at = $2, updated_by = $3 WHERE id = $1`, [id, this.clock.now().toISOString(), a.userId]);
      await this.rec(tx, a, 'expense_claim.submitted', 'expense_claim', id, null);
    });
  }

  list(a: RequestActor, q: { userId?: string; status?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const w = ['x.deleted_at IS NULL', personScopeSql(a, 'hr', 'view', p)];
      if (q.userId) w.push(`x.user_id = ${p.add(q.userId)}::uuid`);
      if (q.status) w.push(`x.status = ${p.add(q.status)}`);
      return (await tx.query(`SELECT x.*, u.name AS user_name FROM expense_claim x JOIN app_user u ON u.id = x.user_id WHERE ${w.join(' AND ')} ORDER BY x.created_at DESC LIMIT 500`, p.values)).rows.map(presentClaim);
    });
  }

  private async visibleClaim(tx: Tx, a: RequestActor, id: string, lock = false) {
    const p = new Params([id]);
    const c = (await tx.query(`SELECT x.*, u.name AS user_name FROM expense_claim x JOIN app_user u ON u.id = x.user_id WHERE x.id = $1 AND x.deleted_at IS NULL AND ${personScopeSql(a, 'hr', 'view', p)}${lock ? ' FOR UPDATE OF x' : ''}`, p.values)).rows[0];
    if (!c) throw new NotFoundException();
    return c;
  }

  get(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await this.visibleClaim(tx, a, id);
      const lines = (await tx.query('SELECT * FROM expense_line WHERE claim_id = $1 ORDER BY sort', [id])).rows;
      return { ...presentClaim(c), lines: lines.map(presentLine) };
    });
  }

  /** Per-line decision: approved ≤ claimed; all zero → rejected; less than claimed → partially_approved (D93). */
  async decide(a: RequestActor, id: string, i: { approve: boolean; lines?: Array<{ id: string; approvedPaise: number; note?: string | null }>; note?: string | null }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await this.visibleClaim(tx, a, id, true);
      await requireApprover(tx, a, 'hr', c.user_id);
      if (c.status !== 'submitted') throw new ConflictException({ message: 'Only submitted claims can be decided', code: 'not_submitted' });
      const lines = (await tx.query('SELECT * FROM expense_line WHERE claim_id = $1 ORDER BY sort', [id])).rows;
      const given = new Map((i.lines ?? []).map((l) => [l.id, l]));
      for (const g of given.keys()) if (!lines.some((l) => l.id === g)) throw new BadRequestException({ message: 'Unknown line', code: 'invalid_line' });
      let total = 0;
      for (const l of lines) {
        const g = given.get(l.id);
        const amt = !i.approve ? 0 : g ? g.approvedPaise : n(l.amount_paise);
        if (amt < 0 || amt > n(l.amount_paise)) throw new BadRequestException({ message: 'Approved amount must be between 0 and the claimed amount', code: 'invalid_amount' });
        await tx.query('UPDATE expense_line SET approved_paise = $2, decision_note = $3 WHERE id = $1', [l.id, amt, g?.note ?? null]);
        total += amt;
      }
      const status = total === 0 ? 'rejected' : total < n(c.claimed_paise) ? 'partially_approved' : 'approved';
      await tx.query('UPDATE expense_claim SET status = $2, approved_paise = $3, decided_by = $4, decided_at = $5, decision_note = $6, updated_by = $4 WHERE id = $1',
        [id, status, total, a.userId, this.clock.now().toISOString(), i.note ?? null]);
      await this.rec(tx, a, `expense_claim.${status}`, 'expense_claim', id, { approvedPaise: total, lines: [...given.values()].map((l) => ({ id: l.id, approvedPaise: l.approvedPaise })) });
      return { status, approvedPaise: total };
    });
  }

  /**
   * Payout (firm-wide hr:approve, never one's own): the claimant's open advances are settled first, oldest first, up to the
   * approved amount (advance ledger −); the rest is paid out.
   */
  async pay(a: RequestActor, id: string, i: { reference: string }) {
    requireFirmWide(a, 'hr', 'approve');
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await this.visibleClaim(tx, a, id, true);
      if (c.user_id === a.userId) throw new ForbiddenException({ message: 'You cannot pay your own claim', code: 'self_approval' });
      if (!['approved', 'partially_approved'].includes(c.status)) throw new ConflictException({ message: 'Claim is not approved', code: 'not_approved' });
      let left = n(c.approved_paise); let settled = 0;
      const advs = (await tx.query(`SELECT a.id, COALESCE((SELECT sum(delta_paise) FROM advance_ledger l WHERE l.advance_id = a.id),0) AS bal FROM expense_advance a
        WHERE a.user_id = $1 AND a.status = 'paid' AND a.deleted_at IS NULL ORDER BY a.paid_at, a.id FOR UPDATE OF a`, [c.user_id])).rows;
      for (const adv of advs) {
        const take = Math.min(left, n(adv.bal));
        if (take <= 0) continue;
        await tx.query(`INSERT INTO advance_ledger (id, tenant_id, user_id, advance_id, claim_id, delta_paise, kind, created_by) VALUES ($1,$2,$3,$4,$5,$6,'settled',$7)`,
          [uuidv7(), a.tenantId, c.user_id, adv.id, id, -take, a.userId]);
        if (take === n(adv.bal)) await tx.query(`UPDATE expense_advance SET status = 'settled', updated_by = $2 WHERE id = $1`, [adv.id, a.userId]);
        left -= take; settled += take;
      }
      await tx.query(`UPDATE expense_claim SET status = 'paid', advance_settled_paise = $2, paid_paise = $3, paid_at = $4, paid_by = $5, payout_ref = $6, updated_by = $5 WHERE id = $1`,
        [id, settled, left, this.clock.now().toISOString(), a.userId, i.reference]);
      await this.rec(tx, a, 'expense_claim.paid', 'expense_claim', id, { advanceSettledPaise: settled, paidPaise: left, reference: i.reference });
      return { advanceSettledPaise: settled, paidPaise: left };
    });
  }

  // ---------- Advances ----------

  async requestAdvance(a: RequestActor, i: { purpose: string; amountPaise: number }) {
    requireOwn(a, 'hr');
    const id = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query('INSERT INTO expense_advance (id, tenant_id, user_id, purpose, amount_paise, updated_by) VALUES ($1,$2,$3,$4,$5,$3)', [id, a.tenantId, a.userId, i.purpose, i.amountPaise]);
      await this.rec(tx, a, 'expense_advance.requested', 'expense_advance', id, i);
    });
    return { id };
  }

  advances(a: RequestActor, q: { userId?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const w = ['x.deleted_at IS NULL', personScopeSql(a, 'hr', 'view', p)];
      if (q.userId) w.push(`x.user_id = ${p.add(q.userId)}::uuid`);
      const rows = (await tx.query(`SELECT x.*, u.name AS user_name, COALESCE((SELECT sum(delta_paise) FROM advance_ledger l WHERE l.advance_id = x.id),0) AS balance_paise
        FROM expense_advance x JOIN app_user u ON u.id = x.user_id WHERE ${w.join(' AND ')} ORDER BY x.created_at DESC`, p.values)).rows;
      return { items: rows.map(presentAdvance), outstandingPaise: rows.reduce((s, r) => s + n(r.balance_paise), 0) };
    });
  }

  private async visibleAdvance(tx: Tx, a: RequestActor, id: string) {
    const p = new Params([id]);
    const r = (await tx.query(`SELECT x.* FROM expense_advance x WHERE x.id = $1 AND x.deleted_at IS NULL AND ${personScopeSql(a, 'hr', 'view', p)} FOR UPDATE`, p.values)).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }

  /** Approve (optionally a lower amount) or reject: manager or hr:approve, never self. */
  async decideAdvance(a: RequestActor, id: string, i: { approve: boolean; approvedPaise?: number; note?: string | null }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.visibleAdvance(tx, a, id);
      await requireApprover(tx, a, 'hr', r.user_id);
      if (r.status !== 'requested') throw new ConflictException({ message: 'Already decided', code: 'not_pending' });
      const amt = i.approve ? i.approvedPaise ?? n(r.amount_paise) : null;
      if (amt !== null && (amt <= 0 || amt > n(r.amount_paise))) throw new BadRequestException({ message: 'Approved amount must be between 1 paisa and the requested amount', code: 'invalid_amount' });
      await tx.query('UPDATE expense_advance SET status = $2, approved_paise = $3, decided_by = $4, decided_at = $5, decision_note = $6, updated_by = $4 WHERE id = $1',
        [id, i.approve ? 'approved' : 'rejected', amt, a.userId, this.clock.now().toISOString(), i.note ?? null]);
      await this.rec(tx, a, i.approve ? 'expense_advance.approved' : 'expense_advance.rejected', 'expense_advance', id, { approvedPaise: amt });
      return { status: i.approve ? 'approved' : 'rejected', approvedPaise: amt };
    });
  }

  /** Marks an approved advance paid out: the advance ledger gets +approved (firm-wide hr:approve, never self). */
  async payAdvance(a: RequestActor, id: string, i: { reference: string }) {
    requireFirmWide(a, 'hr', 'approve');
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.visibleAdvance(tx, a, id);
      if (r.user_id === a.userId) throw new ForbiddenException({ message: 'You cannot pay your own advance', code: 'self_approval' });
      if (r.status !== 'approved') throw new ConflictException({ message: 'Advance is not approved', code: 'not_approved' });
      await tx.query(`INSERT INTO advance_ledger (id, tenant_id, user_id, advance_id, delta_paise, kind, created_by) VALUES ($1,$2,$3,$4,$5,'paid',$6)`, [uuidv7(), a.tenantId, r.user_id, id, r.approved_paise, a.userId]);
      await tx.query(`UPDATE expense_advance SET status = 'paid', paid_at = $2, paid_by = $3, payout_ref = $4, updated_by = $3 WHERE id = $1`, [id, this.clock.now().toISOString(), a.userId, i.reference]);
      await this.rec(tx, a, 'expense_advance.paid', 'expense_advance', id, { amountPaise: n(r.approved_paise), reference: i.reference });
    });
  }

  // ---------- Re-billing to clients (Phase 5 reimbursements) ----------

  /** Approved billable expense lines not yet on a live invoice, for clients the caller may view for billing (D94). */
  reimbursable(a: RequestActor, q: { clientId?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const w = [`l.billable`, `l.approved_paise > 0`, `x.status IN ('approved','partially_approved','paid')`, `x.deleted_at IS NULL`, `NOT (l.invoice_line_id IS NOT NULL AND ${LINKED})`,
        `c.deleted_at IS NULL`, scopeSql(a, 'billing', 'view', p)];
      if (q.clientId) w.push(`l.client_id = ${p.add(q.clientId)}::uuid`);
      const rows = (await tx.query(`SELECT l.*, c.name AS client_name, u.name AS user_name FROM expense_line l JOIN expense_claim x ON x.id = l.claim_id JOIN client c ON c.id = l.client_id
        JOIN app_user u ON u.id = x.user_id WHERE ${w.join(' AND ')} ORDER BY c.name, l.spent_on`, p.values)).rows;
      return { totalPaise: rows.reduce((s, r) => s + n(r.approved_paise), 0),
        items: rows.map((r) => ({ ...presentLine(r), clientName: r.client_name, claimantName: r.user_name, suggestedLine: { description: `Reimbursement: ${r.description} (${isoDay(r.spent_on)})`, ratePaise: n(r.approved_paise), reimbursement: true } })) };
    });
  }

  /**
   * Links a billable expense line to a reimbursement line of the client's (non-cancelled) invoice, once. The invoice line
   * total must equal the approved amount. Needs billing:edit on the client.
   */
  async link(a: RequestActor, lineId: string, invoiceLineId: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const l = (await tx.query(`SELECT l.*, x.status AS claim_status, ${`(l.invoice_line_id IS NOT NULL AND ${LINKED})`} AS linked FROM expense_line l JOIN expense_claim x ON x.id = l.claim_id
        WHERE l.id = $1 AND x.deleted_at IS NULL FOR UPDATE OF l`, [lineId])).rows[0];
      const client = l?.client_id ? (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [l.client_id])).rows[0] : null;
      if (!l || !client || !canClient(a, 'billing', 'edit', client)) throw new NotFoundException();
      if (!l.billable || !(n(l.approved_paise) > 0) || !['approved', 'partially_approved', 'paid'].includes(l.claim_status)) throw new ConflictException({ message: 'Expense is not an approved billable line', code: 'not_reimbursable' });
      if (l.linked) throw new ConflictException({ message: 'Expense already billed', code: 'already_billed' });
      const il = (await tx.query(`SELECT il.*, iv.client_id, iv.status, iv.deleted_at, iv.kind FROM invoice_line il JOIN invoice iv ON iv.id = il.invoice_id WHERE il.id = $1`, [invoiceLineId])).rows[0];
      if (!il || il.deleted_at || il.client_id !== l.client_id) throw new BadRequestException({ message: 'Invoice line not found for this client', code: 'invalid_invoice_line' });
      if (il.kind !== 'invoice' || il.status === 'cancelled' || !il.reimbursement) throw new BadRequestException({ message: 'Use a reimbursement line of a live invoice', code: 'invalid_invoice_line' });
      if (n(il.total_paise) !== n(l.approved_paise)) throw new ConflictException({ message: 'Invoice line amount differs from the approved expense', code: 'amount_mismatch' });
      try {
        await tx.query('SAVEPOINT k');
        await tx.query('UPDATE expense_line SET invoice_line_id = $2, linked_at = $3, linked_by = $4 WHERE id = $1', [lineId, invoiceLineId, this.clock.now().toISOString(), a.userId]);
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT k');
        if ((e as { code?: string }).code === '23505') throw new ConflictException({ message: 'That invoice line already carries another expense', code: 'invoice_line_taken' });
        throw e;
      }
      await this.rec(tx, a, 'expense_line.billed', 'expense_line', lineId, { invoiceLineId, invoiceId: il.invoice_id, amountPaise: n(l.approved_paise) });
    });
  }
}
