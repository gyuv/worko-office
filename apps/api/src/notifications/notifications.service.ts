import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { defaultPrefs, planDelivery, prefsSchema, type Prefs } from '@worko/notify';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { JobQueueService, Reschedule, type Job } from '../jobs/job-queue.service.js';
import { DELIVER, ESCALATE, insertNotifications, MAX_ESCALATION, type NotifyInput } from './insert.js';

export { DELIVER, ESCALATE, insertNotifications, type NotifyInput };
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import { PUSH_PROVIDERS, type PushProviders, type PushSub } from './push.providers.js';

/** Actor used for writes made by the server itself (workers, schedulers). */
export const systemActor = (tenantId: string) =>
  ({ userId: null, tenantId, deviceId: 'server', sessionId: '', teamIds: [], branchId: null, roles: [] }) as unknown as RequestActor;

@Injectable()
export class NotificationsService implements OnModuleInit {
  constructor(
    private db: DbService, private jobs: JobQueueService, private sync: SyncService, private realtime: RealtimeService,
    private audit: AuditService, @Inject(PUSH_PROVIDERS) private push: PushProviders,
  ) {}

  onModuleInit() {
    this.jobs.register(DELIVER, (j) => this.deliver(j));
    this.jobs.register(ESCALATE, (j) => this.escalate(j));
  }

  /** Creates notifications in their own transaction and pings connected devices. */
  async send(tenantId: string, input: NotifyInput): Promise<string[]> {
    const r = await this.db.tenantTx(tenantId, (tx) => this.notifyInTx(tx, tenantId, input));
    if (r.cursor) this.realtime.publish({ type: 'changed', tenantId, cursor: r.cursor, userIds: input.userIds });
    return r.ids;
  }

  /** For callers already in a transaction (task assignment etc.). Publish `cursor` after commit. */
  notifyInTx(tx: Tx, tenantId: string, i: NotifyInput): Promise<{ ids: string[]; cursor: number }> { return insertNotifications(tx, tenantId, i); }

  private async prefsFor(tx: Tx, userId: string): Promise<Prefs> {
    const p = (await tx.query('SELECT prefs FROM notification_pref WHERE user_id = $1 AND deleted_at IS NULL', [userId])).rows[0]?.prefs;
    const parsed = prefsSchema.safeParse(p ?? {});
    return parsed.success ? parsed.data : defaultPrefs();
  }

  /** Push to every active device of the user; idempotent per (notification, subscription). */
  private async deliver(j: Job) {
    const now = new Date();
    const transient: string[] = [];
    await this.db.tenantTx(j.tenant_id, async (tx) => {
      // Row lock: a second worker delivering the same notification waits, then sees the 'sent' rows and skips.
      const n = (await tx.query('SELECT * FROM notification WHERE id = $1 FOR UPDATE', [j.ref_id])).rows[0];
      if (!n || n.deleted_at || n.read_at || n.acked_at) return; // seen on some device → don't buzz the others
      if (n.snoozed_until && n.snoozed_until > now) throw new Reschedule(n.snoozed_until);
      const plan = planDelivery({ category: n.category, priority: n.priority, fireAt: now, prefs: await this.prefsFor(tx, n.user_id) });
      if (!plan.push) return;
      if (plan.sendAt > now) throw new Reschedule(plan.sendAt);
      const subs = (await tx.query<PushSub>(
        `SELECT s.id, s.kind, s.endpoint, s.keys FROM push_subscription s
         LEFT JOIN notification_delivery d ON d.subscription_id = s.id AND d.notification_id = $2 AND d.status = 'sent'
         WHERE s.user_id = $1 AND s.disabled_at IS NULL AND d.id IS NULL`, [n.user_id, n.id])).rows;
      const payload = { id: n.id, title: n.title, body: n.body, category: n.category, priority: n.priority, entityType: n.entity_type, entityId: n.entity_id };
      for (const s of subs) {
        let status: 'sent' | 'failed' | 'pending'; let error: string | null = null;
        try {
          const r = await this.push[s.kind].send(s, payload);
          status = r === 'sent' ? 'sent' : 'failed';
          if (r === 'gone') { error = 'gone'; await tx.query(`UPDATE push_subscription SET disabled_at = now(), last_error = 'gone' WHERE id = $1`, [s.id]); }
        } catch (e) {
          status = 'pending'; error = (e as Error).message.slice(0, 300); transient.push(s.id);
        }
        await tx.query(
          `INSERT INTO notification_delivery (id, tenant_id, notification_id, subscription_id, channel, status, attempts, last_error, sent_at)
           VALUES ($1,$2,$3,$4,$5,$6,1,$7, CASE WHEN $6 = 'sent' THEN now() END)
           ON CONFLICT (notification_id, subscription_id) DO UPDATE SET status = EXCLUDED.status, attempts = notification_delivery.attempts + 1,
             last_error = EXCLUDED.last_error, sent_at = EXCLUDED.sent_at`,
          [uuidv7(), j.tenant_id, n.id, s.id, s.kind, status, error]);
      }
    });
    if (transient.length) throw new Error(`push failed for ${transient.length} device(s); will retry`);
  }

  /** Not acknowledged in time → notify the assignee's manager (then theirs), up to 3 levels. */
  private async escalate(j: Job) {
    let cursor = 0; let target: string | null = null;
    await this.db.tenantTx(j.tenant_id, async (tx) => {
      const n = (await tx.query('SELECT * FROM notification WHERE id = $1', [j.ref_id])).rows[0];
      if (!n || n.acked_at || n.deleted_at || n.escalation_level >= MAX_ESCALATION) return;
      // Manager first, else a team lead — and only someone still active.
      target = (await tx.query(
        `SELECT c.id AS target FROM app_user u
         CROSS JOIN LATERAL (
           SELECT u.manager_id AS id, 0 AS pref
           UNION ALL SELECT t.lead_user_id, 1 FROM team_member m JOIN team t ON t.id = m.team_id
             WHERE m.user_id = u.id AND t.lead_user_id IS NOT NULL AND t.deleted_at IS NULL
         ) c JOIN app_user tu ON tu.id = c.id AND tu.status = 'active' AND tu.deleted_at IS NULL
         WHERE u.id = $1 AND c.id <> u.id ORDER BY c.pref LIMIT 1`, [n.user_id])).rows[0]?.target ?? null;
      if (!target) return;
      const who = (await tx.query('SELECT name FROM app_user WHERE id = $1', [n.user_id])).rows[0]?.name ?? '';
      const r = await this.notifyInTx(tx, j.tenant_id, {
        userIds: [target], category: n.category, priority: n.priority === 'critical' ? 'critical' : 'high',
        title: `Escalated: ${n.title}`, body: `Not acknowledged by ${who}. ${n.body}`.trim(), entityType: n.entity_type, entityId: n.entity_id,
        requiresAck: true, escalateAfterMinutes: n.escalate_after_minutes, escalatedFrom: n.id, escalationLevel: n.escalation_level + 1,
        dedupeKey: `escalation:${n.id}`,
      });
      cursor = r.cursor;
      await this.audit.record(tx, j.tenant_id, { action: 'notification.escalated', entity: 'notification', entityId: n.id, diff: { to: target, level: n.escalation_level + 1 } });
    });
    if (cursor && target) this.realtime.publish({ type: 'changed', tenantId: j.tenant_id, cursor, userIds: [target] });
  }

  list(a: RequestActor, q: { unread?: boolean; limit: number; before?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(
      `SELECT id, category, priority, title, body, entity_type AS "entityType", entity_id AS "entityId", fire_at AS "fireAt",
              read_at AS "readAt", acked_at AS "ackedAt", snoozed_until AS "snoozedUntil", requires_ack AS "requiresAck",
              escalation_level AS "escalationLevel", version
       FROM notification WHERE user_id = $1 AND deleted_at IS NULL AND fire_at <= now()
         AND ($2::boolean IS NOT TRUE OR read_at IS NULL) AND ($3::timestamptz IS NULL OR fire_at < $3)
       ORDER BY fire_at DESC LIMIT $4`, [a.userId, q.unread ?? null, q.before ?? null, q.limit])).rows);
  }

  unreadCount(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => ({
      count: (await tx.query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND read_at IS NULL AND deleted_at IS NULL AND fire_at <= now()
        AND (snoozed_until IS NULL OR snoozed_until <= now())`, [a.userId])).rows[0].n as number,
    }));
  }

  /** read / ack / snooze — written through the sync layer so every device converges. */
  async act(a: RequestActor, id: string, action: 'read' | 'ack' | 'snooze', until?: Date) {
    const now = new Date().toISOString();
    const patch = action === 'read' ? { read_at: now } : action === 'ack' ? { acked_at: now, read_at: now } : { snoozed_until: until!.toISOString(), read_at: null };
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const own = (await tx.query('SELECT 1 FROM notification WHERE id = $1 AND user_id = $2', [id, a.userId])).rowCount;
      if (!own) throw new NotFoundException();
      const res = await this.sync.serverPatch(tx, a, 'notification', id, patch);
      if (action === 'snooze') {
        // A snoozed reminder must buzz again: re-arm every device's delivery for the new time.
        await tx.query(`UPDATE notification_delivery SET status = 'pending', sent_at = NULL WHERE notification_id = $1`, [id]);
        await this.jobs.enqueue(tx, a.tenantId, DELIVER, id, until);
      }
      if (action === 'ack') await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'notification.acknowledged', entity: 'notification', entityId: id });
      return res;
    });
    if (r) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r.cursor, userIds: [a.userId] });
  }

  async readAll(a: RequestActor) {
    let cursor = 0;
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const ids = (await tx.query('SELECT id FROM notification WHERE user_id = $1 AND read_at IS NULL AND deleted_at IS NULL AND fire_at <= now() LIMIT 1000', [a.userId])).rows;
      for (const { id } of ids) cursor = Math.max(cursor, (await this.sync.serverPatch(tx, a, 'notification', id, { read_at: new Date().toISOString() }))?.cursor ?? 0);
    });
    if (cursor) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor, userIds: [a.userId] });
  }

  getPrefs(a: RequestActor) { return this.db.tenantTx(a.tenantId, (tx) => this.prefsFor(tx, a.userId)); }

  async putPrefs(a: RequestActor, prefs: Prefs) {
    const cursor = await this.db.tenantTx(a.tenantId, async (tx) => {
      const cur = (await tx.query('SELECT id FROM notification_pref WHERE user_id = $1', [a.userId])).rows[0];
      let c: number;
      if (cur) c = (await this.sync.serverPatch(tx, a, 'notification_pref', cur.id, { prefs }))!.cursor;
      else c = Number((await tx.query(`INSERT INTO notification_pref (id, tenant_id, user_id, prefs, updated_by, field_versions) VALUES ($1,$2,$3,$4,$3,'{"prefs":1}') RETURNING sync_cursor`,
        [uuidv7(), a.tenantId, a.userId, JSON.stringify(prefs)])).rows[0].sync_cursor);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'notification_pref.updated', entity: 'notification_pref', entityId: a.userId, diff: prefs });
      return c;
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor, userIds: [a.userId] });
  }

  async subscribe(a: RequestActor, s: { kind: 'fcm' | 'webpush'; endpoint: string; keys?: { p256dh: string; auth: string } }) {
    if (s.kind === 'webpush' && !s.keys) throw new BadRequestException('Web Push subscriptions need keys');
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const id = uuidv7();
      const r = await tx.query(
        `INSERT INTO push_subscription (id, tenant_id, user_id, session_id, kind, endpoint, keys) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id, keys = EXCLUDED.keys, disabled_at = NULL, last_error = NULL
           -- Re-binding is allowed for your own endpoint, or one whose old session is gone; never steal a live one.
           WHERE push_subscription.user_id = EXCLUDED.user_id OR push_subscription.disabled_at IS NOT NULL
         RETURNING id`, [id, a.tenantId, a.userId, a.sessionId, s.kind, s.endpoint, s.keys ? JSON.stringify(s.keys) : null]);
      if (!r.rowCount) throw new ConflictException('This device is registered to another user');
      return { id: r.rows[0].id as string };
    });
  }

  async unsubscribe(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, (tx) => tx.query('UPDATE push_subscription SET disabled_at = now() WHERE id = $1 AND user_id = $2', [id, a.userId]));
  }
}
