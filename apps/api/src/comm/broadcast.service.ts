import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  effectiveScope, maskAddress, normalizeAddress, placeholdersOf, renderTemplate, type CommChannel, type EntityType, type TemplateCategory,
} from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Params } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { tabular } from '../common/export.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { insertNotifications } from '../notifications/insert.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { TransientSendError } from './channels.js';
import { CommService } from './comm.service.js';
import { addressFor, consentError, firmName, istDay, istMonth, loadCommSettings, loadRates, sendTimeFor, unitCost, usedPaise } from './common.js';

export const BROADCAST_JOB = 'comm.broadcast';
export type BroadcastFilters = { groupIds?: string[]; tags?: string[]; serviceTypeIds?: string[]; entityTypes?: EntityType[]; clientIds?: string[]; includeInactive?: boolean };
type BroadcastIn = { name: string; channel: CommChannel; templateId: string; filters: BroadcastFilters; variables?: Record<string, string>; scheduledAt?: string | null };
type Planned = { clientId: string; clientName: string; contactId: string | null; contactName: string | null; address: string | null;
  status: 'pending' | 'skipped_optout' | 'skipped_nocontact' | 'skipped_cap'; reason: string | null; costPaise: number };

const out = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, channel: r.channel, templateId: r.template_id, category: r.category, filters: r.filters, variables: r.variables, scheduledAt: r.scheduled_at,
  status: r.status, estimate: r.estimate, approvedBy: r.approved_by, approvedAt: r.approved_at, cancelledAt: r.cancelled_at, completedAt: r.completed_at,
  spentPaise: Number(r.spent_paise ?? 0), createdBy: r.created_by, createdAt: r.created_at,
});

@Injectable()
export class BroadcastService implements OnModuleInit {
  constructor(private db: DbService, private audit: AuditService, private jobs: JobQueueService, private realtime: RealtimeService, private clock: Clock, private comm: CommService) {}

  onModuleInit() { this.jobs.register(BROADCAST_JOB, (j, at) => this.run(j.tenant_id, j.ref_id, at)); }

  private firmWideView = (a: RequestActor) => !!a.superAdmin || effectiveScope(a, 'communication', 'view')?.scope === 'all';
  private async load(tx: Tx, a: RequestActor, id: string, lock = false) {
    const b = (await tx.query(`SELECT * FROM broadcast WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
    if (!b || (b.created_by !== a.userId && !this.firmWideView(a))) throw new NotFoundException();
    return b;
  }
  private async template(tx: Tx, id: string, channel: CommChannel) {
    const t = (await tx.query('SELECT * FROM comm_template WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
    if (!t || t.channel !== channel) throw new BadRequestException({ message: 'Template not found for this channel', code: 'bad_template' });
    if (t.status !== 'approved') throw new ConflictException({ message: 'Broadcasts need an approved template', code: 'template_not_approved' });
    return t;
  }

  list(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT * FROM broadcast WHERE deleted_at IS NULL AND ($1 OR created_by = $2) ORDER BY created_at DESC LIMIT 200`,
      [this.firmWideView(a), a.userId])).rows.map(out));
  }
  async get(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const b = await this.load(tx, a, id);
      const counts = Object.fromEntries((await tx.query('SELECT status, count(*)::int AS n FROM broadcast_recipient WHERE broadcast_id = $1 GROUP BY status', [id])).rows.map((r) => [r.status, r.n]));
      const total = Object.values(counts).reduce((s: number, n) => s + (n as number), 0);
      const done = total - ((counts.pending as number) ?? 0) - ((counts.sending as number) ?? 0);
      return { ...out(b), progress: { total, done, counts } };
    });
  }
  async create(a: RequestActor, b: BroadcastIn) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const t = await this.template(tx, b.templateId, b.channel);
      this.checkVars(t.body, b.variables);
      const id = uuidv7();
      await tx.query(`INSERT INTO broadcast (id, tenant_id, name, channel, template_id, category, filters, variables, scheduled_at, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [id, a.tenantId, b.name, b.channel, t.id, t.category, JSON.stringify(b.filters), JSON.stringify(b.variables ?? {}), b.scheduledAt ?? null, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.broadcast_created', entity: 'broadcast', entityId: id, diff: { name: b.name, channel: b.channel, templateId: t.id, filters: b.filters } });
      return { id };
    });
  }
  private checkVars(body: string, vars?: Record<string, string>) {
    const bad = Object.keys(vars ?? {}).filter((k) => !placeholdersOf(body).includes(k) || ['client.name', 'contact.name', 'firm.name'].includes(k));
    if (bad.length) throw new BadRequestException({ message: 'Unknown broadcast variables', code: 'bad_variables', issues: bad });
  }

  /** Visible clients (clients:view AND communication:create for the sender) matching the filters, with their address and consent outcome. */
  private async plan(tx: Tx, a: RequestActor, b: Record<string, unknown>): Promise<{ rows: Planned[]; duplicates: number; unitPaise: number; capWarning: boolean }> {
    const f = (b.filters ?? {}) as BroadcastFilters;
    const channel = b.channel as CommChannel; const category = b.category as TemplateCategory;
    const t = (await tx.query('SELECT body FROM comm_template WHERE id = $1', [b.template_id])).rows[0];
    const p = new Params();
    const conds = ['c.deleted_at IS NULL', CommService.audienceScope(a, p)];
    if (!f.includeInactive) conds.push(`c.status = 'active'`);
    if (f.groupIds?.length) conds.push(`c.group_ids && ${p.add(f.groupIds)}::uuid[]`);
    if (f.tags?.length) conds.push(`c.tags && ${p.add(f.tags)}::text[]`);
    if (f.entityTypes?.length) conds.push(`c.entity_type = ANY(${p.add(f.entityTypes)}::text[])`);
    if (f.clientIds?.length) conds.push(`c.id = ANY(${p.add(f.clientIds)}::uuid[])`);
    if (f.serviceTypeIds?.length) conds.push(`EXISTS (SELECT 1 FROM client_service s WHERE s.client_id = c.id AND s.deleted_at IS NULL AND s.active AND s.service_type_id = ANY(${p.add(f.serviceTypeIds)}::uuid[]))`);
    const clients = (await tx.query(`SELECT c.id, c.name FROM client c WHERE ${conds.join(' AND ')} ORDER BY c.name, c.id LIMIT 20000`, p.values)).rows;
    const s = await loadCommSettings(tx); const rates = await loadRates(tx); const now = this.clock.now();
    const consents = new Map((await tx.query('SELECT address, status FROM comm_consent WHERE channel = $1', [channel])).rows.map((r) => [r.address, { status: r.status }]));
    const firm = await firmName(tx);
    const seen = new Set<string>(); let duplicates = 0;
    const rows: Planned[] = [];
    for (const c of clients) {
      const t0 = await addressFor(tx, c.id, channel);
      const address = normalizeAddress(channel, t0.address);
      const base = { clientId: c.id, clientName: c.name, contactId: t0.contactId, contactName: t0.contactName, address, costPaise: 0 };
      if (!address) { rows.push({ ...base, status: 'skipped_nocontact', reason: 'no_address' }); continue; }
      if (seen.has(address)) { duplicates++; continue; }
      seen.add(address);
      const ce = consentError(consents.get(address), category, s);
      if (ce) { rows.push({ ...base, status: 'skipped_optout', reason: ce }); continue; }
      const text = renderTemplate(t.body, { ...(b.variables as Record<string, string>), 'client.name': c.name, 'contact.name': t0.contactName ?? c.name, 'firm.name': firm }).text;
      rows.push({ ...base, status: 'pending', reason: null, costPaise: unitCost(rates, channel, category, text, istDay(now)) });
    }
    // Caps (D101): the monthly budget left for the channel and the per-broadcast cap; in block mode the excess is skipped.
    const unitPaise = rows.find((r) => r.status === 'pending')?.costPaise ?? unitCost(rates, channel, category, t.body, istDay(now));
    const cap = s.caps.monthlyPaise[channel];
    const remainingMonth = cap === null ? null : Math.max(0, cap - await usedPaise(tx, channel, istMonth(now)));
    const remaining = [remainingMonth, s.caps.perBroadcastPaise].filter((x): x is number => x !== null);
    let budget = remaining.length ? Math.min(...remaining) : null;
    let capWarning = false;
    for (const r of rows) {
      if (r.status !== 'pending' || budget === null) continue;
      if (r.costPaise > budget) {
        if (s.caps.mode === 'block') { r.status = 'skipped_cap'; r.reason = 'over_cap'; } else capWarning = true;
      } else budget -= r.costPaise;
    }
    return { rows, duplicates, unitPaise, capWarning };
  }
  private async summary(tx: Tx, b: Record<string, unknown>, planned: { rows: Planned[]; duplicates: number; unitPaise: number; capWarning: boolean }) {
    const s = await loadCommSettings(tx);
    const n = (st: string, reason?: string) => planned.rows.filter((r) => r.status === st && (!reason || r.reason === reason)).length;
    const eligible = n('pending');
    return {
      audience: planned.rows.length + planned.duplicates, eligible, optedOut: n('skipped_optout', 'opted_out'), notOptedIn: n('skipped_optout', 'not_opted_in'),
      noContact: n('skipped_nocontact'), duplicates: planned.duplicates, overCap: n('skipped_cap'), unitPaise: planned.unitPaise,
      costPaise: planned.rows.filter((r) => r.status === 'pending').reduce((x, r) => x + r.costPaise, 0), capWarning: planned.capWarning,
      needsApproval: b.category === 'marketing' && eligible > s.broadcast.approvalThreshold,
    };
  }
  /** Dry run: what a send would do now (no rows written). */
  async preview(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const b = await this.load(tx, a, id);
      const planned = await this.plan(tx, a, b);
      return { ...(await this.summary(tx, b, planned)), sample: planned.rows.slice(0, 20).map((r) => ({ clientId: r.clientId, clientName: r.clientName, address: r.address ? maskAddress(r.address) : null, status: r.status, reason: r.reason })) };
    });
  }

  /**
   * Materialises recipients (idempotent per broadcast × address) with the same plan as the preview, then schedules the
   * job — or waits for approval (marketing above the firm threshold, D105).
   */
  async send(a: RequestActor, id: string, body: { scheduledAt?: string | null }) {
    const now = this.clock.now();
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const b = await this.load(tx, a, id, true);
      if (b.created_by !== a.userId && !a.superAdmin) throw new ForbiddenException('Only the creator sends a broadcast');
      if (b.status !== 'draft') throw new ConflictException({ message: `Broadcast is ${b.status}`, code: 'bad_status' });
      await this.template(tx, b.template_id, b.channel);
      const at = body.scheduledAt ? new Date(body.scheduledAt) : b.scheduled_at ? new Date(b.scheduled_at) : now;
      const runAt = at > now ? at : now;
      const planned = await this.plan(tx, a, b);
      const est = await this.summary(tx, b, planned);
      if (!est.eligible) throw new ConflictException({ message: 'No eligible recipients', code: 'no_recipients' });
      for (const r of planned.rows) {
        await tx.query(`INSERT INTO broadcast_recipient (id, tenant_id, broadcast_id, client_id, contact_id, address, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (broadcast_id, COALESCE(address, client_id::text)) DO NOTHING`, [uuidv7(), a.tenantId, id, r.clientId, r.contactId, r.address, r.status, r.reason]);
      }
      const status = est.needsApproval ? 'pending_approval' : 'scheduled';
      await tx.query(`UPDATE broadcast SET status = $2, scheduled_at = $3, estimate = $4, updated_by = $5 WHERE id = $1`, [id, status, runAt, JSON.stringify(est), a.userId]);
      let cursor = 0;
      if (status === 'scheduled') await this.jobs.enqueue(tx, a.tenantId, BROADCAST_JOB, id, runAt);
      else {
        const approvers = (await tx.query(`SELECT DISTINCT ur.user_id FROM user_role ur JOIN role r ON r.id = ur.role_id JOIN app_user u ON u.id = ur.user_id AND u.status = 'active'
          WHERE r.grants @> '[{"module":"communication","action":"approve","scope":"all"}]'::jsonb AND ur.user_id <> $1`, [a.userId])).rows.map((r) => r.user_id);
        if (approvers.length) cursor = (await insertNotifications(tx, a.tenantId, { userIds: approvers, category: 'broadcast.approval', priority: 'high', title: `Approve broadcast "${b.name}"`,
          body: `${est.eligible} recipients, est. ₹${(est.costPaise / 100).toFixed(2)}`, entityType: 'broadcast', entityId: id, dedupeKey: `broadcast-approval:${id}` })).cursor;
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.broadcast_sent', entity: 'broadcast', entityId: id, diff: { status, scheduledAt: runAt, estimate: est } });
      if (cursor) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor });
      return { status, scheduledAt: runAt, estimate: est };
    });
  }
  /** Maker-checker: firm-wide communication:approve, never the creator (D105). */
  async approve(a: RequestActor, id: string) {
    if (!a.superAdmin && effectiveScope(a, 'communication', 'approve')?.scope !== 'all') throw new ForbiddenException('Needs firm-wide communication:approve');
    const now = this.clock.now();
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const b = (await tx.query('SELECT * FROM broadcast WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!b) throw new NotFoundException();
      if (b.created_by === a.userId) throw new ForbiddenException({ message: 'You cannot approve your own broadcast', code: 'self_approval' });
      if (b.status !== 'pending_approval') throw new ConflictException({ message: `Broadcast is ${b.status}`, code: 'bad_status' });
      const runAt = b.scheduled_at && b.scheduled_at > now ? b.scheduled_at : now;
      await tx.query(`UPDATE broadcast SET status = 'scheduled', approved_by = $2, approved_at = $3, scheduled_at = $4 WHERE id = $1`, [id, a.userId, now, runAt]);
      await this.jobs.enqueue(tx, a.tenantId, BROADCAST_JOB, id, runAt);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.broadcast_approved', entity: 'broadcast', entityId: id, diff: { scheduledAt: runAt } });
      return { status: 'scheduled', scheduledAt: runAt };
    });
  }
  async cancel(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const b = await this.load(tx, a, id, true);
      if (b.created_by !== a.userId && !(a.superAdmin || effectiveScope(a, 'communication', 'approve')?.scope === 'all')) throw new ForbiddenException();
      if (['completed', 'cancelled'].includes(b.status)) throw new ConflictException({ message: `Broadcast is ${b.status}`, code: 'bad_status' });
      await tx.query(`UPDATE broadcast SET status = 'cancelled', cancelled_at = $2, cancelled_by = $3 WHERE id = $1`, [id, this.clock.now(), a.userId]);
      const r = await tx.query(`UPDATE broadcast_recipient SET status = 'cancelled', updated_at = now() WHERE broadcast_id = $1 AND status = 'pending' AND message_id IS NULL`, [id]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.broadcast_cancelled', entity: 'broadcast', entityId: id, diff: { cancelledRecipients: r.rowCount } });
      return { status: 'cancelled', cancelledRecipients: r.rowCount };
    });
  }
  async recipients(a: RequestActor, id: string, q: { status?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.load(tx, a, id);
      return (await tx.query(`SELECT r.id, r.client_id AS "clientId", c.name AS "clientName", r.address, r.status, r.error, r.cost_paise AS "costPaise", r.sent_at AS "sentAt", r.attempts
        FROM broadcast_recipient r JOIN client c ON c.id = r.client_id WHERE r.broadcast_id = $1 AND ($2::text IS NULL OR r.status = $2) ORDER BY c.name, r.id`, [id, q.status ?? null])).rows
        .map((r) => ({ ...r, address: r.address ? maskAddress(r.address) : null, costPaise: Number(r.costPaise) }));
    });
  }
  async export(a: RequestActor, id: string) {
    const rows = await this.recipients(a, id, {});
    await this.db.tenantTx(a.tenantId, (tx) => this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.broadcast_exported', entity: 'broadcast', entityId: id, diff: { rows: rows.length } }));
    return tabular(`broadcast-${id.slice(0, 8)}`, 'Recipients', ['Client', 'Address', 'Status', 'Reason', 'Cost (paise)', 'Sent at'],
      rows.map((r) => [r.clientName, r.address, r.status, r.error, r.costPaise, r.sentAt ? new Date(r.sentAt).toISOString() : '']), 'csv');
  }

  /**
   * Job: one batch per run, rate-limited by `batchIntervalSeconds`; quiet hours defer the whole batch. Each recipient's
   * message row is created once (recipient lock) and delivered with the message id as idempotency key, so a run that
   * died mid-batch resumes without sending twice (D105).
   */
  private async run(tenantId: string, id: string, at: Date) {
    const prep = await this.db.tenantTx(tenantId, async (tx) => {
      const b = (await tx.query('SELECT * FROM broadcast WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!b || !['scheduled', 'sending'].includes(b.status)) return null;
      if (b.scheduled_at && b.scheduled_at > at) throw new Reschedule(b.scheduled_at);
      const s = await loadCommSettings(tx);
      const allowed = sendTimeFor(s, b.category, at);
      if (allowed > at) throw new Reschedule(allowed);
      if (b.status === 'scheduled') await tx.query(`UPDATE broadcast SET status = 'sending' WHERE id = $1`, [id]);
      const batch = (await tx.query(`SELECT id FROM broadcast_recipient WHERE broadcast_id = $1 AND status IN ('pending','sending') ORDER BY id LIMIT $2`, [id, s.broadcast.batchSize])).rows.map((r) => r.id as string);
      const t = (await tx.query('SELECT * FROM comm_template WHERE id = $1', [b.template_id])).rows[0];
      return { b, s, t, batch, firm: await firmName(tx) };
    });
    if (!prep) return;
    const { b, s, t, batch, firm } = prep;
    let transient: Error | null = null;
    for (const rid of batch) {
      const msgId = await this.db.tenantTx(tenantId, async (tx) => {
        const r = (await tx.query(`SELECT r.*, c.name AS client_name FROM broadcast_recipient r JOIN client c ON c.id = r.client_id WHERE r.id = $1 FOR UPDATE OF r`, [rid])).rows[0];
        if (!r || !['pending', 'sending'].includes(r.status)) return null;
        const cur = (await tx.query('SELECT status, spent_paise FROM broadcast WHERE id = $1', [id])).rows[0];
        if (cur.status === 'cancelled') return null;
        if (r.message_id) return r.message_id as string;
        const contact = r.contact_id ? (await tx.query('SELECT name FROM contact WHERE id = $1', [r.contact_id])).rows[0]?.name : null;
        const vars: Record<string, string> = { ...(b.variables as Record<string, string>), 'client.name': r.client_name, 'contact.name': contact ?? r.client_name, 'firm.name': firm };
        const text = renderTemplate(t.body, vars, b.channel === 'email' ? 'html' : 'text').text;
        const subject = t.subject ? renderTemplate(t.subject, vars).text : null;
        const unit = unitCost(await loadRates(tx), b.channel, b.category, text, istDay(at));
        if (s.caps.perBroadcastPaise !== null && s.caps.mode === 'block' && Number(cur.spent_paise) + unit > s.caps.perBroadcastPaise) {
          await tx.query(`UPDATE broadcast_recipient SET status = 'skipped_cap', error = 'over_cap', updated_at = now() WHERE id = $1`, [rid]);
          return null;
        }
        const q = await this.comm.queueTx(tx, tenantId, { clientId: r.client_id, contactId: r.contact_id, channel: b.channel, address: r.address, category: b.category, subject, text,
          templateId: t.id, templateName: t.name, language: t.language, templateParams: placeholdersOf(t.body).map((p) => vars[p] ?? ''), dltTemplateId: t.dlt_template_id,
          createdBy: b.created_by, broadcastId: id, now: at });
        if ('error' in q) {
          await tx.query(`UPDATE broadcast_recipient SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [rid, q.error === 'over_cap' ? 'skipped_cap' : 'skipped_optout', q.error]);
          return null;
        }
        await tx.query(`UPDATE broadcast_recipient SET status = 'sending', message_id = $2, cost_paise = $3, attempts = attempts + 1, updated_at = now() WHERE id = $1`, [rid, q.id, q.costPaise]);
        await tx.query('UPDATE broadcast SET spent_paise = spent_paise + $2 WHERE id = $1', [id, q.costPaise]);
        return q.id;
      });
      if (!msgId) continue;
      let res: string | Date;
      try { res = await this.comm.deliver(tenantId, msgId, at); } catch (e) {
        if (!(e instanceof TransientSendError)) throw e;
        transient = e; break; // stop the batch; the job retries with backoff, sent recipients stay sent
      }
      await this.db.tenantTx(tenantId, async (tx) => {
        const m = (await tx.query('SELECT status, error FROM comm_message WHERE id = $1', [msgId])).rows[0];
        const st = res === 'cancelled' || m.status === 'cancelled' ? 'skipped_optout' : ['sent', 'delivered', 'read'].includes(m.status) ? 'sent' : m.status === 'failed' ? 'failed' : null;
        if (st) await tx.query(`UPDATE broadcast_recipient SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'sent' THEN $4::timestamptz END, updated_at = now() WHERE id = $1`, [rid, st, m.error, at]);
      });
    }
    if (transient) throw transient;
    await this.db.tenantTx(tenantId, async (tx) => {
      const left = (await tx.query(`SELECT count(*)::int AS n FROM broadcast_recipient WHERE broadcast_id = $1 AND status IN ('pending','sending')`, [id])).rows[0].n;
      const cur = (await tx.query('SELECT status FROM broadcast WHERE id = $1', [id])).rows[0];
      if (left && cur.status !== 'cancelled') throw new Reschedule(new Date(at.getTime() + s.broadcast.batchIntervalSeconds * 1000));
      if (cur.status === 'cancelled') return;
      const counts = Object.fromEntries((await tx.query('SELECT status, count(*)::int AS n FROM broadcast_recipient WHERE broadcast_id = $1 GROUP BY status', [id])).rows.map((r) => [r.status, r.n]));
      await tx.query(`UPDATE broadcast SET status = 'completed', completed_at = $2 WHERE id = $1`, [id, at]);
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'comm.broadcast_completed', entity: 'broadcast', entityId: id, diff: { counts } });
    });
  }
}
