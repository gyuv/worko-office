import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { effectiveScope, istDate, nextScheduleRun, reportScheduleSchema, schedulePeriodKey, type ReportSchedule } from '@worko/domain';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { loadTeamIds, loadUserRoles } from '../auth/roles.repo.js';
import { publicBase } from '../billing/providers.js';
import { Params } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { CommService } from '../comm/comm.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { insertNotifications } from '../notifications/insert.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { renderRun, type ExportFormat } from './render.js';
import { firmPublisher, ReportsService, tokenHash } from './reports.service.js';

export const SCHEDULE_JOB = 'reports.schedule';
/** Consecutive failed periods before a schedule pauses itself (owner is told). */
export const PAUSE_AFTER_FAILURES = 3;
/** A run row left 'running' longer than this is reclaimed by the next attempt. */
export const RUN_LEASE_MS = 10 * 60_000;
/** Export rows (link metadata) are purged this long after their link expired. */
export const EXPORT_RETENTION_DAYS = 30;
type ScheduleIn = { name: string; reportId?: string; catalogueKey?: string; params?: Record<string, string | number>; schedule?: unknown; recipientIds: string[];
  delivery?: 'email' | 'in_app'; format?: ExportFormat; linkTtlDays?: number };
type ScheduleRow = Record<string, unknown> & { id: string; tenant_id: string; schedule: ReportSchedule; recipient_ids: string[]; owner_id: string; next_run_at: Date | null };

const out = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, ownerId: r.owner_id, reportId: r.report_id, catalogueKey: r.catalogue_key, params: r.params, schedule: r.schedule, recipientIds: r.recipient_ids,
  delivery: r.delivery, format: r.format, linkTtlDays: r.link_ttl_days, enabled: r.enabled, status: r.status, pausedReason: r.paused_reason, consecutiveFailures: r.consecutive_failures,
  nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, version: r.version,
});
const has = (a: RequestActor, m: Parameters<typeof effectiveScope>[1], x: Parameters<typeof effectiveScope>[2]) => !!a.superAdmin || (effectiveScope(a, m, x)?.scope ?? 'none') !== 'none';

/**
 * Scheduled reports (D166/D167): an IST schedule; each occurrence runs the report AS EACH RECIPIENT (their own scope; no
 * permission → skipped), renders the file, stores it encrypted behind a recipient-bound expiring link and delivers the LINK
 * (transactional e-mail through comm, or an in-app notification) — never the data. One run row per schedule × period ×
 * recipient makes re-runs no-ops; repeated failures pause the schedule.
 */
@Injectable()
export class ReportScheduleService implements OnModuleInit {
  private log = new Logger('Reports');
  constructor(private db: DbService, private audit: AuditService, private clock: Clock, private jobs: JobQueueService, private comm: CommService,
    private realtime: RealtimeService, private reports: ReportsService) {}

  onModuleInit() { this.jobs.register(SCHEDULE_JOB, (j, at) => this.process(j.tenant_id, j.ref_id, at)); }

  private parseSchedule(raw: unknown): ReportSchedule {
    const p = reportScheduleSchema.safeParse(raw);
    if (!p.success) throw new BadRequestException({ message: 'Invalid schedule', code: 'invalid_schedule', issues: p.error.issues });
    return p.data;
  }
  /** Scheduling for others needs firm-wide reports:approve, or the others must be the scheduler's direct reports (D175). */
  private async checkRecipientRights(tx: Tx, a: RequestActor, ids: string[]) {
    const others = ids.filter((x) => x !== a.userId);
    if (!others.length || firmPublisher(a)) return;
    const n = (await tx.query('SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1::uuid[]) AND manager_id = $2', [others, a.userId])).rows[0].n;
    if (n !== others.length) throw new ForbiddenException({ message: 'You can schedule reports for yourself and your direct reports only', code: 'recipients_forbidden' });
  }
  private async checkRecipients(tx: Tx, ids: string[]) {
    const n = (await tx.query(`SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND status = 'active' AND kind = 'staff'`, [ids])).rows[0].n;
    if (n !== ids.length) throw new BadRequestException({ message: 'Recipients must be active staff users', code: 'unknown_user' });
  }
  private visibleSql(a: RequestActor, p: Params) { return firmPublisher(a) ? 'TRUE' : `(s.owner_id = ${p.add(a.userId)}::uuid)`; }
  private async row(tx: Tx, a: RequestActor, id: string, lock = false) {
    const p = new Params([id]);
    const r = (await tx.query(`SELECT s.* FROM report_schedule s WHERE s.id = $1 AND s.deleted_at IS NULL AND ${this.visibleSql(a, p)}${lock ? ' FOR UPDATE' : ''}`, p.values)).rows[0];
    if (!r) throw new NotFoundException('Schedule not found');
    return r as ScheduleRow;
  }

  list(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      return { items: (await tx.query(`SELECT s.* FROM report_schedule s WHERE s.deleted_at IS NULL AND ${this.visibleSql(a, p)} ORDER BY lower(s.name), s.id`, p.values)).rows.map(out) };
    });
  }
  get(a: RequestActor, id: string) { return this.db.tenantTx(a.tenantId, async (tx) => out(await this.row(tx, a, id))); }

  async create(a: RequestActor, b: ScheduleIn) {
    const s = this.parseSchedule(b.schedule);
    const src = await this.reports.resolve(a, { reportId: b.reportId, catalogueKey: b.catalogueKey });
    this.reports.engine.check(a, { ...(src.definition as object), params: { ...((src.definition as { params?: object }).params ?? {}), ...(b.params ?? {}) } });
    const recipients = [...new Set(b.recipientIds)];
    const next = nextScheduleRun(s, this.clock.now());
    const id = await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.checkRecipients(tx, recipients);
      await this.checkRecipientRights(tx, a, recipients);
      const id = uuidv7();
      await tx.query(`INSERT INTO report_schedule (id, tenant_id, name, owner_id, report_id, catalogue_key, params, schedule, recipient_ids, delivery, format, link_ttl_days, next_run_at, updated_by, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$4,$14)`, [id, a.tenantId, b.name, a.userId, src.reportId, src.catalogueKey, JSON.stringify(b.params ?? {}), JSON.stringify(s), recipients,
        b.delivery ?? 'email', b.format ?? 'xlsx', b.linkTtlDays ?? 7, next, a.deviceId]);
      await this.jobs.enqueue(tx, a.tenantId, SCHEDULE_JOB, id, next);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'report.schedule_created', entity: 'report_schedule', entityId: id,
        diff: { name: b.name, reportId: src.reportId, catalogueKey: src.catalogueKey, schedule: s, recipients: recipients.length, delivery: b.delivery ?? 'email', format: b.format ?? 'xlsx' } });
      return id;
    });
    return this.get(a, id);
  }

  async update(a: RequestActor, id: string, b: Partial<Omit<ScheduleIn, 'reportId' | 'catalogueKey'>> & { enabled?: boolean }) {
    const s = b.schedule !== undefined ? this.parseSchedule(b.schedule) : null;
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.row(tx, a, id, true);
      if (r.owner_id !== a.userId && !firmPublisher(a)) throw new ForbiddenException({ message: 'Only the owner edits a schedule', code: 'forbidden' });
      const recipients = b.recipientIds ? [...new Set(b.recipientIds)] : r.recipient_ids;
      if (b.recipientIds) { await this.checkRecipients(tx, recipients); await this.checkRecipientRights(tx, a, recipients); }
      const sched = s ?? r.schedule;
      // Enabling again also resumes a schedule paused after failures.
      const resume = b.enabled === true && (r.status === 'paused' || !r.enabled);
      const next = s || resume ? nextScheduleRun(sched, this.clock.now()) : r.next_run_at;
      await tx.query(`UPDATE report_schedule SET name = $2, params = $3, schedule = $4, recipient_ids = $5, delivery = $6, format = $7, link_ttl_days = $8, enabled = $9,
          status = CASE WHEN $10 THEN 'active' ELSE status END, paused_reason = CASE WHEN $10 THEN NULL ELSE paused_reason END, consecutive_failures = CASE WHEN $10 THEN 0 ELSE consecutive_failures END,
          next_run_at = $11, updated_by = $12, updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, b.name ?? r.name, JSON.stringify(b.params ?? r.params), JSON.stringify(sched), recipients, b.delivery ?? r.delivery, b.format ?? r.format, b.linkTtlDays ?? r.link_ttl_days,
          b.enabled ?? r.enabled, resume, next, a.userId]);
      if ((s || resume) && next) await this.jobs.enqueue(tx, a.tenantId, SCHEDULE_JOB, id, next);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'report.schedule_updated', entity: 'report_schedule', entityId: id, diff: { fields: Object.keys(b), resumed: resume } });
    });
    return this.get(a, id);
  }
  async remove(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.row(tx, a, id, true);
      if (r.owner_id !== a.userId && !firmPublisher(a)) throw new ForbiddenException({ message: 'Only the owner deletes a schedule', code: 'forbidden' });
      await tx.query('UPDATE report_schedule SET deleted_at = now(), enabled = false, updated_by = $2, version = version + 1 WHERE id = $1', [id, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'report.schedule_deleted', entity: 'report_schedule', entityId: id, diff: { name: r.name } });
    });
  }
  runs(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.row(tx, a, id);
      return { items: (await tx.query(`SELECT r.id, r.period_key AS "periodKey", r.recipient_id AS "recipientId", u.name AS "recipientName", r.status, r.skip_reason AS "skipReason", r.row_count AS "rowCount",
          r.error, r.occurrence_at AS "occurrenceAt", r.started_at AS "startedAt", r.finished_at AS "finishedAt" FROM report_schedule_run r LEFT JOIN app_user u ON u.id = r.recipient_id
        WHERE r.schedule_id = $1 ORDER BY r.started_at DESC, r.id LIMIT 200`, [id])).rows };
    });
  }

  private async actorFor(tx: Tx, tenantId: string, userId: string): Promise<RequestActor | null> {
    const u = (await tx.query(`SELECT id, branch_id FROM app_user WHERE id = $1 AND status = 'active' AND deleted_at IS NULL AND kind = 'staff'`, [userId])).rows[0];
    if (!u) return null;
    return { userId: u.id, tenantId, sessionId: '', deviceId: 'report-schedule', branchId: u.branch_id ?? null, teamIds: await loadTeamIds(tx, u.id), roles: await loadUserRoles(tx, u.id) };
  }

  /** Retention: export rows whose link expired more than EXPORT_RETENTION_DAYS ago are deleted (runs keep the history). */
  async purgeExports(tenantId: string, at: Date) {
    return this.db.tenantTx(tenantId, async (tx) => (await tx.query('DELETE FROM report_export WHERE expires_at < $1', [new Date(at.getTime() - EXPORT_RETENTION_DAYS * 86_400_000)])).rowCount ?? 0);
  }

  /** One occurrence (job handler; `at` = the queue's clock). Throws Reschedule to the next occurrence. */
  async process(tenantId: string, id: string, at: Date): Promise<void> {
    const s = await this.db.tenantTx(tenantId, async (tx) => (await tx.query('SELECT * FROM report_schedule WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0] as ScheduleRow | undefined);
    if (!s || !s.enabled || s.status !== 'active' || !s.next_run_at) return;
    if (s.next_run_at > at) throw new Reschedule(s.next_run_at); // edited since this job was queued
    await this.purgeExports(tenantId, at);
    const occurrence = s.next_run_at; const period = schedulePeriodKey(s.schedule, occurrence);
    let failed = 0; let delivered = 0;
    for (const recipient of s.recipient_ids) {
      const r = await this.deliverOne(s, recipient, period, occurrence, at).catch((e: Error) => { this.log.error(e); return 'failed' as const; });
      if (r === 'failed') failed++; else if (r === 'delivered') delivered++;
    }
    const next = await this.db.tenantTx(tenantId, async (tx) => {
      const cur = (await tx.query('SELECT consecutive_failures FROM report_schedule WHERE id = $1 FOR UPDATE', [id])).rows[0];
      const fails = failed ? Number(cur.consecutive_failures) + 1 : 0;
      const pause = fails >= PAUSE_AFTER_FAILURES;
      const nextAt = nextScheduleRun(s.schedule, at > occurrence ? at : occurrence);
      await tx.query(`UPDATE report_schedule SET last_run_at = $2, next_run_at = $3, consecutive_failures = $4, status = CASE WHEN $5 THEN 'paused' ELSE status END,
        paused_reason = CASE WHEN $5 THEN 'repeated_failures' ELSE paused_reason END, version = version + 1 WHERE id = $1`, [id, at, nextAt, fails, pause]);
      if (pause) {
        await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'report.schedule_paused', entity: 'report_schedule', entityId: id, diff: { failures: fails, period } });
        await insertNotifications(tx, tenantId, { userIds: [s.owner_id], category: 'report.failed', priority: 'high', title: `Scheduled report paused: ${String(s.name).slice(0, 120)}`,
          body: `Delivery failed ${fails} times in a row. Fix it and enable the schedule again.`, entityType: 'report_schedule', entityId: id, dedupeKey: `report-paused:${id}:${period}` });
      }
      return pause ? null : nextAt; // a paused schedule is not re-queued
    });
    this.log.log(`Schedule ${id} ${period}: ${delivered} delivered, ${failed} failed`);
    if (next) throw new Reschedule(next);
  }

  /** Claim (idempotent per schedule × period × recipient) → run as the recipient → encrypted export → link by e-mail or in-app. */
  private async deliverOne(s: ScheduleRow, recipientId: string, period: string, occurrence: Date, at: Date): Promise<'delivered' | 'skipped' | 'failed' | 'done_before'> {
    const tenantId = s.tenant_id;
    const claim = await this.db.tenantTx(tenantId, async (tx) => {
      const runId = uuidv7();
      const ins = await tx.query(`INSERT INTO report_schedule_run (id, tenant_id, schedule_id, period_key, recipient_id, occurrence_at, started_at, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'server')
        ON CONFLICT (tenant_id, schedule_id, period_key, recipient_id) DO UPDATE SET started_at = EXCLUDED.started_at
          WHERE report_schedule_run.status = 'running' AND report_schedule_run.started_at < $8
        RETURNING id`, [runId, tenantId, s.id, period, recipientId, occurrence, at, new Date(at.getTime() - RUN_LEASE_MS)]);
      // Stale-lease reclaim: a run left 'running' past the lease (crash) is taken over under its existing id.
      if (!ins.rowCount) return null;
      return { runId: ins.rows[0].id as string, actor: await this.actorFor(tx, tenantId, recipientId), email: (await tx.query('SELECT email FROM app_user WHERE id = $1', [recipientId])).rows[0]?.email as string | undefined };
    });
    if (!claim) return 'done_before';
    const finish = (status: 'delivered' | 'skipped' | 'failed', f: { skip?: string; error?: string; rows?: number; exportId?: string; messageId?: string | null; notificationId?: string | null } = {}) =>
      this.db.tenantTx(tenantId, (tx) => tx.query(`UPDATE report_schedule_run SET status = $2, skip_reason = $3, error = $4, row_count = $5, export_id = $6, message_id = $7, notification_id = $8, finished_at = $9,
        version = version + 1 WHERE id = $1`, [claim.runId, status, f.skip ?? null, f.error ?? null, f.rows ?? null, f.exportId ?? null, f.messageId ?? null, f.notificationId ?? null, at]));
    const skip = async (reason: string) => { await finish('skipped', { skip: reason }); return 'skipped' as const; };
    const a = claim.actor;
    if (!a) return skip('recipient_inactive');
    // A scheduled file is an export: the recipient needs reports:view + reports:export themselves.
    if (!has(a, 'reports', 'view') || !has(a, 'reports', 'export')) return skip('no_permission');
    try {
      // The recipient must be able to open the saved report themselves (owner / shared); otherwise skipped (D174).
      const src = await this.reports.resolve(a, { reportId: (s.report_id as string) ?? undefined, catalogueKey: (s.catalogue_key as string) ?? undefined }).catch((e) => {
        if (e instanceof NotFoundException) return null;
        throw e;
      });
      if (!src) return skip('not_shared');
      const run = await this.reports.engine.run(a, src.definition, { params: s.params as Record<string, string | number>, allRows: true });
      this.reports.requireExport(a, run);
      const file = await renderRun(run, s.format as ExportFormat, String(s.name), run.definition.groupBy.length ? 'groups' : 'rows'); // name/mime/size; the file itself is re-rendered at download (D171)
      const token = randomBytes(32).toString('base64url');
      const expires = new Date(at.getTime() + Number(s.link_ttl_days) * 86_400_000);
      const url = `${publicBase()}/reports/downloads/${token}`;
      const sent = await this.db.tenantTx(tenantId, async (tx) => {
        const exportId = uuidv7();
        await tx.query(`INSERT INTO report_export (id, tenant_id, user_id, schedule_id, run_id, name, mime, size_bytes, row_count, token_hash, expires_at, format, period_key, device_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'server')`, [exportId, tenantId, recipientId, s.id, claim.runId, file.name, file.mime, file.body.length, run.rowCount,
          tokenHash(token), expires, s.format, period]);
        const title = `Report ready: ${String(s.name).slice(0, 120)}`;
        // The message carries a link only — no figures, names or rows (D166).
        const text = `Your scheduled report "${s.name}" (${period.replace(/^W/, 'week of ')}) is ready: ${url}\n\nSign in to Worko to download it; the link works only for you and expires on ${istDate(expires)}.`;
        let messageId: string | null = null; let notificationId: string | null = null; let cursor = 0;
        if (s.delivery === 'email') {
          if (!claim.email) throw new Error('recipient has no e-mail');
          const q = await this.comm.queueTx(tx, tenantId, { clientId: null, contactId: null, channel: 'email', address: claim.email.toLowerCase(), category: 'transactional', subject: title, text,
            createdBy: s.owner_id, now: at, meta: { reportScheduleId: s.id, period }, format: 'text', idempotencyKey: `report:${claim.runId}` });
          if ('error' in q) throw new Error(`email_${q.error}`);
          messageId = q.id;
        } else {
          const n = await insertNotifications(tx, tenantId, { userIds: [recipientId], category: 'report.ready', title, body: `${period.replace(/^W/, 'Week of ')} · ${run.rowCount} row(s). Link expires ${istDate(expires)}.`,
            entityType: 'report_export', entityId: exportId, dedupeKey: `report:${s.id}:${period}` });
          notificationId = n.ids[0] ?? null; cursor = n.cursor;
        }
        await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'server', action: 'report.schedule_delivered', entity: 'report_schedule', entityId: s.id,
          diff: { period, recipientId, rows: run.rowCount, format: s.format, delivery: s.delivery, exportId } });
        return { exportId, messageId, notificationId, cursor };
      });
      if (sent.cursor) this.realtime.publish({ type: 'changed', tenantId, cursor: sent.cursor, userIds: [recipientId] });
      if (sent.messageId) {
        const d = await this.comm.deliverNow(tenantId, sent.messageId, at);
        if (d === 'failed' || d === 'cancelled') { await finish('failed', { error: `email_${d}`, rows: run.rowCount, exportId: sent.exportId, messageId: sent.messageId }); return 'failed'; }
      }
      await finish('delivered', { rows: run.rowCount, exportId: sent.exportId, messageId: sent.messageId, notificationId: sent.notificationId });
      return 'delivered';
    } catch (e) {
      if (e instanceof ForbiddenException) return skip('no_permission');
      await finish('failed', { error: String((e as Error).message ?? e).slice(0, 300) });
      return 'failed';
    }
  }
}
