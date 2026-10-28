import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { dueStep, formatINR } from '@worko/domain';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { todayIst } from '../compliance/facts.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { systemActor } from '../tasks/system-actor.js';
import { addDays, d, loadSettings, n } from './common.js';
import { Cursor, InvoicesService } from './invoices.service.js';
import {
  assertPaymentConfig, CLIENT_MESSENGER, type ClientMessenger, defaultPaymentProvider, mockPaymentsAllowed, PAYMENT_PROVIDERS, type PaymentProvider, publicBase, signInvoiceLink,
} from './providers.js';
import { ReceiptsService } from './receipts.service.js';

export const FOLLOWUP_JOB = 'billing.followups';
export const MAX_SEND_ATTEMPTS = 3;
const OPEN = `i.deleted_at IS NULL AND i.kind IN ('invoice','debit_note') AND i.status IN ('issued','partially_paid') AND i.balance_paise > 0`;
const rs = (p: unknown) => `Rs. ${formatINR(n(p), { symbol: false })}`;

/** Follow-up ladder, "send invoice" messages, payment links and the payment webhook. */
@Injectable()
export class CollectionsService implements OnModuleInit {
  private log = new Logger('Collections');
  constructor(
    private db: DbService, private audit: AuditService, private invoices: InvoicesService, private receipts: ReceiptsService, private notifications: NotificationsService,
    private realtime: RealtimeService, private jobs: JobQueueService, private clock: Clock,
    @Inject(CLIENT_MESSENGER) private messenger: ClientMessenger, @Inject(PAYMENT_PROVIDERS) private providers: Record<string, PaymentProvider>,
  ) {}

  onModuleInit() {
    assertPaymentConfig(); // refuses to boot in production with a missing/default webhook secret or the mock provider
    this.jobs.register(FOLLOWUP_JOB, async (job, at) => {
      const day = todayIst(at);
      const r = await this.runFollowups(job.tenant_id, day);
      if (r.sent) this.log.log(`Tenant ${job.tenant_id}: ${r.sent} follow-ups for ${day}`);
      throw new Reschedule(new Date(`${addDays(day, 1)}T10:00:00+05:30`));
    });
    if (Number(process.env.JOB_POLL_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 2000)) > 0) {
      void this.scheduleDaily(new Date(`${addDays(todayIst(), 1)}T10:00:00+05:30`)).catch((e) => this.log.error(e));
    }
  }

  async scheduleDaily(at: Date) {
    return (await this.db.systemTx((tx) => tx.query(
      `INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) SELECT t.id, $1, t.id, $2 FROM tenant t
       ON CONFLICT (tenant_id, kind) WHERE kind IN ('billing.followups','billing.retainers') AND dead_at IS NULL DO NOTHING`, [FOLLOWUP_JOB, at]))).rowCount ?? 0;
  }

  /** Where a client's messages go: its own email/phone, else its primary contact's. */
  private async recipient(tx: Tx, client: Record<string, unknown>, channel: 'email' | 'whatsapp'): Promise<string | null> {
    const own = channel === 'email' ? client.email : client.phone;
    if (own) return own as string;
    const c = (await tx.query(`SELECT email, phone FROM contact WHERE client_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, id LIMIT 1`, [client.id])).rows[0];
    return (channel === 'email' ? c?.email : c?.phone) ?? null;
  }

  /** A link the client can open: the live payment link if any, else a 30-day signed invoice link. Never the document itself. */
  private async linkFor(tx: Tx, tenantId: string, inv: Record<string, unknown>, asOf: string) {
    const pl = (await tx.query(`SELECT url FROM payment_link WHERE invoice_id = $1 AND status = 'created' ORDER BY created_at DESC LIMIT 1`, [inv.id])).rows[0];
    if (pl) return pl.url as string;
    return `${publicBase()}/billing/public/${signInvoiceLink(tenantId, inv.id as string, new Date(`${addDays(asOf, 30)}T23:59:59+05:30`))}`;
  }

  private text(inv: Record<string, unknown>, firm: string, link: string, reminder: boolean) {
    const subject = `${reminder ? 'Payment reminder' : 'Invoice'} ${inv.number} from ${firm}`;
    const body = `${reminder ? 'Reminder: ' : ''}Invoice ${inv.number} dated ${d(inv.issue_date)} for ${rs(inv.total_paise)} is due on ${d(inv.due_date)}. `
      + `Balance due: ${rs(inv.balance_paise)}. View / pay: ${link}`;
    return { subject, body };
  }

  /**
   * Daily follow-ups (D70, D79). No external I/O inside a tenant-wide transaction:
   * 1. plan (read-only tx) → 2. per invoice × step × channel, claim the slot in its own short tx and commit →
   * 3. send outside any tx → 4. record the outcome in another short tx (+ audit).
   * A failed send is retried on the next run up to MAX_SEND_ATTEMPTS; sent slots are never re-sent (unique index).
   * Escalations are in-app only (no external I/O), so they are claimed and notified in one short tx.
   */
  async runFollowups(tenantId: string, asOf: string): Promise<{ sent: number; failed: number; skipped: number; escalated: number }> {
    let sent = 0; let failed = 0; let skipped = 0; let escalated = 0;
    const plan = await this.db.tenantTx(tenantId, async (tx) => {
      const s = await loadSettings(tx);
      const firm = (await tx.query('SELECT name FROM tenant LIMIT 1')).rows[0]?.name ?? '';
      const rows = (await tx.query(`SELECT i.*, c.name AS client_name, c.email AS c_email, c.phone AS c_phone, c.partner_id, c.manager_id FROM invoice i JOIN client c ON c.id = i.client_id
        WHERE ${OPEN} AND c.deleted_at IS NULL AND NOT i.followup_paused AND i.due_date IS NOT NULL AND (i.promise_to_pay IS NULL OR i.promise_to_pay < $1::date)
        ORDER BY i.due_date, i.id`, [asOf])).rows;
      const items: Array<{ inv: Record<string, unknown>; step: number; escalate: boolean; target: string | null;
        sends: Array<{ channel: 'email' | 'whatsapp'; to: string | null; subject: string; body: string }> }> = [];
      for (const inv of rows) {
        const step = dueStep(s.ladder, d(inv.due_date)!, asOf);
        if (!step) continue;
        const client = { id: inv.client_id, email: inv.c_email, phone: inv.c_phone };
        const link = await this.linkFor(tx, tenantId, inv, asOf);
        const sends = [];
        for (const ch of step.channels) sends.push({ channel: ch, to: await this.recipient(tx, client, ch), ...this.text(inv, firm, link, true) });
        items.push({ inv, step: step.step, escalate: !!step.escalate, target: inv.partner_id ?? inv.manager_id ?? null, sends });
      }
      return items;
    });
    let cursor = 0;
    for (const it of plan) {
      const inv = it.inv;
      for (const m of it.sends) {
        // Claim (own tx, committed before sending): new slot, or a failed one with attempts left.
        const claim = await this.db.tenantTx(tenantId, async (tx) => (await tx.query(
          `INSERT INTO billing_message (id, tenant_id, invoice_id, kind, step, channel, status, as_of) VALUES ($1,$2,$3,'followup',$4,$5,'pending',$6)
           ON CONFLICT (invoice_id, step, channel) WHERE kind IN ('followup','escalation')
           DO UPDATE SET status = 'pending', attempts = billing_message.attempts + 1, as_of = EXCLUDED.as_of, updated_at = now()
             WHERE billing_message.status = 'failed' AND billing_message.attempts < ${MAX_SEND_ATTEMPTS}
           RETURNING id, attempts`, [uuidv7(), tenantId, inv.id, it.step, m.channel, asOf])).rows[0] as { id: string; attempts: number } | undefined);
        if (!claim) continue;
        if (!m.to) {
          await this.db.tenantTx(tenantId, (tx) => tx.query(`UPDATE billing_message SET status = 'skipped', detail = 'no_recipient', updated_at = now() WHERE id = $1`, [claim.id]));
          skipped++; continue;
        }
        let res: { status: 'sent' | 'failed'; ref?: string; error?: string };
        try { res = await this.messenger.send({ tenantId, channel: m.channel, to: m.to, subject: m.subject, text: m.body, invoiceId: inv.id as string }); }
        catch (e) { res = { status: 'failed', error: (e as Error).message.slice(0, 300) }; }
        await this.db.tenantTx(tenantId, async (tx) => {
          await tx.query('UPDATE billing_message SET status = $2, recipient = $3, provider_ref = $4, detail = $5, updated_at = now() WHERE id = $1',
            [claim.id, res.status, mask(m.to!), res.ref ?? null, res.error ?? null]);
          await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'invoice.followup_sent', entity: 'invoice', entityId: inv.id as string,
            diff: { step: it.step, channel: m.channel, status: res.status, attempt: claim.attempts, asOf } });
        });
        if (res.status === 'sent') sent++; else failed++;
      }
      if (it.escalate && it.target) {
        const c = await this.db.tenantTx(tenantId, async (tx) => {
          const claim = await tx.query(`INSERT INTO billing_message (id, tenant_id, invoice_id, kind, step, channel, status, recipient, as_of) VALUES ($1,$2,$3,'escalation',$4,'in_app','sent',$5,$6)
            ON CONFLICT (invoice_id, step, channel) WHERE kind IN ('followup','escalation') DO NOTHING RETURNING id`, [uuidv7(), tenantId, inv.id, it.step, it.target, asOf]);
          if (!claim.rowCount) return 0;
          const nres = await this.notifications.notifyInTx(tx, tenantId, { userIds: [it.target!], category: 'invoice.due', priority: 'high',
            title: `Overdue: ${inv.number} — ${inv.client_name}`, body: `${rs(inv.balance_paise)} outstanding since ${d(inv.due_date)}`, entityType: 'invoice', entityId: inv.id as string,
            dedupeKey: `invoice-escalation:${inv.id}:${it.step}` });
          await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'invoice.followup_escalated', entity: 'invoice', entityId: inv.id as string, diff: { step: it.step, to: it.target } });
          escalated++;
          return nres.cursor;
        });
        cursor = Math.max(cursor, c);
      }
    }
    if (cursor) this.realtime.publish({ type: 'changed', tenantId, cursor });
    return { sent, failed, skipped, escalated };
  }

  /** "Send invoice": a link by email/WhatsApp. Read in one tx, send outside, log + audit in another. */
  async send(a: RequestActor, id: string, channel: 'email' | 'whatsapp', asOf = this.clock.todayIst()) {
    const m = await this.db.tenantTx(a.tenantId, async (tx) => {
      const { inv, client } = await this.invoices.rowFor(tx, a, id, 'edit');
      if (inv.status === 'draft' || inv.status === 'cancelled') throw new ConflictException({ message: 'Issue the invoice first', code: 'invoice_not_issued' });
      const to = await this.recipient(tx, client, channel);
      if (!to) throw new BadRequestException({ message: `Client has no ${channel === 'email' ? 'email' : 'phone'}`, code: 'no_recipient' });
      const firm = (await tx.query('SELECT name FROM tenant LIMIT 1')).rows[0]?.name ?? '';
      return { to, ...this.text(inv, firm, await this.linkFor(tx, a.tenantId, inv, asOf), false) };
    });
    let res: { status: 'sent' | 'failed'; ref?: string; error?: string };
    try { res = await this.messenger.send({ tenantId: a.tenantId, channel, to: m.to, subject: m.subject, text: m.body, invoiceId: id }); }
    catch (e) { res = { status: 'failed', error: (e as Error).message.slice(0, 300) }; }
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`INSERT INTO billing_message (id, tenant_id, invoice_id, kind, channel, recipient, status, provider_ref, detail, as_of, created_by) VALUES ($1,$2,$3,'send',$4,$5,$6,$7,$8,$9,$10)`,
        [uuidv7(), a.tenantId, id, channel, mask(m.to), res.status, res.ref ?? null, res.error ?? null, asOf, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'invoice.sent', entity: 'invoice', entityId: id, diff: { channel, status: res.status } });
    });
    return { status: res.status };
  }

  /** Payment link for the current balance (computed here — never taken from the caller). */
  async paymentLink(a: RequestActor, id: string) {
    const prov = this.providers[defaultPaymentProvider()];
    if (!prov) throw new BadRequestException('Payment provider not configured');
    const { inv, client } = await this.db.tenantTx(a.tenantId, (tx) => this.invoices.rowFor(tx, a, id, 'edit'));
    if (!['issued', 'partially_paid'].includes(inv.status as string) || n(inv.balance_paise) <= 0) throw new ConflictException({ message: 'Nothing to collect', code: 'invoice_not_open' });
    // Supersede: cancel live links at the provider first (outside any tx), so an old link can't be paid later.
    const old = await this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT id, provider, provider_link_id FROM payment_link WHERE invoice_id = $1 AND status = 'created'`, [id])).rows);
    for (const o of old) {
      const p = this.providers[o.provider];
      if (p) await p.cancelLink(o.provider_link_id);
      await this.db.tenantTx(a.tenantId, (tx) => tx.query(`UPDATE payment_link SET status = 'cancelled' WHERE id = $1 AND status = 'created'`, [o.id]));
    }
    const link = await prov.createLink({ tenantId: a.tenantId, invoiceId: id, invoiceNumber: inv.number as string, amountPaise: n(inv.balance_paise),
      customer: { name: client.name as string, email: client.email as string | null, phone: client.phone as string | null } });
    const pid = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query('INSERT INTO payment_link (id, tenant_id, invoice_id, provider, provider_link_id, url, amount_paise, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [pid, a.tenantId, id, prov.name, link.linkId, link.url, n(inv.balance_paise), a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'invoice.payment_link', entity: 'invoice', entityId: id, diff: { provider: prov.name, amountPaise: n(inv.balance_paise) } });
    });
    return { id: pid, url: link.url, amountPaise: n(inv.balance_paise), provider: prov.name };
  }

  /**
   * Provider webhook (public). Signature over the raw body first; then one row per provider event id (replays are no-ops);
   * a paid event records a gateway receipt allocated to the link's invoice (rest = advance). The amount is the provider's.
   */
  async webhook(providerName: string, tenantId: string, raw: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const prov = this.providers[providerName];
    if (!prov || (providerName === 'mock' && !mockPaymentsAllowed())) throw new NotFoundException();
    if (!isUuid(tenantId) || !(await this.db.systemTx((tx) => tx.query('SELECT 1 FROM tenant WHERE id = $1', [tenantId]))).rowCount) throw new NotFoundException();
    if (!raw || !prov.verify(raw, headers)) throw new UnauthorizedException({ message: 'Bad signature', code: 'bad_signature' });
    let ev;
    try { ev = prov.parse(raw, headers); } catch { ev = null; }
    if (!ev) throw new BadRequestException('Unrecognised event');
    const a = systemActor(tenantId);
    const cur = new Cursor();
    const out = await this.db.tenantTx(tenantId, async (tx) => {
      const evId = uuidv7();
      const ins = await tx.query(`INSERT INTO payment_event (id, tenant_id, provider, event_id, event_type, body_sha256, outcome) VALUES ($1,$2,$3,$4,$5,$6,'received')
        ON CONFLICT (tenant_id, provider, event_id) DO NOTHING RETURNING id`, [evId, tenantId, prov.name, ev.eventId, ev.type, createHash('sha256').update(raw).digest('hex')]);
      if (!ins.rowCount) return { status: 'duplicate' as const };
      const done = async (outcome: string, receiptId: string | null = null) => {
        await tx.query('UPDATE payment_event SET outcome = $2, receipt_id = $3 WHERE id = $1', [evId, outcome, receiptId]);
        await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'payment.webhook', entity: 'payment_event', entityId: evId, diff: { provider: prov.name, eventId: ev.eventId, type: ev.type, outcome, receiptId } });
        return { status: outcome };
      };
      if (!ev.paid || ev.amountPaise <= 0 || !ev.linkId) return done('ignored');
      const link = (await tx.query('SELECT * FROM payment_link WHERE provider = $1 AND provider_link_id = $2 FOR UPDATE', [prov.name, ev.linkId])).rows[0];
      if (!link) return done('unknown_link');
      if (ev.paymentId && (await tx.query('SELECT 1 FROM receipt WHERE provider = $1 AND provider_payment_id = $2', [prov.name, ev.paymentId])).rowCount) return done('duplicate_payment');
      const inv = (await tx.query('SELECT i.*, c.partner_id, c.manager_id FROM invoice i JOIN client c ON c.id = i.client_id WHERE i.id = $1', [link.invoice_id])).rows[0];
      // Money on a superseded/cancelled/already-paid link was still received: record it, but as an unallocated advance flagged for review (D81).
      const review = link.status !== 'created';
      const open = !review && ['issued', 'partially_paid'].includes(inv.status) ? Math.min(n(inv.balance_paise), ev.amountPaise) : 0;
      const rec = await this.receipts.createTx(tx, a, {
        clientId: inv.client_id, entityId: inv.entity_id, receivedOn: this.clock.todayIst(), amountPaise: ev.amountPaise, mode: 'online', reference: ev.paymentId ?? ev.eventId,
        allocations: open > 0 ? [{ invoiceId: inv.id, amountPaise: open }] : [],
      }, cur, { provider: prov.name, paymentId: ev.paymentId ?? ev.eventId });
      if (review) {
        await tx.query(`UPDATE receipt SET needs_review = true, review_note = $2 WHERE id = $1`, [rec.id, `Paid on a ${link.status} payment link for ${inv.number}; kept as advance`]);
        const target = inv.partner_id ?? inv.manager_id;
        if (target) {
          const nres = await this.notifications.notifyInTx(tx, tenantId, { userIds: [target], category: 'payment.received', priority: 'high',
            title: `Review payment ${rec.number}`, body: `${rs(ev.amountPaise)} paid on a ${link.status} link for ${inv.number} — kept as an advance`, entityType: 'receipt', entityId: rec.id,
            dedupeKey: `payment-review:${rec.id}` });
          cur.bump(nres.cursor);
        }
      } else {
        await tx.query(`UPDATE payment_link SET status = 'paid', paid_at = now() WHERE id = $1`, [link.id]);
      }
      return { ...(await done(review ? 'receipt_needs_review' : 'receipt_recorded', rec.id)), receiptId: rec.id, number: rec.number };
    });
    this.invoices.publish({ tenantId }, cur);
    return out;
  }
}

/** Recipient as logged: enough to recognise, not to harvest. */
const mask = (s: string) => (s.includes('@') ? s.replace(/^(.).*(@.*)$/, '$1•••$2') : s.replace(/.(?=.{4})/g, '•'));
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
