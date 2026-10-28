import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { can } from '@worko/domain';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CurrentActor, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';

const createB = z.object({ name: z.string().trim().min(1).max(120), leadUserId: z.string().uuid().nullable().optional(), branchId: z.string().uuid().optional(), memberIds: z.array(z.string().uuid()).max(500).default([]) });
const membersB = z.object({ userIds: z.array(z.string().uuid()).max(500) });

@Controller('teams')
export class TeamsController {
  constructor(private db: DbService, private audit: AuditService, private realtime: RealtimeService) {}

  @Get() @Perm('users', 'view')
  list(@CurrentActor() a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(
      `SELECT t.id, t.name, t.branch_id AS "branchId", t.lead_user_id AS "leadUserId",
              coalesce(array_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS "memberIds"
       FROM team t LEFT JOIN team_member m ON m.team_id = t.id WHERE t.deleted_at IS NULL GROUP BY t.id ORDER BY t.name`)).rows);
  }

  @Post() @Perm('users', 'edit')
  async create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(createB)) b: z.infer<typeof createB>) {
    const branchId = b.branchId ?? a.branchId;
    if (!can(a, 'users', 'edit', { branchId })) throw new ForbiddenException();
    const id = uuidv7();
    const cursor = await this.db.tenantTx(a.tenantId, async (tx) => {
      if (b.leadUserId) await this.assertManageable(tx, a, [b.leadUserId]);
      const r = await tx.query(`INSERT INTO team (id, tenant_id, name, branch_id, lead_user_id, updated_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING sync_cursor`,
        [id, a.tenantId, b.name, branchId, b.leadUserId ?? null, a.userId]);
      await this.setMembers(tx, a, id, b.memberIds);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'team.created', entity: 'team', entityId: id, diff: b });
      return Number(r.rows[0].sync_cursor);
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor });
    return { id };
  }

  @Put(':id/members') @HttpCode(204) @Perm('users', 'edit')
  async members(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(membersB)) b: z.infer<typeof membersB>) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const t = (await tx.query('SELECT branch_id FROM team WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
      if (!t || !can(a, 'users', 'edit', { branchId: t.branch_id })) throw new ForbiddenException();
      await this.setMembers(tx, a, id, b.userIds);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'team.members_set', entity: 'team', entityId: id, diff: b });
    });
  }

  /** Users must exist in this firm (RLS) and sit in a branch the actor may edit — FKs alone bypass both. */
  private async assertManageable(tx: Tx, a: RequestActor, userIds: string[]) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const r = (await tx.query(`SELECT id, branch_id FROM app_user WHERE id = ANY($1) AND deleted_at IS NULL AND status = 'active'`, [ids])).rows;
    if (r.length !== ids.length || r.some((u) => !can(a, 'users', 'edit', { branchId: u.branch_id }))) throw new ForbiddenException('Unknown user or outside your scope');
  }

  private async setMembers(tx: Tx, a: RequestActor, teamId: string, userIds: string[]) {
    await this.assertManageable(tx, a, userIds);
    await tx.query('DELETE FROM team_member WHERE team_id = $1', [teamId]);
    for (const u of new Set(userIds)) await tx.query('INSERT INTO team_member (tenant_id, team_id, user_id) VALUES ($1,$2,$3)', [a.tenantId, teamId, u]);
  }
}
