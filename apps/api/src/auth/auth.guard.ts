import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { effectiveFeatures, effectiveScope, tenantBlocked, type Action, type Module, type SaasFeature } from '@worko/domain';
import { DbService } from '../db/db.service.js';
import { ApiKeysService } from '../publicapi/api-keys.service.js';
import { PUBLIC_API } from '../publicapi/decorators.js';
import { EXTENSION_OK, FEATURE, IS_PUBLIC, PERM, PLATFORM_ROUTE, PORTAL_ALLOWED, type PortalActor, type RequestActor } from './context.js';
import { ImpersonationService } from '../platform/impersonation.service.js';
import { PlatformAuthService } from '../platform/platform-auth.service.js';
import { loadTeamIds, loadUserRoles } from './roles.repo.js';
import { TokenService } from './token.service.js';

/** Global guard: authenticates every non-@Public route, loads the actor, then enforces @Perm. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private tokens: TokenService, private db: DbService, private apiKeys: ApiKeysService,
    private pauth: PlatformAuthService, private imp: ImpersonationService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new UnauthorizedException();
    // Platform (super-admin) routes accept platform tokens only, and platform tokens work nowhere else (D178).
    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ROUTE, targets)) {
      req.platformAdmin = await this.pauth.authenticate(h.slice(7), req.ip ?? null);
      return true;
    }
    // Public-API keys (M18): default deny — only @PublicApi routes, scopes ∩ creator rights (D190, D193).
    if (h.startsWith('Bearer wk_')) {
      req.actor = await this.apiKeys.authenticate(req, h.slice(7), { publicApi: !!this.reflector.getAllAndOverride<boolean>(PUBLIC_API, targets),
        perm: this.reflector.getAllAndOverride<{ module: Module; action: Action } | undefined>(PERM, targets) });
      await this.tenantGate(req.actor.tenantId, targets);
      return true;
    }
    // Portal routes accept portal sessions only; everything else accepts staff sessions only (D126).
    if (this.reflector.getAllAndOverride<boolean>(PORTAL_ALLOWED, targets)) {
      req.portal = await this.portal(h.slice(7));
      await this.tenantGate(req.portal.tenantId, targets);
      return true;
    }
    let claims;
    try { claims = await this.tokens.verify(h.slice(7)); } catch {
      // Support impersonation: distinct token type, approved + unexpired grant, read-only unless consented, double-audited (D180, D181).
      const imp = await this.imp.authenticate(h.slice(7), req.method, req.originalUrl ?? req.url, req.ip ?? null);
      await this.tenantGate(imp.tenantId, targets);
      req.actor = imp;
      ctx.switchToHttp().getResponse().setHeader('X-Worko-Impersonation', imp.impersonation!.grantId);
      const perm = this.reflector.getAllAndOverride<{ module: Module; action: Action } | undefined>(PERM, targets);
      if (perm) { const g = effectiveScope(imp, perm.module, perm.action); if (!g || g.scope === 'none') throw new ForbiddenException(`Missing permission ${perm.module}:${perm.action}`); }
      return true;
    }

    const actor = await this.db.tenantTx(claims.tid, async (tx) => {
      const s = (await tx.query(
        `SELECT s.revoked_at, s.wipe_requested_at, s.platform, s.elevated_until, u.branch_id, u.status FROM device_session s JOIN app_user u ON u.id = s.user_id
         WHERE s.id = $1 AND s.user_id = $2`, [claims.sid, claims.sub])).rows[0];
      if (!s) throw new UnauthorizedException();
      if (s.wipe_requested_at) throw new UnauthorizedException({ code: 'DEVICE_WIPE', message: 'This device must erase local data' });
      if (s.revoked_at || s.status !== 'active') throw new UnauthorizedException();
      await tx.query('UPDATE device_session SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval \'1 minute\')', [claims.sid]);
      const a: RequestActor = {
        userId: claims.sub, tenantId: claims.tid, sessionId: claims.sid, deviceId: claims.dev,
        branchId: s.branch_id, teamIds: await loadTeamIds(tx, claims.sub), roles: await loadUserRoles(tx, claims.sub),
        platform: s.platform, elevatedUntil: s.elevated_until,
      };
      return a;
    });
    req.actor = actor;
    await this.tenantGate(actor.tenantId, targets);
    // Browser-extension sessions are limited to the vault autofill surface.
    if (actor.platform === 'extension' && !this.reflector.getAllAndOverride<boolean>(EXTENSION_OK, targets)) {
      throw new ForbiddenException('Not available to the browser extension');
    }

    const perm = this.reflector.getAllAndOverride<{ module: Module; action: Action } | undefined>(PERM, targets);
    if (perm) {
      const g = effectiveScope(actor, perm.module, perm.action);
      if (!g || g.scope === 'none') throw new ForbiddenException(`Missing permission ${perm.module}:${perm.action}`);
    }
    return true;
  }

  /** Suspended firms (platform or subscription) are blocked but keep their data; switched-off modules answer 403 (D182, D183). */
  private async tenantGate(tenantId: string, targets: Parameters<Reflector['getAllAndOverride']>[1]) {
    const feature = this.reflector.getAllAndOverride<SaasFeature | undefined>(FEATURE, targets);
    const t = await this.db.tenantTx(tenantId, async (tx) => (await tx.query(
      `SELECT t.status, t.sub_status, t.feature_flags, p.modules FROM tenant t LEFT JOIN saas_plan p ON p.key = t.plan WHERE t.id = $1`, [tenantId])).rows[0]);
    if (!t) throw new UnauthorizedException();
    if (tenantBlocked({ status: t.status, subStatus: t.sub_status })) throw new ForbiddenException({ code: 'TENANT_SUSPENDED', message: 'This firm\'s account is suspended. Contact Worko support.' });
    if (feature && !effectiveFeatures(t.modules === null ? null : { modules: t.modules }, t.feature_flags)[feature]) {
      throw new ForbiddenException({ code: 'feature_disabled', message: `The ${feature} module is not enabled on this firm's plan` });
    }
  }

  private async portal(token: string): Promise<PortalActor> {
    let c;
    try { c = await this.tokens.verifyPortal(token); } catch { throw new UnauthorizedException(); }
    return this.db.tenantTx(c.tid, async (tx) => {
      const s = (await tx.query(`SELECT s.revoked_at, u.status, u.name, u.email, u.phone FROM portal_session s JOIN portal_user u ON u.id = s.portal_user_id
        WHERE s.id = $1 AND s.portal_user_id = $2`, [c.sid, c.sub])).rows[0];
      if (!s || s.revoked_at || s.status !== 'active') throw new UnauthorizedException();
      await tx.query(`UPDATE portal_session SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`, [c.sid]);
      return { tenantId: c.tid, portalUserId: c.sub, sessionId: c.sid, name: s.name, email: s.email, phone: s.phone };
    });
  }
}
