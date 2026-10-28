import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { backoffMs } from '@worko/notify';
import { DbService, type Tx } from '../db/db.service.js';

export type Job = { id: string; tenant_id: string; kind: string; ref_id: string; attempts: number; max_attempts: number };
/** `at` is the queue's clock for this run (injectable in tests via `runOnce(batch, now)`). */
export type JobHandler = (job: Job, at: Date) => Promise<void>;
/** Thrown by a handler to re-run the job later without counting it as a failure (e.g. snoozed). */
export class Reschedule extends Error { constructor(readonly at: Date) { super('reschedule'); } }

/**
 * Postgres-backed queue (SELECT … FOR UPDATE SKIP LOCKED). Chosen over BullMQ for now so jobs commit
 * atomically with the data that creates them (no lost/phantom jobs) and tests need no Redis.
 */
@Injectable()
export class JobQueueService implements OnModuleInit, OnApplicationShutdown {
  private log = new Logger('Jobs');
  private handlers = new Map<string, JobHandler>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private db: DbService) {}

  register(kind: string, h: JobHandler) { this.handlers.set(kind, h); }

  /** Enqueue inside the caller's tenant transaction, so the job exists iff the data commits. */
  enqueue(tx: Tx, tenantId: string, kind: string, refId: string, runAt: Date = new Date()) {
    return tx.query('INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) VALUES ($1,$2,$3,$4)', [tenantId, kind, refId, runAt]);
  }

  onModuleInit() {
    const ms = Number(process.env.JOB_POLL_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 2000));
    if (ms > 0) this.timer = setInterval(() => void this.runOnce().catch((e) => this.log.error(e)), ms).unref();
  }
  onApplicationShutdown() { clearInterval(this.timer); }

  /** Claims and runs due jobs; returns how many ran. Safe to call concurrently from several nodes. */
  async runOnce(batch = 50, now?: Date): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const at = now ?? new Date();
      const jobs = (await this.db.systemTx((tx) => tx.query<Job>(
        `UPDATE job_queue SET locked_until = $2::timestamptz + interval '2 minutes', attempts = attempts + 1
         WHERE id IN (SELECT id FROM job_queue WHERE run_at <= $2 AND dead_at IS NULL AND (locked_until IS NULL OR locked_until < $2)
                      ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
         RETURNING id, tenant_id, kind, ref_id, attempts, max_attempts`, [batch, at]))).rows;
      for (const j of jobs) {
        // Batches run sequentially: refresh each job's lease right before running it so a slow batch can't
        // let another node re-claim (and re-run) jobs still waiting their turn here.
        const still = await this.db.systemTx((tx) => tx.query(
          `UPDATE job_queue SET locked_until = now() + interval '2 minutes' WHERE id = $1 AND dead_at IS NULL RETURNING id`, [j.id]));
        if (still.rowCount) await this.execute(j, at);
      }
      return jobs.length;
    } finally { this.running = false; }
  }

  private async execute(j: Job, at: Date) {
    const h = this.handlers.get(j.kind);
    try {
      if (!h) throw new Error(`No handler for ${j.kind}`);
      await h(j, at);
      await this.db.systemTx((tx) => tx.query('DELETE FROM job_queue WHERE id = $1', [j.id]));
    } catch (e) {
      if (e instanceof Reschedule) {
        await this.db.systemTx((tx) => tx.query('UPDATE job_queue SET run_at = $2, locked_until = NULL, attempts = attempts - 1 WHERE id = $1', [j.id, e.at]));
        return;
      }
      const dead = j.attempts >= j.max_attempts;
      const msg = (e as Error).message?.slice(0, 500) ?? 'error';
      await this.db.systemTx((tx) => tx.query(
        `UPDATE job_queue SET locked_until = NULL, last_error = $2, run_at = $3, dead_at = CASE WHEN $4 THEN now() END WHERE id = $1`,
        [j.id, msg, new Date(at.getTime() + backoffMs(j.attempts)), dead]));
      if (dead) this.log.error(`Job ${j.kind}/${j.ref_id} dead after ${j.attempts} attempts: ${msg}`);
    }
  }
}
