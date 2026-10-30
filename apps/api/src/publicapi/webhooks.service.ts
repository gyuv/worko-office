import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  can, clientCtx, effectiveScope, signatureHeader, signedContent, WEBHOOK_DEFAULTS, WEBHOOK_EVENT_MODULE, webhookBackoffMs, webhookEnvelope,
  type webhookCreateSchema, type webhookPatchSchema, type WebhookEvent,
} from '@worko/domain';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { loadTeamIds, loadUserRoles } from '../auth/roles.repo.js';
import { visibilityOf } from '../clients/scope.js';
import { KeyService } from '../crypto/key.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { pinTarget, TargetError, WEBHOOK_TRANSPORT, type WebhookTransport } from './transport.js';

export const FANOUT_JOB = 'webhook.fanout';
export const DELIVER_JOB = 'webhook.deliver';
const EPOCH = new Date(0); // due for any queue clock (tests pin theirs)

/** Tunables read per use (env), so operators — and tests — can change them without a rebuild. */
export const webhookLimits = () => ({
  maxAttempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? WEBHOOK_DEFAULTS.maxAttempts),
  disableAfter: Number(process.env.WEBHOOK_DISABLE_AFTER ?? WEBHOOK_DEFAULTS.disableAfterFailures),
  timeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS ?? WEBHOOK_DEFAULTS.timeoutMs),
});

type Sub = { id: string; name: string; url: string; events: string[]; secret_enc: Buffer; status: string; disabled_reason: string | null; consecutive_failures: number;
  created_by: string; created_at: Date; last_delivery_at: Date | null; deleted_at: Date | null };
type Delivery = { id: string; subscription_id: string; event_id: string | null; event_type: string; envelope: Record<string, unknown>; redelivery_of: string | null; status: string;
  attempts: number; next_attempt_at: Date | null; last_status_code: number | null; last_error: string | null; last_duration_ms: number | null; created_at: Date; delivered_at: Date | null };

const presentSub = (s: Sub) => ({ id: s.id, name: s.name, url: s.url, events: s.events, status: s.status, disabledReason: s.disabled_reason, consecutiveFailures: s.consecutive_failures,
  createdBy: s.created_by, createdAt: s.created_at, lastDeliveryAt: s.last_delivery_at });
const presentDelivery = (d: Delivery) => ({ id: d.id, subscriptionId: d.subscription_id, eventId: d.event_id, eventType: d.event_type, redeliveryOf: d.redelivery_of, status: d.status,
  attempts: d.attempts, nextAttemptAt: d.next_attempt_at, lastStatusCode: d.last_status_code, lastError: d.last_error, lastDurationMs: d.last_duration_ms, createdAt: d.created_at, deliveredAt: d.delivered_at });

/**
 * Outbound webhooks (M18, D194–D197): subscriptions to outbox change events, delivered by the job queue with an
 * HMAC-SHA256 signature over `timestamp.body`, exponential backoff, auto-disable, SSRF-safe pinned connections.
 */
@Injectable()
export class WebhooksService implements OnModuleInit {
  private log = new Logger('Webhooks');
  constructor(private db: DbService, private audit: AuditService, private keys: KeyService, private jobs: JobQueueService,
    @Inject(WEBHOOK_TRANSPORT) private transport: WebhookTransport) {}

  onModuleInit() {
    this.jobs.register(FANOUT_JOB, (j, at) => this.fanout(j.tenant_id, j.ref_id, at));
    this.jobs.register(DELIVER_JOB, (j, at) => this.deliver(j.tenant_id, j.ref_id, at));
  }

  // ---------- Management ----------
  async list(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => ({ items: ((await tx.query('SELECT * FROM webhook_subscription WHERE deleted_at IS NULL ORDER BY created_at DESC')).rows as Sub[]).map(presentSub) }));
  }

  /** Refuses URLs whose host is (or resolves to) a non-public address at creation too — delivery re-checks every time. */
  private async checkUrl(url: string) {
    try { await pinTarget(this.transport, new URL(url)); } catch (e) {
      if (e instanceof TargetError) throw new BadRequestException({ code: e.code, message: e.code === 'blocked_address' ? 'Webhook URLs must resolve to public internet addresses' : 'Could not resolve the webhook host' });
      throw e;
    }
  }

  async create(a: RequestActor, b: z.infer<typeof webhookCreateSchema>, ip: string | null) {
    await this.checkUrl(b.url);
    const id = randomUUID(), secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const sub = await this.db.tenantTx(a.tenantId, async (tx) => {
      const enc = await this.keys.encrypt(tx, a.tenantId, secret, `webhook_subscription:${id}:secret`);
      const s = (await tx.query(`INSERT INTO webhook_subscription (id, tenant_id, name, url, events, secret_enc, created_by, updated_by, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8) RETURNING *`,
        [id, a.tenantId, b.name, b.url, [...new Set(b.events)], enc, a.userId, a.deviceId])).rows[0] as Sub;
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'webhook.create', entity: 'webhook_subscription', entityId: id, diff: { name: b.name, url: b.url, events: b.events }, ip });
      return s;
    });
    return { subscription: presentSub(sub), secret };
  }

  async update(a: RequestActor, id: string, b: z.infer<typeof webhookPatchSchema>, ip: string | null) {
    if (b.url) await this.checkUrl(b.url);
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const s = await this.sub(tx, id);
      const reactivate = b.active === true && s.status !== 'active';
      const r = (await tx.query(`UPDATE webhook_subscription SET name = COALESCE($2, name), url = COALESCE($3, url), events = COALESCE($4, events),
          status = CASE WHEN $5::boolean IS NULL THEN status WHEN $5 THEN 'active' ELSE 'disabled' END,
          disabled_reason = CASE WHEN $5::boolean IS NULL THEN disabled_reason WHEN $5 THEN NULL ELSE 'manual' END,
          consecutive_failures = CASE WHEN $6 THEN 0 ELSE consecutive_failures END, updated_by = $7, device_id = $8 WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.url ?? null, b.events ? [...new Set(b.events)] : null, b.active ?? null, reactivate, a.userId, a.deviceId])).rows[0] as Sub;
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'webhook.update', entity: 'webhook_subscription', entityId: id, diff: b, ip });
      return presentSub(r);
    });
  }

  async remove(a: RequestActor, id: string, ip: string | null) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.sub(tx, id);
      await tx.query(`UPDATE webhook_subscription SET deleted_at = now(), status = 'disabled', disabled_reason = 'deleted', updated_by = $2, device_id = $3 WHERE id = $1`, [id, a.userId, a.deviceId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'webhook.delete', entity: 'webhook_subscription', entityId: id, ip });
    });
  }

  async rotateSecret(a: RequestActor, id: string, ip: string | null) {
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.sub(tx, id);
      await tx.query('UPDATE webhook_subscription SET secret_enc = $2, updated_by = $3, device_id = $4 WHERE id = $1',
        [id, await this.keys.encrypt(tx, a.tenantId, secret, `webhook_subscription:${id}:secret`), a.userId, a.deviceId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'webhook.rotate_secret', entity: 'webhook_subscription', entityId: id, ip });
    });
    return { secret };
  }

  async deliveries(a: RequestActor, id: string, q: { limit: number; offset: number }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.sub(tx, id, true);
      const rows = (await tx.query('SELECT *, count(*) OVER () AS total_count FROM webhook_delivery WHERE subscription_id = $1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3', [id, q.limit, q.offset])).rows;
      return { total: Number(rows[0]?.total_count ?? 0), items: (rows as Delivery[]).map(presentDelivery) };
    });
  }

  async redeliver(a: RequestActor, deliveryId: string, ip: string | null) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const d = (await tx.query('SELECT * FROM webhook_delivery WHERE id = $1', [deliveryId])).rows[0] as Delivery | undefined;
      if (!d) throw new NotFoundException();
      await this.sub(tx, d.subscription_id);
      const id = randomUUID();
      await tx.query(`INSERT INTO webhook_delivery (id, tenant_id, subscription_id, event_id, event_type, envelope, redelivery_of, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, a.tenantId, d.subscription_id, d.event_id, d.event_type, d.envelope, d.id, a.deviceId]);
      await this.jobs.enqueue(tx, a.tenantId, DELIVER_JOB, id, EPOCH);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'webhook.redeliver', entity: 'webhook_delivery', entityId: id, diff: { of: d.id }, ip });
      return { id };
    });
  }

  /** Test ping: a `ping` envelope through the normal signed, logged delivery path. */
  async ping(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const s = await this.sub(tx, id);
      const did = randomUUID();
      const env = { id: randomUUID(), type: 'ping', occurredAt: new Date().toISOString(), data: { subscriptionId: s.id } };
      await tx.query(`INSERT INTO webhook_delivery (id, tenant_id, subscription_id, event_type, envelope, device_id) VALUES ($1,$2,$3,'ping',$4,$5)`, [did, a.tenantId, s.id, env, a.deviceId]);
      await this.jobs.enqueue(tx, a.tenantId, DELIVER_JOB, did, EPOCH);
      return { id: did };
    });
  }

  private async sub(tx: Tx, id: string, includeDeleted = false): Promise<Sub> {
    const s = (await tx.query(`SELECT * FROM webhook_subscription WHERE id = $1 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`, [id])).rows[0] as Sub | undefined;
    if (!s) throw new NotFoundException();
    return s;
  }

  // ---------- Jobs ----------
  /**
   * One outbox event → one delivery per listening subscription, but only where the subscription's CREATOR can currently
   * see the record in the event's module (D196); an inactive creator gets nothing.
   */
  async fanout(tenantId: string, eventId: string, _at: Date) {
    await this.db.tenantTx(tenantId, async (tx) => {
      const ev = (await tx.query('SELECT * FROM automation_event WHERE id = $1', [eventId])).rows[0];
      if (!ev) return;
      const subs = (await tx.query(`SELECT * FROM webhook_subscription WHERE status = 'active' AND deleted_at IS NULL AND events @> ARRAY[$1]::text[]`, [ev.type])).rows as Sub[];
      const client = ev.client_id ? (await tx.query('SELECT * FROM client WHERE id = $1', [ev.client_id])).rows[0] : null;
      const module = WEBHOOK_EVENT_MODULE[ev.type as WebhookEvent];
      for (const s of subs) {
        const u = (await tx.query('SELECT status, branch_id FROM app_user WHERE id = $1', [s.created_by])).rows[0];
        if (!u || u.status !== 'active' || !module) continue;
        const actor = { userId: s.created_by, teamIds: await loadTeamIds(tx, s.created_by), branchId: u.branch_id, roles: await loadUserRoles(tx, s.created_by) };
        const visible = client ? can(actor, module, 'view', clientCtx(visibilityOf(client))) : effectiveScope(actor, module, 'view')?.scope === 'all';
        const env = webhookEnvelope({ id: ev.id, type: ev.type, occurredAt: new Date(ev.occurred_at).toISOString(), entityType: ev.entity_type, entityId: ev.entity_id, clientId: ev.client_id, payload: ev.payload });
        const id = randomUUID();
        await tx.query(`INSERT INTO webhook_delivery (id, tenant_id, subscription_id, event_id, event_type, envelope, status, last_error, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'server')`,
          [id, tenantId, s.id, ev.id, ev.type, visible ? env : { id: ev.id, type: ev.type }, visible ? 'pending' : 'skipped', visible ? null : 'out_of_scope']);
        if (visible) await this.jobs.enqueue(tx, tenantId, DELIVER_JOB, id, EPOCH);
      }
    });
  }

  async deliver(tenantId: string, deliveryId: string, at: Date) {
    const ctx = await this.db.tenantTx(tenantId, async (tx) => {
      const d = (await tx.query('SELECT * FROM webhook_delivery WHERE id = $1', [deliveryId])).rows[0] as Delivery | undefined;
      if (!d || !['pending', 'retrying'].includes(d.status)) return null;
      const s = (await tx.query('SELECT * FROM webhook_subscription WHERE id = $1', [d.subscription_id])).rows[0] as Sub;
      if (s.status !== 'active' || s.deleted_at) {
        await tx.query(`UPDATE webhook_delivery SET status = 'failed', last_error = 'subscription_disabled', next_attempt_at = NULL WHERE id = $1`, [d.id]);
        return null;
      }
      return { d, s, secret: await this.keys.decrypt(tx, tenantId, s.secret_enc, `webhook_subscription:${s.id}:secret`) };
    });
    if (!ctx) return;
    const { d, s, secret } = ctx;
    const lim = webhookLimits();
    const body = JSON.stringify(d.envelope);
    const ts = Math.floor(at.getTime() / 1000);
    const sig = signatureHeader(ts, createHmac('sha256', secret).update(signedContent(ts, body)).digest('hex'));
    const started = Date.now();
    let code: number | null = null, err: string | null = null;
    try {
      const url = new URL(s.url);
      const address = await pinTarget(this.transport, url);
      const r = await this.transport.post({ url, address, body, timeoutMs: lim.timeoutMs, headers: {
        'content-type': 'application/json', 'user-agent': 'Worko-Webhooks/1', 'worko-event': d.event_type, 'worko-delivery': d.id,
        'worko-timestamp': String(ts), 'worko-signature': sig } });
      code = r.status;
      if (code < 200 || code >= 300) err = code >= 300 && code < 400 ? 'redirect_not_followed' : `http_${code}`;
    } catch (e) { err = e instanceof TargetError ? e.code : /timeout/i.test((e as Error).message) ? 'timeout' : 'network_error'; }
    const ms = Date.now() - started;
    const attempts = d.attempts + 1;
    const retryAt = !err || attempts >= lim.maxAttempts ? null : new Date(at.getTime() + webhookBackoffMs(attempts));
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx.query(`UPDATE webhook_delivery SET attempts = $2, status = $3, last_status_code = $4, last_error = $5, last_duration_ms = $6, next_attempt_at = $7, delivered_at = $8 WHERE id = $1`,
        [d.id, attempts, !err ? 'succeeded' : retryAt ? 'retrying' : 'failed', code, err, ms, retryAt, err ? null : at]);
      if (!err) await tx.query('UPDATE webhook_subscription SET consecutive_failures = 0, last_delivery_at = $2 WHERE id = $1', [s.id, at]);
      else if (!retryAt) {
        const r = (await tx.query(`UPDATE webhook_subscription SET consecutive_failures = consecutive_failures + 1,
            status = CASE WHEN consecutive_failures + 1 >= $2 THEN 'disabled' ELSE status END,
            disabled_reason = CASE WHEN consecutive_failures + 1 >= $2 THEN 'too_many_failures' ELSE disabled_reason END WHERE id = $1 RETURNING status, consecutive_failures`,
        [s.id, lim.disableAfter])).rows[0];
        if (r.status === 'disabled') {
          await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'webhook.auto_disable', entity: 'webhook_subscription', entityId: s.id, diff: { failures: r.consecutive_failures } });
          this.log.warn(`Webhook ${s.id} disabled after ${r.consecutive_failures} failed deliveries`);
        }
      }
    });
    if (retryAt) throw new Reschedule(retryAt);
  }
}
