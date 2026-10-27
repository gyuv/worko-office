import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { effectiveScope, type Action, type Module } from '@worko/domain';
import { DbService } from '../db/db.service.js';
import { IS_PUBLIC, PERM, type RequestActor } from './context.js';
import { loadTeamIds, loadUserRoles } from './roles.repo.js';
import { TokenService } from './token.service.js';

/** Global guard: authenticates every non-@Public route, loads the actor, then enforces @Perm. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private tokens: TokenService, private db: DbService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new UnauthorizedException();
    let claims;
    try { claims = await this.tokens.verify(h.slice(7)); } catch { throw new UnauthorizedException(); }

    const actor = await this.db.tenantTx(claims.tid, async (tx) => {
      const s = (await tx.query(
        `SELECT s.revoked_at, s.wipe_requested_at, u.branch_id, u.status FROM device_session s JOIN app_user u ON u.id = s.user_id
         WHERE s.id = $1 AND s.user_id = $2`, [claims.sid, claims.sub])).rows[0];
      if (!s) throw new UnauthorizedException();
      if (s.wipe_requested_at) throw new UnauthorizedException({ code: 'DEVICE_WIPE', message: 'This device must erase local data' });
      if (s.revoked_at || s.status !== 'active') throw new UnauthorizedException();
      await tx.query('UPDATE device_session SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval \'1 minute\')', [claims.sid]);
      const a: RequestActor = {
        userId: claims.sub, tenantId: claims.tid, sessionId: claims.sid, deviceId: claims.dev,
        branchId: s.branch_id, teamIds: await loadTeamIds(tx, claims.sub), roles: await loadUserRoles(tx, claims.sub),
      };
      return a;
    });
    req.actor = actor;

    const perm = this.reflector.getAllAndOverride<{ module: Module; action: Action } | undefined>(PERM, targets);
    if (perm) {
      const g = effectiveScope(actor, perm.module, perm.action);
      if (!g || g.scope === 'none') throw new ForbiddenException(`Missing permission ${perm.module}:${perm.action}`);
    }
    return true;
  }
}
