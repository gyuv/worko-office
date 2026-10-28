import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import {
  can, clientCtx, commSettingsSchema, effectiveScope, maskAddress, normalizeAddress, normalizePhone, parseKeyword, placeholdersOf, renderTemplate, templateErrors,
  type CommChannel, type TemplateCategory,
} from '@worko/domain';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, Params, visibilityOf } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { insertNotifications } from '../notifications/insert.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { requireFirmWide } from '../tasks/system-actor.js';
import { taskScopeSql } from '../tasks/scope.js';
import { assertCommConfig, COMM_CHANNELS_TOKEN, INBOUND_PROVIDERS, mockInboundAllowed, TransientSendError, type ChannelAdapters, type InboundProvider } from './channels.js';
import { addressFor, checkSend, consentError, consentOf, firmName, istMonth, loadCommSettings, loadRates, matchAddress, monthRange, SPENT_STATUSES, usedPaise, visibleClient } from './common.js';

export const SEND_JOB = 'comm.send';
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export type QueueInput = {
  clientId: string | null; contactId: string | null; channel: CommChannel; address: string; category: TemplateCategory;
  subject: string | null; text: string; templateId?: string | null; templateParams?: string[]; templateName?: string | null; language?: string | null;
  dltTemplateId?: string | null; createdBy: string | null; broadcastId?: string | null; now: Date; meta?: Record<string, unknown>;
};
export type Queued = { id: string; sendAt: Date; costPaise: number; capWarning: boolean } | { error: 'opted_out' | 'not_opted_in' | 'over_cap' };

type TemplateIn = { name: string; channel: CommChannel; category: TemplateCategory; language?: string; subject?: string | null; body: string; sensitive?: boolean; dltTemplateId?: string | null };
type SendIn = { clientId: string; channel: CommChannel; contactId?: string | null; address?: string | null; templateId?: string | null; vars?: Record<string, string>; subject?: string | null; body?: string | null; category?: TemplateCategory };

const tplOut = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, channel: r.channel, category: r.category, language: r.language, subject: r.subject, body: r.body, variables: r.variables,
  sensitive: r.sensitive, status: r.status, providerRef: r.provider_ref, rejectionReason: r.rejection_reason, dltTemplateId: r.dlt_template_id, version: r.version,
});

@Injectable()
export class CommService implements OnModuleInit {
  constructor(
    private db: DbService, private audit: AuditService, private jobs: JobQueueService, private realtime: RealtimeService, private clock: Clock,
    @Inject(COMM_CHANNELS_TOKEN) private adapters: ChannelAdapters, @Inject(INBOUND_PROVIDERS) private inbound: Record<string, InboundProvider>,
  ) {}

  onModuleInit() {
    assertCommConfig();
    this.jobs.register(SEND_JOB, async (j, at) => {
      const r = await this.deliver(j.tenant_id, j.ref_id, at);
      if (r instanceof Date) throw new Reschedule(r);
    });
  }

  // ---------- Settings / rates / usage ----------
  settings(a: RequestActor) { return this.db.tenantTx(a.tenantId, (tx) => loadCommSettings(tx)); }
  async putSettings(a: RequestActor, body: unknown) {
    requireFirmWide(a, 'settings', 'edit');
    const p = commSettingsSchema.safeParse(body);
    if (!p.success) throw new BadRequestException({ message: 'Invalid settings', issues: p.error.issues });
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`INSERT INTO comm_settings (tenant_id, settings, updated_by) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET settings = $2, updated_at = now(), updated_by = $3`,
        [a.tenantId, JSON.stringify(p.data), a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.settings_updated', entity: 'comm_settings', entityId: a.tenantId, diff: p.data });
      return p.data;
    });
  }
  rates(a: RequestActor) { return this.db.tenantTx(a.tenantId, (tx) => loadRates(tx)); }
  async addRate(a: RequestActor, b: { channel: CommChannel; category: TemplateCategory | '*'; paise: number; effectiveFrom: string; note?: string | null }) {
    requireFirmWide(a, 'settings', 'edit');
    return this.db.tenantTx(a.tenantId, async (tx) => {
      // The previous open-ended rate for the same key ends the day before.
      await tx.query(`UPDATE comm_rate SET effective_to = ($3::date - 1) WHERE channel = $1 AND category = $2 AND effective_to IS NULL AND effective_from < $3`, [b.channel, b.category, b.effectiveFrom]);
      const id = uuidv7();
      try {
        await tx.query(`INSERT INTO comm_rate (id, tenant_id, channel, category, paise, effective_from, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, a.tenantId, b.channel, b.category, b.paise, b.effectiveFrom, b.note ?? null, a.userId]);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictException('A rate already starts on that date'); throw e; }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.rate_added', entity: 'comm_rate', entityId: id, diff: b });
      return { id };
    });
  }
  usage(a: RequestActor, month: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const s = await loadCommSettings(tx);
      const [st, en] = monthRange(month);
      const rows = (await tx.query(`SELECT channel, count(*)::int AS n, COALESCE(sum(cost_paise), 0)::bigint AS p, count(*) FILTER (WHERE cap_warning)::int AS w FROM comm_message
        WHERE direction = 'out' AND channel IN ('email','whatsapp','sms') AND occurred_at >= $1 AND occurred_at < $2 AND status = ANY($3) AND deleted_at IS NULL GROUP BY channel`, [st, en, SPENT_STATUSES])).rows;
      const byChannel = (['email', 'whatsapp', 'sms'] as const).map((c) => {
        const r = rows.find((x) => x.channel === c); const cap = s.caps.monthlyPaise[c];
        const costPaise = Number(r?.p ?? 0);
        return { channel: c, messages: r?.n ?? 0, costPaise, capPaise: cap, remainingPaise: cap === null ? null : Math.max(0, cap - costPaise), overCap: cap !== null && costPaise > cap, capWarnings: r?.w ?? 0 };
      });
      return { month, capMode: s.caps.mode, byChannel, totalPaise: byChannel.reduce((x, c) => x + c.costPaise, 0) };
    });
  }

  // ---------- Templates ----------
  templates(a: RequestActor, q: { channel?: CommChannel; status?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT * FROM comm_template WHERE deleted_at IS NULL AND ($1::text IS NULL OR channel = $1) AND ($2::text IS NULL OR status = $2) ORDER BY name, channel, language`,
      [q.channel ?? null, q.status ?? null])).rows.map(tplOut));
  }
  private validateBody(body: string, subject?: string | null) {
    const errs = [...templateErrors(body), ...(subject ? templateErrors(subject) : [])];
    if (errs.length) throw new BadRequestException({ message: 'Invalid template', code: 'invalid_template', issues: errs });
  }
  async createTemplate(a: RequestActor, b: TemplateIn) {
    this.validateBody(b.body, b.subject);
    if (b.channel === 'email' && !b.subject) throw new BadRequestException({ message: 'Email templates need a subject', code: 'subject_required' });
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const id = uuidv7();
      try {
        await tx.query(`INSERT INTO comm_template (id, tenant_id, name, channel, category, language, subject, body, variables, sensitive, dlt_template_id, created_by, updated_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`, [id, a.tenantId, b.name, b.channel, b.category, b.language ?? 'en', b.subject ?? null, b.body,
          placeholdersOf(`${b.subject ?? ''} ${b.body}`), b.sensitive ?? false, b.dltTemplateId ?? null, a.userId]);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictException('A template with that name already exists for the channel and language'); throw e; }
      // Metadata only — template bodies stay out of the audit log (D104).
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.template_created', entity: 'comm_template', entityId: id, diff: { name: b.name, channel: b.channel, category: b.category, language: b.language ?? 'en' } });
      return { id };
    });
  }
  async updateTemplate(a: RequestActor, id: string, b: Partial<Omit<TemplateIn, 'name' | 'channel'>>) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const t = (await tx.query('SELECT * FROM comm_template WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!t) throw new NotFoundException();
      const body = b.body ?? t.body; const subject = b.subject === undefined ? t.subject : b.subject;
      this.validateBody(body, subject);
      // A changed body or category needs approval again (WhatsApp: provider re-review).
      const reset = (b.body !== undefined && b.body !== t.body) || (b.subject !== undefined && b.subject !== t.subject) || (b.category !== undefined && b.category !== t.category);
      await tx.query(`UPDATE comm_template SET body = $2, subject = $3, category = $4, language = $5, sensitive = $6, dlt_template_id = $7, variables = $8, updated_by = $9,
          status = CASE WHEN $10 THEN 'draft' ELSE status END, provider_ref = CASE WHEN $10 THEN NULL ELSE provider_ref END WHERE id = $1`,
        [id, body, subject, b.category ?? t.category, b.language ?? t.language, b.sensitive ?? t.sensitive, b.dltTemplateId === undefined ? t.dlt_template_id : b.dltTemplateId,
          placeholdersOf(`${subject ?? ''} ${body}`), a.userId, reset]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.template_updated', entity: 'comm_template', entityId: id,
        diff: { fields: Object.keys(b), statusReset: reset } });
      return tplOut((await tx.query('SELECT * FROM comm_template WHERE id = $1', [id])).rows[0]);
    });
  }
  /** Submit for approval (WhatsApp: to the provider — mocked; others: internal approval). */
  async submitTemplate(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const t = (await tx.query('SELECT * FROM comm_template WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!t) throw new NotFoundException();
      if (!['draft', 'rejected'].includes(t.status)) throw new ConflictException({ message: `Template is ${t.status}`, code: 'bad_status' });
      const ref = t.channel === 'whatsapp' ? `mock-tpl-${createHash('sha256').update(`${id}:${t.version}`).digest('hex').slice(0, 10)}` : null;
      await tx.query(`UPDATE comm_template SET status = 'submitted', submitted_at = $2, provider_ref = $3, rejection_reason = NULL, updated_by = $4 WHERE id = $1`, [id, this.clock.now(), ref, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.template_submitted', entity: 'comm_template', entityId: id, diff: { channel: t.channel } });
      return { status: 'submitted', providerRef: ref };
    });
  }
  /**
   * Approve/reject. WhatsApp approval belongs to the provider: only simulated while the WhatsApp adapter is the mock
   * (real decisions arrive via the provider — KNOWN_GAPS). Email/SMS: firm-wide communication:approve.
   */
  async decideTemplate(a: RequestActor, id: string, b: { approve: boolean; reason?: string | null }) {
    requireFirmWide(a, 'communication', 'approve');
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const t = (await tx.query('SELECT * FROM comm_template WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!t) throw new NotFoundException();
      if (t.status !== 'submitted') throw new ConflictException({ message: 'Submit the template first', code: 'bad_status' });
      if (t.channel === 'whatsapp' && this.adapters.whatsapp.name !== 'mock') throw new ConflictException({ message: 'WhatsApp templates are approved by the provider', code: 'provider_decides' });
      await tx.query(`UPDATE comm_template SET status = $2, rejection_reason = $3, decided_at = $4, updated_by = $5 WHERE id = $1`,
        [id, b.approve ? 'approved' : 'rejected', b.approve ? null : (b.reason ?? 'Rejected'), this.clock.now(), a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: b.approve ? 'comm.template_approved' : 'comm.template_rejected', entity: 'comm_template', entityId: id, diff: { reason: b.reason ?? null } });
      return { status: b.approve ? 'approved' : 'rejected' };
    });
  }
  async renderPreview(a: RequestActor, id: string, b: { clientId?: string | null; vars?: Record<string, string> }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const t = (await tx.query('SELECT * FROM comm_template WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
      if (!t) throw new NotFoundException();
      const client = b.clientId ? await visibleClient(tx, a, b.clientId, 'view') : null;
      const vars = { ...(client ? await this.baseVars(tx, a, client.id, client.name, null) : {}), ...(b.vars ?? {}) };
      const body = renderTemplate(t.body, vars, t.channel === 'email' ? 'html' : 'text');
      return { subject: t.subject ? renderTemplate(t.subject, vars).text : null, body: body.text, missing: [...new Set([...body.missing, ...(t.subject ? renderTemplate(t.subject, vars).missing : [])])] };
    });
  }
  private async baseVars(tx: Tx, a: RequestActor | null, clientId: string | null, clientName: string | null, contactName: string | null): Promise<Record<string, string>> {
    const user = a?.userId ? (await tx.query('SELECT name FROM app_user WHERE id = $1', [a.userId])).rows[0]?.name : null;
    const v: Record<string, string> = { 'firm.name': await firmName(tx) };
    if (clientId && clientName) v['client.name'] = clientName;
    if (contactName ?? clientName) v['contact.name'] = (contactName ?? clientName)!;
    if (user) v['user.name'] = user;
    return v;
  }

  // ---------- Consent ----------
  consents(a: RequestActor, q: { clientId?: string; address?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      if (q.clientId) await visibleClient(tx, a, q.clientId, 'view');
      else requireFirmWide(a, 'communication', 'view');
      const addr = q.address ? normalizePhone(q.address) ?? q.address.trim().toLowerCase() : null;
      return (await tx.query(`SELECT id, channel, address, client_id AS "clientId", contact_id AS "contactId", status, opted_in_at AS "optedInAt", opted_in_source AS "optedInSource",
          opted_out_at AS "optedOutAt", opted_out_source AS "optedOutSource", keyword, note, updated_at AS "updatedAt"
        FROM comm_consent WHERE ($1::uuid IS NULL OR client_id = $1) AND ($2::text IS NULL OR address = $2) ORDER BY channel, address LIMIT 500`, [q.clientId ?? null, addr])).rows;
    });
  }
  async recordConsent(a: RequestActor, b: { clientId: string; channel: CommChannel; contactId?: string | null; address?: string | null; status: 'opted_in' | 'opted_out'; source: string; note?: string | null }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await visibleClient(tx, a, b.clientId, 'edit');
      const raw = b.address ?? (await addressFor(tx, b.clientId, b.channel, b.contactId)).address;
      const address = normalizeAddress(b.channel, raw);
      if (!address) throw new BadRequestException({ message: 'No valid address for that channel', code: 'no_address' });
      const id = await this.upsertConsent(tx, a.tenantId, { channel: b.channel, address, clientId: b.clientId, contactId: b.contactId ?? null, status: b.status, source: `staff:${b.source}`, note: b.note ?? null, by: a.userId, at: this.clock.now() });
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: `comm.consent_${b.status}`, entity: 'comm_consent', entityId: id,
        diff: { channel: b.channel, address: maskAddress(address), source: b.source, clientId: b.clientId } });
      return { id, address, status: b.status };
    });
  }
  async upsertConsent(tx: Tx, tenantId: string, c: { channel: CommChannel; address: string; clientId: string | null; contactId: string | null; status: 'opted_in' | 'opted_out'; source: string; note?: string | null; keyword?: string | null; by: string | null; at: Date }) {
    const r = await tx.query(`INSERT INTO comm_consent (id, tenant_id, channel, address, client_id, contact_id, status, opted_in_at, opted_in_source, opted_out_at, opted_out_source, keyword, note, updated_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7 = 'opted_in' THEN $8::timestamptz END, CASE WHEN $7 = 'opted_in' THEN $9 END,
          CASE WHEN $7 = 'opted_out' THEN $8::timestamptz END, CASE WHEN $7 = 'opted_out' THEN $9 END, $10, $11, $12, $8)
      ON CONFLICT (tenant_id, channel, address) DO UPDATE SET status = EXCLUDED.status, client_id = COALESCE(EXCLUDED.client_id, comm_consent.client_id),
        contact_id = COALESCE(EXCLUDED.contact_id, comm_consent.contact_id),
        opted_in_at = CASE WHEN EXCLUDED.status = 'opted_in' THEN EXCLUDED.opted_in_at ELSE comm_consent.opted_in_at END,
        opted_in_source = CASE WHEN EXCLUDED.status = 'opted_in' THEN EXCLUDED.opted_in_source ELSE comm_consent.opted_in_source END,
        opted_out_at = CASE WHEN EXCLUDED.status = 'opted_out' THEN EXCLUDED.opted_out_at ELSE comm_consent.opted_out_at END,
        opted_out_source = CASE WHEN EXCLUDED.status = 'opted_out' THEN EXCLUDED.opted_out_source ELSE comm_consent.opted_out_source END,
        keyword = EXCLUDED.keyword, note = COALESCE(EXCLUDED.note, comm_consent.note), updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
      RETURNING id`, [uuidv7(), tenantId, c.channel, c.address, c.clientId, c.contactId, c.status, c.at, c.source, c.keyword ?? null, c.note ?? null, c.by]);
    return r.rows[0].id as string;
  }

  // ---------- Sending ----------
  /**
   * Consent/quiet hours/cap checks, then a `queued` message row (cost metered). Callers deliver after commit (or the
   * `comm.send` job does at `sendAt`). Refusals are returned, not thrown.
   */
  async queueTx(tx: Tx, tenantId: string, i: QueueInput): Promise<Queued> {
    const s = await loadCommSettings(tx);
    const chk = await checkSend(tx, s, await loadRates(tx), { channel: i.channel, address: i.address, category: i.category, text: i.text, now: i.now });
    if (chk.error) return { error: chk.error };
    const id = uuidv7();
    await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, contact_id, direction, channel, address, subject, body, template_id, category, status, cost_paise, cap_warning,
        broadcast_id, send_at, created_by, occurred_at, meta, device_id) VALUES ($1,$2,$3,$4,'out',$5,$6,$7,$8,$9,$10,'queued',$11,$12,$13,$14,$15,$16,$17,'server')`,
      [id, tenantId, i.clientId, i.contactId, i.channel, i.address, i.subject, i.text, i.templateId ?? null, i.category, chk.costPaise, chk.capWarning, i.broadcastId ?? null,
        chk.sendAt, i.createdBy, i.now, JSON.stringify({ ...(i.meta ?? {}), template: i.templateName ? { name: i.templateName, language: i.language ?? 'en', params: i.templateParams ?? [] } : null, dlt: i.dltTemplateId ?? null })]);
    if (chk.sendAt > i.now) await this.jobs.enqueue(tx, tenantId, SEND_JOB, id, chk.sendAt);
    return { id, sendAt: chk.sendAt, costPaise: chk.costPaise, capWarning: chk.capWarning };
  }

  /**
   * Sends one queued message (idempotency key = message id, so a retried delivery never sends twice). Consent is
   * re-checked at send time (a STOP may have arrived since queuing). Returns a Date when it is not yet due.
   */
  async deliver(tenantId: string, id: string, at: Date): Promise<'sent' | 'failed' | 'cancelled' | 'skip' | Date> {
    const m = await this.db.tenantTx(tenantId, async (tx) => {
      const m = (await tx.query(`SELECT * FROM comm_message WHERE id = $1 AND status IN ('queued','sending') AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!m) return null;
      if (m.send_at && m.send_at > at) return m.send_at as Date;
      const s = await loadCommSettings(tx);
      const ce = consentError(await consentOf(tx, m.channel, m.address), m.category, s);
      if (ce) {
        await tx.query(`UPDATE comm_message SET status = 'cancelled', error = $2 WHERE id = $1`, [id, ce]);
        await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'comm.message_cancelled', entity: 'comm_message', entityId: id, diff: { reason: ce } });
        return 'cancelled' as const;
      }
      await tx.query(`UPDATE comm_message SET status = 'sending' WHERE id = $1`, [id]);
      return m;
    });
    if (!m) return 'skip';
    if (m instanceof Date || m === 'cancelled') return m;
    const meta = (m.meta ?? {}) as { template?: { name: string; language: string; params: string[] } | null; dlt?: string | null };
    const adapter = this.adapters[m.channel as CommChannel];
    const res = await adapter.send({ tenantId, channel: m.channel, to: m.address, subject: m.subject, text: m.body, html: m.channel === 'email' && /<[a-z][^>]*>/i.test(m.body) ? m.body : null,
      template: meta.template ?? null, dltTemplateId: meta.dlt ?? null, idempotencyKey: `msg:${id}` });
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx.query(`UPDATE comm_message SET status = $2, provider = $3, provider_ref = $4, error = $5, occurred_at = CASE WHEN $2 = 'sent' THEN $6 ELSE occurred_at END WHERE id = $1`,
        [id, res.status, adapter.name, res.ref ?? null, res.error ?? null, at]);
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: `comm.message_${res.status}`, entity: 'comm_message', entityId: id, diff: { channel: m.channel, provider: adapter.name, error: res.error ?? null } });
    });
    return res.status;
  }
  /** Inline delivery after commit; a provider outage falls back to the retrying job. */
  async deliverNow(tenantId: string, id: string, at: Date) {
    try { return await this.deliver(tenantId, id, at); } catch (e) {
      if (!(e instanceof TransientSendError)) throw e;
      await this.db.tenantTx(tenantId, (tx) => this.jobs.enqueue(tx, tenantId, SEND_JOB, id, new Date(at.getTime() + 60_000)));
      return 'queued' as const;
    }
  }

  async send(a: RequestActor, b: SendIn) {
    const now = this.clock.now();
    const out = await this.db.tenantTx(a.tenantId, async (tx) => {
      const client = await visibleClient(tx, a, b.clientId, 'create');
      const target = await addressFor(tx, client.id, b.channel, b.contactId);
      const address = normalizeAddress(b.channel, b.address ?? target.address);
      if (!address) throw new ConflictException({ message: 'No valid address for this client on that channel', code: 'no_address' });
      let category: TemplateCategory = b.category ?? 'transactional'; let subject = b.subject ?? null; let text: string;
      let tpl: Record<string, string | string[] | null> | null = null;
      if (b.templateId) {
        tpl = (await tx.query('SELECT * FROM comm_template WHERE id = $1 AND deleted_at IS NULL', [b.templateId])).rows[0] ?? null;
        if (!tpl || tpl.channel !== b.channel) throw new BadRequestException({ message: 'Template not found for this channel', code: 'bad_template' });
        if (tpl.status === 'rejected' || (b.channel === 'whatsapp' && tpl.status !== 'approved')) throw new ConflictException({ message: 'Template is not approved', code: 'template_not_approved' });
        const vars = { ...Object.fromEntries(Object.entries(b.vars ?? {}).filter(([k]) => placeholdersOf(String(tpl!.body)).includes(k))), ...(await this.baseVars(tx, a, client.id, client.name, target.contactName)) };
        const r = renderTemplate(String(tpl.body), vars, b.channel === 'email' ? 'html' : 'text');
        if (r.missing.length) throw new BadRequestException({ message: 'Missing template variables', code: 'missing_variables', issues: r.missing });
        text = r.text; category = tpl.category as TemplateCategory;
        subject = tpl.subject ? renderTemplate(String(tpl.subject), vars).text : subject;
        tpl = { ...tpl, params: placeholdersOf(String(tpl.body)).map((p) => vars[p] ?? '') };
      } else {
        if (!b.body?.trim()) throw new BadRequestException({ message: 'Body or template required', code: 'body_required' });
        text = b.body;
        // Business-initiated WhatsApp outside the 24-hour customer-service window needs an approved template. // VERIFY AGAINST OFFICIAL DOCS
        if (b.channel === 'whatsapp' && !(await tx.query(`SELECT 1 FROM comm_message WHERE direction = 'in' AND channel = 'whatsapp' AND address = $1 AND occurred_at > $2::timestamptz - interval '24 hours'`, [address, now])).rowCount) {
          throw new ConflictException({ message: 'Outside the 24-hour window: use an approved template', code: 'template_required' });
        }
        if (b.channel === 'email' && !subject) throw new BadRequestException({ message: 'Subject required', code: 'subject_required' });
      }
      const q = await this.queueTx(tx, a.tenantId, { clientId: client.id, contactId: target.contactId, channel: b.channel, address, category, subject, text,
        templateId: (tpl?.id as string) ?? null, templateName: (tpl?.name as string) ?? null, language: (tpl?.language as string) ?? null, templateParams: (tpl?.params as string[]) ?? [],
        dltTemplateId: (tpl?.dlt_template_id as string) ?? null, createdBy: a.userId, now });
      const sensitive = !!tpl?.sensitive;
      if ('error' in q) {
        await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.message_refused', entity: 'client', entityId: client.id, diff: { channel: b.channel, category, reason: q.error, address: maskAddress(address) } });
        return q;
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.message_queued', entity: 'comm_message', entityId: q.id,
        diff: { clientId: client.id, channel: b.channel, category, templateId: tpl?.id ?? null, address: maskAddress(address), sendAt: q.sendAt, costPaise: q.costPaise, sensitive } });
      return q;
    });
    if ('error' in out) throw new ConflictException({ message: `Not sent: ${out.error}`, code: out.error });
    const status = out.sendAt > now ? 'queued' : await this.deliverNow(a.tenantId, out.id, now);
    return { id: out.id, status, sendAt: out.sendAt, costPaise: out.costPaise, capWarning: out.capWarning };
  }

  // ---------- Timeline ----------
  async logActivity(a: RequestActor, clientId: string, b: { channel: 'note' | 'call'; body: string; direction?: 'in' | 'out'; callMinutes?: number | null; occurredAt?: string | null; subject?: string | null }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await visibleClient(tx, a, clientId, 'create');
      const id = uuidv7(); const at = b.occurredAt ? new Date(b.occurredAt) : this.clock.now();
      if (at > new Date(this.clock.now().getTime() + 5 * 60_000)) throw new BadRequestException({ message: 'Future time', code: 'future_time' });
      await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, direction, channel, subject, body, status, call_minutes, created_by, occurred_at, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'logged',$8,$9,$10,$11)`, [id, a.tenantId, clientId, b.channel === 'note' ? 'internal' : (b.direction ?? 'out'), b.channel, b.subject ?? null, b.body,
        b.channel === 'call' ? b.callMinutes ?? null : null, a.userId, at, a.deviceId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: `comm.${b.channel}_logged`, entity: 'comm_message', entityId: id, diff: { clientId, direction: b.direction ?? null, callMinutes: b.callMinutes ?? null } });
      return { id };
    });
  }

  /**
   * One timeline per client (D102): messages, notes and calls, plus documents / issued invoices / completed tasks the
   * caller may see on that client. Keyset paging on (at, id) descending.
   */
  async timeline(a: RequestActor, clientId: string, q: { before?: string; limit: number; channel?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await visibleClient(tx, a, clientId, 'view');
      const ctx = clientCtx(visibilityOf(c));
      const p = new Params([clientId]);
      const parts = [`SELECT 'message' AS kind, m.id, m.occurred_at AS at, m.channel, m.direction, m.subject, m.body, m.status, m.address, m.created_by AS by, m.call_minutes AS minutes,
        NULL::bigint AS amount, m.broadcast_id AS ref FROM comm_message m WHERE m.client_id = $1 AND m.deleted_at IS NULL`];
      if (!q.channel || q.channel === 'events') {
        if (can(a, 'documents', 'view', ctx)) parts.push(`SELECT 'document', d.id, d.created_at, NULL, NULL, d.name, d.category, NULL, NULL, d.uploaded_by, NULL, NULL, NULL FROM document d WHERE d.client_id = $1 AND d.deleted_at IS NULL`);
        if (can(a, 'billing', 'view', ctx)) parts.push(`SELECT 'invoice', i.id, i.issued_at, NULL, NULL, i.number, i.kind, i.status, NULL, NULL, NULL, i.total_paise, NULL FROM invoice i WHERE i.client_id = $1 AND i.issued_at IS NOT NULL AND i.deleted_at IS NULL`);
        if ((effectiveScope(a, 'tasks', 'view')?.scope ?? 'none') !== 'none' || a.superAdmin) {
          parts.push(`SELECT 'task', t.id, t.completed_at, NULL, NULL, t.title, t.period_label, t.status, NULL, t.assignee_id, NULL, NULL, NULL FROM task t JOIN client c ON c.id = t.client_id
            WHERE t.client_id = $1 AND t.completed_at IS NOT NULL AND t.deleted_at IS NULL AND ${taskScopeSql(a, 'view', p, 't', 'c')}`);
        }
      }
      let where = 'TRUE';
      if (q.channel && q.channel !== 'events') where = `x.kind = 'message' AND x.channel = ${p.add(q.channel)}`;
      else if (q.channel === 'events') where = `x.kind <> 'message'`;
      if (q.before) {
        const [at, id] = Buffer.from(q.before, 'base64url').toString('utf8').split('|');
        if (!at || !id || Number.isNaN(Date.parse(at)) || !isUuid(id)) throw new BadRequestException('Bad cursor');
        where += ` AND (x.at, x.id) < (${p.add(at)}::timestamptz, ${p.add(id)}::uuid)`;
      }
      const rows = (await tx.query(`SELECT * FROM (${parts.join(' UNION ALL ')}) x WHERE x.at IS NOT NULL AND ${where} ORDER BY x.at DESC, x.id DESC LIMIT ${p.add(q.limit + 1)}`, p.values)).rows;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        clientId, items: page.map((r) => ({ kind: r.kind, id: r.id, at: r.at, channel: r.channel, direction: r.direction, title: r.subject, body: r.body, status: r.status,
          address: r.address, by: r.by, callMinutes: r.minutes, amountPaise: r.amount === null ? null : Number(r.amount), broadcastId: r.ref })),
        nextBefore: rows.length > q.limit && last ? Buffer.from(`${(last.at as Date).toISOString()}|${last.id}`).toString('base64url') : null,
      };
    });
  }

  // ---------- Inbox (unmatched inbound) ----------
  private requireTriage(a: RequestActor) {
    if (!a.superAdmin && (effectiveScope(a, 'communication', 'assign')?.scope ?? 'none') === 'none') throw new ForbiddenException('Needs communication:assign');
  }
  inbox(a: RequestActor) {
    this.requireTriage(a);
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT id, channel, address, subject, body, triage, occurred_at AS "occurredAt" FROM comm_message
      WHERE client_id IS NULL AND direction = 'in' AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT 200`)).rows);
  }
  async assignInbound(a: RequestActor, id: string, b: { clientId: string; contactId?: string | null }) {
    this.requireTriage(a);
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const m = (await tx.query(`SELECT * FROM comm_message WHERE id = $1 AND client_id IS NULL AND direction = 'in' AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
      if (!m) throw new NotFoundException();
      await visibleClient(tx, a, b.clientId, 'edit');
      if (b.contactId && !(await tx.query('SELECT 1 FROM contact WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL', [b.contactId, b.clientId])).rowCount) throw new BadRequestException('Contact not on that client');
      await tx.query(`UPDATE comm_message SET client_id = $2, contact_id = $3, triage = 'assigned', assigned_by = $4 WHERE id = $1`, [id, b.clientId, b.contactId ?? null, a.userId]);
      // Same sender's other unmatched messages follow.
      const more = await tx.query(`UPDATE comm_message SET client_id = $2, contact_id = $3, triage = 'assigned', assigned_by = $4 WHERE client_id IS NULL AND direction = 'in' AND channel = $5 AND address = $6 AND id <> $1`,
        [id, b.clientId, b.contactId ?? null, a.userId, m.channel, m.address]);
      await tx.query('UPDATE comm_consent SET client_id = $1 WHERE channel = $2 AND address = $3 AND client_id IS NULL', [b.clientId, m.channel, m.address]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'comm.inbound_assigned', entity: 'comm_message', entityId: id, diff: { clientId: b.clientId, alsoMoved: more.rowCount } });
      return { assigned: 1 + (more.rowCount ?? 0) };
    });
  }

  // ---------- Webhooks ----------
  challenge(providerName: string, q: Record<string, string | undefined>) {
    const prov = this.inbound[providerName];
    if (!prov || (providerName === 'mock' && !mockInboundAllowed())) throw new NotFoundException();
    const c = prov.challenge?.(q);
    if (!c) throw new ForbiddenException();
    return c;
  }
  /** Inbound WhatsApp/SMS: signature over the raw body, idempotent per provider event id; no writes before verification (D100). */
  async webhook(providerName: string, tenantId: string, raw: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const prov = this.inbound[providerName];
    if (!prov || (providerName === 'mock' && !mockInboundAllowed())) throw new NotFoundException();
    if (!isUuid(tenantId) || !(await this.db.systemTx((tx) => tx.query('SELECT 1 FROM tenant WHERE id = $1', [tenantId]))).rowCount) throw new NotFoundException();
    if (!raw || !prov.verify(raw, headers)) throw new UnauthorizedException({ message: 'Bad signature', code: 'bad_signature' });
    let events;
    try { events = prov.parse(raw); } catch { throw new BadRequestException('Unrecognised payload'); }
    const now = this.clock.now();
    const results: Array<{ eventId: string; outcome: string }> = [];
    const notify: number[] = [];
    for (const ev of events) {
      const outcome = await this.db.tenantTx(tenantId, async (tx) => {
        const ins = await tx.query(`INSERT INTO comm_webhook_event (id, tenant_id, provider, event_id, body_sha256, outcome) VALUES ($1,$2,$3,$4,$5,'received')
          ON CONFLICT (tenant_id, provider, event_id) DO NOTHING RETURNING id`, [uuidv7(), tenantId, prov.name, ev.eventId, createHash('sha256').update(raw).digest('hex')]);
        if (!ins.rowCount) return 'duplicate';
        const done = async (o: string, entityId: string | null = null, extra: Record<string, unknown> = {}) => {
          await tx.query('UPDATE comm_webhook_event SET outcome = $3 WHERE provider = $1 AND event_id = $2', [prov.name, ev.eventId, o]);
          await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'comm.webhook', entity: 'comm_message', entityId, diff: { provider: prov.name, eventId: ev.eventId, kind: ev.kind, outcome: o, ...extra } });
          return o;
        };
        if (ev.kind === 'status') {
          const r = await tx.query(`UPDATE comm_message SET status = $3 WHERE provider = $1 AND provider_ref = $2 AND direction = 'out'
            AND (status = 'sent' OR (status = 'delivered' AND $3 = 'read')) RETURNING id`, [this.adapters[ev.channel].name, ev.providerRef, ev.status]);
          return done(r.rowCount ? `status_${ev.status}` : 'status_ignored', r.rows[0]?.id ?? null);
        }
        const from = normalizePhone(ev.from);
        if (!from) return done('bad_sender');
        const match = await matchAddress(tx, ev.channel, from);
        const id = uuidv7();
        const ins2 = await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, contact_id, direction, channel, address, body, status, provider, provider_ref, triage, occurred_at, device_id)
          VALUES ($1,$2,$3,$4,'in',$5,$6,$7,'received',$8,$9,$10,$11,'server') ON CONFLICT (tenant_id, provider, provider_ref) WHERE provider_ref IS NOT NULL AND direction = 'in' DO NOTHING RETURNING id`,
          [id, tenantId, match.clientId, match.contactId, ev.channel, from, ev.text, prov.name, ev.providerRef, match.clientId ? null : match.ambiguous ? 'ambiguous' : 'unmatched', ev.at ?? now]);
        if (!ins2.rowCount) return done('duplicate_message');
        const kw = parseKeyword(ev.text);
        if (kw) {
          await this.upsertConsent(tx, tenantId, { channel: ev.channel, address: from, clientId: match.clientId, contactId: match.contactId, status: kw === 'stop' ? 'opted_out' : 'opted_in',
            source: `keyword:${ev.channel}`, keyword: ev.text.trim().slice(0, 30).toUpperCase(), by: null, at: ev.at ?? now });
        }
        if (match.clientId) {
          const c = (await tx.query('SELECT name, partner_id, manager_id FROM client WHERE id = $1', [match.clientId])).rows[0];
          const target = c.manager_id ?? c.partner_id;
          if (target) {
            // No message text in the notification (it syncs to devices): open the timeline to read it.
            const n = await insertNotifications(tx, tenantId, { userIds: [target], category: ev.channel === 'whatsapp' ? 'whatsapp.reply' : 'comm.inbound',
              title: `${ev.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} from ${c.name}`, body: kw ? `Keyword ${kw.toUpperCase()} — consent updated` : 'Open the client timeline',
              entityType: 'client', entityId: match.clientId, dedupeKey: `inbound:${id}` });
            if (n.cursor) notify.push(n.cursor);
          }
        }
        return done(match.clientId ? 'matched' : match.ambiguous ? 'ambiguous' : 'unmatched', id, { keyword: kw });
      });
      results.push({ eventId: ev.eventId, outcome });
    }
    if (notify.length) this.realtime.publish({ type: 'changed', tenantId, cursor: Math.max(...notify) });
    return { received: events.length, results };
  }

  /** For other modules (appointments): recipients' month spend etc. */
  usedThisMonth(tx: Tx, channel: CommChannel) { return usedPaise(tx, channel, istMonth(this.clock.now())); }
  /** Client ids visible for communication × action (broadcast audiences). */
  static audienceScope(a: RequestActor, p: Params) { return `${clientScopeSql(a, 'clients', 'view', p)} AND ${clientScopeSql(a, 'communication', 'create', p)}`; }
}
