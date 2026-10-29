import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { addDaysIso } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Clock } from '../common/clock.js';
import { CommService } from '../comm/comm.service.js';
import { DbService } from '../db/db.service.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { AuditWorkService } from './audit.service.js';
import { loadPracticeSettings, practiceSettingsSchema, requireFirmWide } from './common.js';
import { DscService } from './dsc.service.js';
import { NoticesService } from './notices.service.js';

export const PRACTICE_JOB = 'practice.daily';

/** Firm settings + the daily run: notice escalations, DSC/licence expiry alerts + renewal tasks, PBC reminders. */
@Injectable()
export class PracticeService implements OnModuleInit {
  private log = new Logger('Practice');
  constructor(private db: DbService, private audit: AuditService, private realtime: RealtimeService, private clock: Clock, private jobs: JobQueueService,
    private notices: NoticesService, private dsc: DscService, private work: AuditWorkService, private comm: CommService) {}

  onModuleInit() {
    this.jobs.register(PRACTICE_JOB, async (job, at) => {
      const day = new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
      await this.runDaily(job.tenant_id, day, null);
      throw new Reschedule(new Date(`${addDaysIso(day, 1)}T09:15:00+05:30`));
    });
    if (Number(process.env.JOB_POLL_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 2000)) > 0) {
      void this.scheduleDaily(new Date(`${addDaysIso(this.clock.todayIst(), 1)}T09:15:00+05:30`)).catch((e) => this.log.error(e));
    }
  }

  async scheduleDaily(at: Date) {
    return (await this.db.systemTx((tx) => tx.query(`INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) SELECT t.id, $1, t.id, $2 FROM tenant t
      ON CONFLICT (tenant_id, kind) WHERE kind = 'practice.daily' AND dead_at IS NULL DO NOTHING`, [PRACTICE_JOB, at]))).rowCount ?? 0;
  }

  getSettings(a: RequestActor) { return this.db.tenantTx(a.tenantId, (tx) => loadPracticeSettings(tx)); }

  async putSettings(a: RequestActor, body: unknown) {
    requireFirmWide(a, 'settings', 'edit');
    const p = practiceSettingsSchema.safeParse(body);
    if (!p.success) throw new BadRequestException({ message: 'Invalid settings', issues: p.error.issues });
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`INSERT INTO practice_settings (tenant_id, settings, updated_by) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET settings = $2, updated_by = $3, updated_at = now()`,
        [a.tenantId, JSON.stringify(p.data), a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'practice.settings_updated', entity: 'practice_settings', entityId: null, diff: p.data });
      return p.data;
    });
  }

  /** Idempotent: every alert carries a dedupe key / threshold mark, so re-running a day changes nothing. */
  async runDaily(tenantId: string, day: string, by: string | null) {
    const r = await this.db.tenantTx(tenantId, async (tx) => {
      const esc = await this.notices.escalateTx(tx, tenantId, day);
      const exp = await this.dsc.expiryTx(tx, tenantId, day);
      const pbc = await this.work.remindPbcTx(tx, tenantId, day, null, by);
      await this.audit.record(tx, tenantId, { actorId: by, deviceId: 'server', action: 'practice.daily_run', entity: 'practice_settings', entityId: null,
        diff: { day, escalations: esc.notified, alerts: exp.alerts, renewalTasks: exp.tasks, pbcReminders: pbc.queued.length } });
      return { day, escalations: esc.notified, expiryAlerts: exp.alerts, renewalTasks: exp.tasks, pbcReminders: pbc.queued.length, pbcSkipped: pbc.skipped, queued: pbc.queued,
        cursor: Math.max(esc.cursor, exp.cursor) };
    });
    if (r.cursor) this.realtime.publish({ type: 'changed', tenantId, cursor: r.cursor });
    for (const id of r.queued) await this.comm.deliverNow(tenantId, id, this.clock.now());
    const { cursor: _c, queued: _q, ...out } = r;
    return out;
  }

  run(a: RequestActor, asOf?: string) {
    requireFirmWide(a, 'settings', 'edit');
    return this.runDaily(a.tenantId, asOf ?? this.clock.todayIst(), a.userId);
  }
}
