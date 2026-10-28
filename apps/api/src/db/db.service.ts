import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';

export type Tx = pg.PoolClient;

/**
 * All tenant data access goes through `tenantTx`, which runs as the non-superuser `worko_app`
 * role with `app.tenant_id` set, so Postgres RLS enforces isolation even if a query forgets a filter.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL ?? 10) });

  async tenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE worko_app');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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
