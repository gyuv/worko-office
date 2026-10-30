import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { currentCausation } from '../automation/causation.js';

export type Tx = pg.PoolClient;

/**
 * All tenant data access goes through `tenantTx`, which runs as the non-superuser `worko_app`
 * role with `app.tenant_id` set, so Postgres RLS enforces isolation even if a query forgets a filter.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL ?? 10),
    // Fail fast instead of hanging when the pool is exhausted (D173).
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 10_000),
    // Default ceilings for every pooled statement / idle transaction (D199); report runs set a tighter LOCAL timeout.
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 60_000),
    idle_in_transaction_session_timeout: Number(process.env.DB_IDLE_TX_TIMEOUT_MS ?? 120_000) });

  async tenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE worko_app');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const cause = currentCausation();
      if (cause) await c.query("SELECT set_config('app.causation', $1, true)", [JSON.stringify(cause)]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  /** Tenant transaction that cannot write (dry-runs, previews): Postgres refuses any INSERT/UPDATE/DELETE, and it always rolls back. */
  async readOnlyTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN TRANSACTION READ ONLY');
      await c.query('SET LOCAL ROLE worko_app');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  /** Tenant-less reads/writes on global tables (tenant directory, onboarding). Owner role; use sparingly. */
  async systemTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  onModuleDestroy() { return this.pool.end(); }
}
