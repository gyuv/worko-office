import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DbService } from '../db/db.service.js';
import { AuditService } from './audit.service.js';

const q = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), entity: z.string().optional() });

@Controller('audit')
export class AuditController {
  constructor(private db: DbService, private audit: AuditService) {}

  @Get() @Perm('audit_log', 'view')
  list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(q)) p: z.infer<typeof q>) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(
      `SELECT l.seq, l.at, l.action, l.entity, l.entity_id AS "entityId", l.diff, l.ip, l.actor_id AS "actorId", u.name AS "actorName"
       FROM audit_log l LEFT JOIN app_user u ON u.id = l.actor_id
       WHERE ($1::bigint IS NULL OR l.seq < $1) AND ($2::text IS NULL OR l.entity = $2) ORDER BY l.seq DESC LIMIT $3`,
      [p.before ?? null, p.entity ?? null, p.limit])).rows);
  }

  @Get('verify') @Perm('audit_log', 'view')
  verify(@CurrentActor() a: RequestActor) { return this.db.tenantTx(a.tenantId, (tx) => this.audit.verify(tx, a.tenantId)); }
}
