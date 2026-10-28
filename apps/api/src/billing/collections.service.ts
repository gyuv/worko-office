import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { dueStep, formatINR } from '@worko/domain';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { todayIst } from '../compliance/facts.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { systemActor } from '../tasks/system-actor.js';
import { addDays, d, loadSettings, n } from './common.js';
import { Cursor, InvoicesService } from './invoices.service.js';
import {
  CLIENT_MESSENGER, type ClientMessenger, defaultPaymentProvider, PAYMENT_PROVIDERS, type PaymentProvider, publicBase, signInvoiceLink,
} from './providers.js';
import { ReceiptsService } from './receipts.service.js';

export const FOLLOWUP_JOB = 'billing.followups';
const OPEN = `i.deleted_at IS NULL AND i.kind IN ('invoice','debit_note') AND i.status IN ('issued','partially_paid') AND i.balance_paise > 0`;
const rs = (p: unknown) => `Rs. ${formatINR(n(p), { symbol: false })}`;

/** Follow-up ladder, "send invoice" messages, payment links and the payment webhook. */
@Injectable()
export class CollectionsService implements OnModuleInit {
  private log = new Logger('Collections');
  constructor(
    private db: DbService, private audit: AuditService, private invoices: InvoicesService, private receipts: ReceiptsService, private notifications: NotificationsService,
    private realtime: RealtimeService, private jobs: JobQueueService,
    @Inject(CLIENT_MESSENGER) private messenger: ClientMessenger, @Inject(PAYMENT_PROVIDERS) private providers: Record<string, PaymentProvider>,
  ) {}

  onModuleInit() {
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
   * Daily follow-ups (D70): for each open invoice past a ladder step, send that step once per channel (unique index), log it,
   * and escalate in-app to the client's partner on escalation steps. Stops when the invoice is paid/cancelled, paused, or a
   * promise-to-pay date is on or after `asOf`. Steps missed while stopped are not sent retroactively — only the latest one.
   */
  async runFollowups(tenantId: string, asOf: string): Promise<{ sent: number; skipped: number; escalated: number }> {
    let sent = 0; let skipped = 0; let escalated = 0;
    const r = await this.db.tenantTx(tenantId, async (tx) => {
      const s = await loadSettings(tx);
      const firm = (await tx.query('SELECT name FROM tenant LIMIT 1')).rows[0]?.name ?? '';
      const rows = (await tx.query(`SELECT i.*, c.name AS client_name, c.email AS c_email, c.phone AS c_phone, c.partner_id, c.manager_id FROM invoice i JOIN client c ON c.id = i.client_id
        WHERE ${OPEN} AND c.deleted_at IS NULL AND NOT i.followup_paused AND i.due_date IS NOT NULL AND (i.promise_to_pay IS NULL OR i.promise_to_pay < $1::date)
        ORDER BY i.due_date, i.id`, [asOf])).rows;
      let cursor = 0;
      for (const inv of rows) {
        const step = dueStep(s.ladder, d(inv.due_date)!, asOf);
        if (!step) continue;
        const client = { id: inv.client_id, email: inv.c_email, phone: inv.c_phone };
        for (const ch of step.channels) {
          const claim = await tx.query(`INSERT INTO billing_message (id, tenant_id, invoice_id, kind, step, channel, status, as_of) VALUES ($1,$2,$3,'followup',$4,$5,'skipped',$6)
            ON CONFLICT (invoice_id, step, channel) WHERE kind IN ('followup','escalation') DO NOTHING RETURNING id`, [uuidv7(), tenantId, inv.id, step.step, ch, asOf]);
          if (!claim.rowCount) continue; // already done for this step
          const to = await this.recipient(tx, client, ch);
          if (!to) { await tx.query(`UPDATE billing_message SET detail = 'no_recipient' WHERE id = $1`, [claim.rows[0].id]); skipped++; continue; }
          const { subject, body } = this.text(inv, firm, await this.linkFor(tx, tenantId, inv, asOf), true);
          const res = await this.messenger.send({ tenantId, channel: ch, to, subject, text: body, invoiceId: inv.id });
          await tx.query('UPDATE billing_message SET status = $2, recipient = $3, provider_ref = $4, detail = $5 WHERE id = $1',
            [claim.rows[0].id, res.status, mask(to), res.ref ?? null, res.error ?? null]);
          await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'invoice.followup_sent', entity: 'invoice', entityId: inv.id, diff: { step: step.step, channel: ch, status: res.status, asOf } });
          if (res.status === 'sent') sent++;
        }
        const target = inv.partner_id ?? inv.manager_id;
        if (step.escalate && target) {
          const claim = await tx.query(`INSERT INTO billing_message (id, tenant_id, invoice_id, kind, step, channel, status, recipient, as_of) VALUES ($1,$2,$3,'escalation',$4,'in_app','sent',$5,$6)
            ON CONFLICT (invoice_id, step, channel) WHERE kind IN ('followup','escalation') DO NOTHING RETURNING id`, [uuidv7(), tenantId, inv.id, step.step, target, asOf]);
          if (claim.rowCount) {
            const nres = await this.notifications.notifyInTx(tx, tenantId, { userIds: [target], category: 'invoice.due', priority: 'high',
              title: `Overdue: ${inv.number} — ${inv.client_name}`, body: `${rs(inv.balance_paise)} outstanding since ${d(inv.due_date)}`, entityType: 'invoice', entityId: inv.id,
              dedupeKey: `invoice-escalation:${inv.id}:${step.step}` });
            cursor = Math.max(cursor, nres.cursor); escalated++;
            await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'invoice.followup_escalated', entity: 'invoice', entityId: inv.id, diff: { step: step.step, to: target } });
          }
        }
      }
      return cursor;
    });
    if (r) this.realtime.publish({ type: 'changed', tenantId, cursor: r });
    return { sent, skipped, escalated };
  }

  /** "Send invoice": a link by email/WhatsApp (logged + audited). */
  async send(a: RequestActor, id: string, channel: 'email' | 'whatsapp', asOf = todayIst()) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const { inv, client } = await this.invoices.rowFor(tx, a, id, 'edit');
      if (inv.status === 'draft' || inv.status === 'cancelled') throw new ConflictException({ message: 'Issue the invoice first', code: 'invoice_not_issued' });
      const to = await this.recipient(tx, client, channel);
      if (!to) throw new BadRequestException({ message: `Client has no ${channel === 'email' ? 'email' : 'phone'}`, code: 'no_recipient' });
      const firm = (await tx.query('SELECT name FROM tenant LIMIT 1')).rows[0]?.name ?? '';
      const { subject, body } = this.text(inv, firm, await this.linkFor(tx, a.tenantId, inv, asOf), false);
      const res = await this.messenger.send({ tenantId: a.tenantId, channel, to, subject, text: body, invoiceId: id });
      await tx.query(`INSERT INTO billing_message (id, tenant_id, invoice_id, kind, channel, recipient, status, provider_ref, as_of, created_by) VALUES ($1,$2,$3,'send',$4,$5,$6,$7,$8,$9)`,
        [uuidv7(), a.tenantId, id, channel, mask(to), res.status, res.ref ?? null, asOf, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'invoice.sent', entity: 'invoice', entityId: id, diff: { channel, status: res.status } });
      return { status: res.status };
    });
  }

  /** Payment link for the current balance (computed here — never taken from the caller). */
  async paymentLink(a: RequestActor, id: string) {
    const prov = this.providers[defaultPaymentProvider()];
    if (!prov) throw new BadRequestException('Payment provider not configured');
    const { inv, client } = await this.db.tenantTx(a.tenantId, (tx) => this.invoices.rowFor(tx, a, id, 'edit'));
    if (!['issued', 'partially_paid'].includes(inv.status as string) || n(inv.balance_paise) <= 0) throw new ConflictException({ message: 'Nothing to collect', code: 'invoice_not_open' });
    const link = await prov.createLink({ tenantId: a.tenantId, invoiceId: id, invoiceNumber: inv.number as string, amountPaise: n(inv.balance_paise),
      customer: { name: client.name as string, email: client.email as string | null, phone: client.phone as string | null } });
    const pid = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`UPDATE payment_link SET status = 'cancelled' WHERE invoice_id = $1 AND status = 'created'`, [id]);
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
    if (!prov) throw new NotFoundException();
    if (!raw || !prov.verify(raw, headers)) throw new UnauthorizedException({ message: 'Bad signature', code: 'bad_signature' });
    let ev;
    try { ev = prov.parse(raw, headers); } catch { ev = null; }
    if (!ev) throw new BadRequestException('Unrecognised event');
    const exists = (await this.db.systemTx((tx) => tx.query('SELECT 1 FROM tenant WHERE id = $1', [tenantId]))).rowCount;
    if (!exists) throw new NotFoundException();
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
      const inv = (await tx.query('SELECT * FROM invoice WHERE id = $1', [link.invoice_id])).rows[0];
      const open = ['issued', 'partially_paid'].includes(inv.status) ? Math.min(n(inv.balance_paise), ev.amountPaise) : 0;
      const rec = await this.receipts.createTx(tx, a, {
        clientId: inv.client_id, entityId: inv.entity_id, receivedOn: todayIst(), amountPaise: ev.amountPaise, mode: 'online', reference: ev.paymentId ?? ev.eventId,
        allocations: open > 0 ? [{ invoiceId: inv.id, amountPaise: open }] : [],
      }, cur, { provider: prov.name, paymentId: ev.paymentId ?? ev.eventId });
      await tx.query(`UPDATE payment_link SET status = 'paid', paid_at = now() WHERE id = $1`, [link.id]);
      return { ...(await done('receipt_recorded', rec.id)), receiptId: rec.id, number: rec.number };
    });
    this.invoices.publish({ tenantId }, cur);
    return out;
  }
}

/** Recipient as logged: enough to recognise, not to harvest. */
const mask = (s: string) => (s.includes('@') ? s.replace(/^(.).*(@.*)$/, '$1•••$2') : s.replace(/.(?=.{4})/g, '•'));
