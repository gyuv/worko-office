import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { IMPERSONATION_MAX_MINUTES, impersonationUsable } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { PlatformActor, RequestActor } from '../auth/context.js';
import { loadTeamIds, loadUserRoles } from '../auth/roles.repo.js';
import { TokenService } from '../auth/token.service.js';
import { DbService } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PlatformAuditService } from './platform-audit.service.js';
import { PlatformAuthService } from './platform-auth.service.js';

const grantSql = `SELECT g.id, g.status, g.reason, g.admin_name AS "adminName", g.platform_admin_id AS "platformAdminId", g.requested_write AS "requestedWrite",
  g.duration_minutes AS "durationMinutes", g.requested_at AS "requestedAt", g.decided_by AS "decidedBy", g.decided_at AS "decidedAt", g.write_consent AS "writeConsent",
  g.as_user_id AS "asUserId", g.expires_at AS "expiresAt", g.revoked_at AS "revokedAt", g.first_used_at AS "firstUsedAt", g.actions
  FROM impersonation_grant g`;
/** Routes an impersonation session may never call, even with write consent (credentials, sessions, consent itself, secret reveals). */
const BLOCKED = [/^\/v1\/auth\//, /^\/v1\/impersonation\//, /\/reveal$/, /^\/v1\/users(\/|$)/, /^\/v1\/privacy\/requests\/[^/]+\/erase$/];

/** The approver must be a partner (firm owner) — D180. */
function requirePartner(a: RequestActor) {
  if (a.impersonation) throw new ForbiddenException('Not available while impersonating');
  if (!a.roles.some((r) => r.key === 'partner')) throw new ForbiddenException('Only a partner can decide support access');
}

@Injectable()
export class ImpersonationService {
  constructor(private db: DbService, private audit: AuditService, private paudit: PlatformAuditService, private tokens: TokenService,
    private pauth: PlatformAuthService, private notifications: NotificationsService) {}

  /** Support asks for access; nothing is usable until a partner approves. */
  async request(p: PlatformActor, tenantId: string, b: { reason: string; write: boolean; minutes: number }) {
    const t = (await this.db.systemTx((tx) => tx.query('SELECT id FROM tenant WHERE id = $1', [tenantId]))).rows[0];
    if (!t) throw new NotFoundException();
    const id = uuidv7();
    const partners = await this.db.tenantTx(tenantId, async (tx) => {
      await tx.query(`INSERT INTO impersonation_grant (id, tenant_id, platform_admin_id, admin_name, reason, requested_write, duration_minutes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, tenantId, p.adminId, p.name, b.reason, b.write, Math.min(b.minutes, IMPERSONATION_MAX_MINUTES)]);
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'platform', action: 'impersonation.requested', entity: 'impersonation_grant', entityId: id, diff: { platformAdminId: p.adminId, write: b.write, minutes: b.minutes } });
      return (await tx.query(`SELECT DISTINCT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id WHERE r.key = 'partner' AND u.status = 'active'`)).rows.map((r) => r.id as string);
    });
    await this.paudit.record({ adminId: p.adminId, tenantId, action: 'platform.impersonation_requested', entity: 'impersonation_grant', entityId: id, diff: { write: b.write, minutes: b.minutes }, ip: p.ip });
    if (partners.length) {
      await this.notifications.send(tenantId, { userIds: partners, category: 'system.security', priority: 'high', title: 'Worko support requests access to your firm',
        body: `${b.write ? 'Read and write' : 'Read-only'} access for up to ${b.minutes} minutes. Approve or deny under Settings → Subscription → Support access.`, entityType: 'impersonation_grant', entityId: id, dedupeKey: `imp:${id}` });
    }
    return { id, status: 'requested' };
  }

  list(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`${grantSql} ORDER BY g.requested_at DESC LIMIT 50`)).rows);
  }

  listPlatform(tenantId: string) {
    return this.db.tenantTx(tenantId, async (tx) => (await tx.query(`${grantSql} ORDER BY g.requested_at DESC LIMIT 50`)).rows);
  }

  async decide(a: RequestActor, id: string, decision: 'approve' | 'deny', b: { writeConsent?: boolean; minutes?: number } = {}) {
    requirePartner(a);
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const g = (await tx.query(`SELECT * FROM impersonation_grant WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!g) throw new NotFoundException();
      if (g.status !== 'requested') throw new BadRequestException(`Request is already ${g.status}`);
      if (b.writeConsent && !g.requested_write) throw new BadRequestException('Support asked for read-only access; write cannot be granted on this request');
      const minutes = Math.min(b.minutes ?? g.duration_minutes, g.duration_minutes);
      if (decision === 'approve') {
        await tx.query(`UPDATE impersonation_grant SET status = 'approved', decided_by = $2, decided_at = now(), write_consent = $3, as_user_id = $2, expires_at = now() + make_interval(mins => $4) WHERE id = $1`,
          [id, a.userId, !!b.writeConsent, minutes]);
      } else {
        await tx.query(`UPDATE impersonation_grant SET status = 'denied', decided_by = $2, decided_at = now() WHERE id = $1`, [id, a.userId]);
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: `impersonation.${decision === 'approve' ? 'approved' : 'denied'}`, entity: 'impersonation_grant', entityId: id,
        diff: { writeConsent: !!b.writeConsent, minutes, platformAdminId: g.platform_admin_id } });
      return { adminId: g.platform_admin_id as string };
    });
    await this.paudit.record({ adminId: r.adminId, tenantId: a.tenantId, action: `platform.impersonation_${decision === 'approve' ? 'approved' : 'denied'}`, entity: 'impersonation_grant', entityId: id, diff: { decidedBy: a.userId, writeConsent: !!b.writeConsent } });
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`${grantSql} WHERE g.id = $1`, [id])).rows[0]);
  }

  /** The firm (any partner, or settings:edit holders) can revoke at any time; the platform can end its own session. */
  async revoke(a: RequestActor | null, id: string, tenantId: string, p: PlatformActor | null = null) {
    if (a?.impersonation) throw new ForbiddenException('Not available while impersonating');
    const r = await this.db.tenantTx(tenantId, async (tx) => {
      const g = (await tx.query(`UPDATE impersonation_grant SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1 AND status IN ('requested','approved') RETURNING platform_admin_id`,
        [id, a?.userId ?? p?.adminId ?? null])).rows[0];
      if (!g) throw new NotFoundException();
      await this.audit.record(tx, tenantId, { actorId: a?.userId ?? null, deviceId: a?.deviceId ?? 'platform', action: 'impersonation.revoked', entity: 'impersonation_grant', entityId: id, diff: { byPlatformAdmin: p?.adminId ?? null } });
      return g;
    });
    await this.paudit.record({ adminId: p?.adminId ?? r.platform_admin_id, tenantId, action: 'platform.impersonation_revoked', entity: 'impersonation_grant', entityId: id, diff: { byFirmUser: a?.userId ?? null } });
    return { revoked: true };
  }

  /** Issues the impersonation token (distinct type; expires with the grant; dies with the platform session). */
  async start(p: PlatformActor, tenantId: string, id: string) {
    const g = await this.db.tenantTx(tenantId, async (tx) => {
      const g = (await tx.query(`SELECT * FROM impersonation_grant WHERE id = $1 AND platform_admin_id = $2 FOR UPDATE`, [id, p.adminId])).rows[0];
      if (!g) throw new NotFoundException();
      const u = impersonationUsable({ status: g.status, expiresAt: g.expires_at, revokedAt: g.revoked_at, writeConsent: g.write_consent }, new Date(), 'GET');
      if (!u.ok) throw new ForbiddenException({ code: `IMPERSONATION_${u.reason.toUpperCase()}`, message: `Access is ${u.reason.replace('_', ' ')}` });
      await tx.query('UPDATE impersonation_grant SET first_used_at = COALESCE(first_used_at, now()) WHERE id = $1', [id]);
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'platform', action: 'impersonation.started', entity: 'impersonation_grant', entityId: id, diff: { platformAdminId: p.adminId } });
      return g;
    });
    const slug = (await this.db.systemTx((tx) => tx.query('SELECT slug, name FROM tenant WHERE id = $1', [tenantId]))).rows[0];
    await this.paudit.record({ adminId: p.adminId, tenantId, action: 'platform.impersonation_started', entity: 'impersonation_grant', entityId: id, ip: p.ip });
    const accessToken = await this.tokens.signImpersonation({ sub: p.adminId, sid: p.sessionId, tid: tenantId, gid: id }, g.expires_at);
    return { accessToken, tenantId, firmSlug: slug.slug, firmName: slug.name, grantId: id, expiresAt: g.expires_at, write: g.write_consent, userId: g.as_user_id };
  }

  /**
   * Guard path: an impersonation token → a read-only (unless consented) actor with the approver's roles. Every request is
   * audited in the tenant log AND the platform log with the impersonator's id (D181).
   */
  async authenticate(token: string, method: string, path: string, ip: string | null): Promise<RequestActor> {
    let c;
    try { c = await this.tokens.verifyImpersonation(token); } catch { throw new UnauthorizedException(); }
    if (!(await this.pauth.sessionLive(c.sid, c.sub))) throw new UnauthorizedException();
    const route = path.split('?')[0]!;
    const actor = await this.db.tenantTx(c.tid, async (tx) => {
      const g = (await tx.query(`SELECT * FROM impersonation_grant WHERE id = $1 AND platform_admin_id = $2`, [c.gid, c.sub])).rows[0];
      if (!g) throw new UnauthorizedException();
      const u = impersonationUsable({ status: g.status, expiresAt: g.expires_at, revokedAt: g.revoked_at, writeConsent: g.write_consent }, new Date(), method);
      if (!u.ok && u.reason === 'expired' && g.status === 'approved') await tx.query(`UPDATE impersonation_grant SET status = 'expired' WHERE id = $1`, [g.id]);
      if (!u.ok && u.reason !== 'read_only') return { error: new UnauthorizedException({ code: `IMPERSONATION_${u.reason.toUpperCase()}`, message: 'Support access has ended' }) };
      if (!u.ok || BLOCKED.some((re) => re.test(route))) {
        await this.audit.record(tx, c.tid, { actorId: g.as_user_id, deviceId: 'impersonation', action: 'impersonation.blocked', entity: 'impersonation_grant', entityId: g.id, diff: { method, path: route, platformAdminId: c.sub }, ip });
        return { error: new ForbiddenException({ code: 'IMPERSONATION_READ_ONLY', message: 'Not allowed during support access' }), blocked: true, grant: g };
      }
      await tx.query('UPDATE impersonation_grant SET actions = actions + 1 WHERE id = $1', [g.id]);
      await this.audit.record(tx, c.tid, { actorId: g.as_user_id, deviceId: 'impersonation', action: 'impersonation.action', entity: 'impersonation_grant', entityId: g.id, diff: { method, path: route, platformAdminId: c.sub }, ip });
      const s = (await tx.query('SELECT branch_id, status FROM app_user WHERE id = $1', [g.as_user_id])).rows[0];
      if (!s || s.status !== 'active') return { error: new UnauthorizedException() };
      const a: RequestActor = { userId: g.as_user_id, tenantId: c.tid, sessionId: g.id, deviceId: 'impersonation', branchId: s.branch_id, teamIds: await loadTeamIds(tx, g.as_user_id),
        roles: await loadUserRoles(tx, g.as_user_id), platform: 'impersonation', elevatedUntil: null,
        impersonation: { grantId: g.id, adminId: c.sub, write: g.write_consent, expiresAt: new Date(g.expires_at).toISOString() } };
      return { actor: a };
    });
    await this.paudit.record({ adminId: c.sub, tenantId: c.tid, action: 'error' in actor ? (actor.blocked ? 'platform.impersonation_blocked' : 'platform.impersonation_refused') : 'platform.impersonation_action',
      entity: 'impersonation_grant', entityId: c.gid, diff: { method, path: route }, ip });
    if ('error' in actor) throw actor.error;
    return actor.actor!;
  }
}
