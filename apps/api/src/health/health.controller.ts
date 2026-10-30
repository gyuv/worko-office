import { BeforeApplicationShutdown, Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PRODUCT } from '@worko/domain';
import { Public } from '../auth/context.js';
import { DbService } from '../db/db.service.js';

@Public()
@Controller('health')
export class HealthController implements BeforeApplicationShutdown {
  private draining = false;
  constructor(private db: DbService) {}

  @Get()
  get() { return { status: 'ok', product: PRODUCT.name }; }

  /** Liveness: the process answers (no dependencies) — restart only when this fails. */
  @Get('live')
  live() { return { status: 'ok' }; }

  /** Readiness: database reachable and not shutting down — load balancers stop routing on 503 (D199). */
  @Get('ready')
  async ready() {
    if (this.draining) throw new ServiceUnavailableException({ code: 'DRAINING', message: 'Shutting down' });
    try { await this.db.pool.query('SELECT 1'); } catch { throw new ServiceUnavailableException({ code: 'DB_UNAVAILABLE', message: 'Database unavailable' }); }
    return { status: 'ready' };
  }

  /** Graceful shutdown: report not-ready first, so in-flight requests finish while new traffic drains away. */
  beforeApplicationShutdown() { this.draining = true; }
  isDraining() { return this.draining; }
}
