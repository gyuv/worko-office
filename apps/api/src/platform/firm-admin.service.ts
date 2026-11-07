import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { hashPassword } from '../auth/crypto.js';
import type { PlatformActor } from '../auth/context.js';
import { PasswordPolicyService } from '../auth/password-policy.js';
import { DbService } from '../db/db.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { PlatformAuditService } from './platform-audit.service.js';

export type CreateFirm = {
  firmName: string; slug: string; stateCode: string; seatLimit?: number | null;
  admin: { name: string; email: string; password: string; phone?: string };
};

/** Never leaves the server in an export: credentials, session/refresh tokens, TOTP and other secrets. */
const SECRET_COLUMN = /(password|token|secret|totp|otp_hash|_enc$)/;
const EXPORT_ROW_CAP = 200_000;

/**
 * Super-admin firm management: provision a firm with its first admin (Partner) and seat limit, list a firm's users,
 * reset a locked-out user's password, and export a firm's data. Every call lands in the platform audit log;
 * changes inside a firm are also written to that firm's own audit log.
 */
@Injectable()
export class FirmAdminService {
  constructor(private db: DbService, private tenancy: TenancyService, private audit: AuditService, private paudit: PlatformAuditService,
    private passwords: PasswordPolicyService) {}

  private async assertTenant(tenantId: string) {
    const t = (await this.db.systemTx((tx) => tx.query('SELECT id, name, slug FROM tenant WHERE id = $1', [tenantId]))).rows[0];
    if (!t) throw new NotFoundException();
    return t as { id: string; name: string; slug: string };
  }

  /** Creates the firm exactly like self-signup (entity, head office, roles), with the admin as its Partner, then the seat limit. */
  async createFirm(p: PlatformActor, b: CreateFirm) {
    const { tenantId, userId } = await this.tenancy.signup({ firmName: b.firmName, slug: b.slug, stateCode: b.stateCode, partner: b.admin });
    await this.db.systemTx(async (tx) => {
      if (b.seatLimit !== undefined) await tx.query('UPDATE tenant SET seat_limit = $2 WHERE id = $1', [tenantId, b.seatLimit]);
      await this.paudit.recordTx(tx, { adminId: p.adminId, tenantId, action: 'platform.firm_created', entity: 'tenant', entityId: tenantId,
        diff: { firmName: b.firmName, slug: b.slug.toLowerCase(), adminEmail: b.admin.email.toLowerCase(), seatLimit: b.seatLimit ?? null }, ip: p.ip });
    });
    return { tenantId, adminUserId: userId, slug: b.slug.toLowerCase() };
  }

  async users(p: PlatformActor, tenantId: string) {
    await this.assertTenant(tenantId);
    const rows = await this.db.tenantTx(tenantId, async (tx) => (await tx.query(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.kind, u.locked_until AS "lockedUntil",
              coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles,
              (SELECT max(s.last_seen_at) FROM device_session s WHERE s.user_id = u.id) AS "lastSignIn"
       FROM app_user u LEFT JOIN user_role ur ON ur.user_id = u.id LEFT JOIN role r ON r.id = ur.role_id
       WHERE u.deleted_at IS NULL GROUP BY u.id ORDER BY u.name`)).rows);
    await this.paudit.record({ adminId: p.adminId, tenantId, action: 'platform.users_viewed', entity: 'tenant', entityId: tenantId, ip: p.ip });
    return rows;
  }

  /** Sets a new password, clears any lockout and signs the user out everywhere. */
  async resetPassword(p: PlatformActor, tenantId: string, userId: string, password: string) {
    await this.assertTenant(tenantId);
    const u = (await this.db.tenantTx(tenantId, (tx) => tx.query('SELECT id, name, email FROM app_user WHERE id = $1 AND deleted_at IS NULL', [userId]))).rows[0];
    if (!u) throw new NotFoundException();
    await this.passwords.assert(password, { email: u.email, name: u.name });
    const hash = await hashPassword(password);
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx.query('UPDATE app_user SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1', [userId, hash]);
      await tx.query('UPDATE device_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'platform', action: 'user.password_reset_by_platform', entity: 'app_user', entityId: userId, diff: { platformAdminId: p.adminId } });
    });
    await this.paudit.record({ adminId: p.adminId, tenantId, action: 'platform.user_password_reset', entity: 'app_user', entityId: userId, ip: p.ip });
    return { ok: true };
  }

  /**
   * Every row of every firm-scoped table (RLS-isolated tables), as JSON. Secret columns (passwords, tokens, TOTP,
   * encrypted fields) are left out. Requires a reason; the reason and row counts are audited.
   */
  async exportFirm(p: PlatformActor, tenantId: string, reason: string) {
    const firm = await this.assertTenant(tenantId);
    if (reason.trim().length < 5) throw new BadRequestException('Give a reason for the export');
    const tables = (await this.db.systemTx((tx) => tx.query(
      `SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation' ORDER BY tablename`))).rows.map((r) => r.tablename as string);
    const data: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    await this.db.tenantTx(tenantId, async (tx) => {
      for (const table of tables) {
        const cols = (await tx.query(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])).rows
          .filter((c) => c.data_type !== 'bytea' && !SECRET_COLUMN.test(c.column_name as string)).map((c) => `"${c.column_name as string}"`);
        if (!cols.length) continue;
        const rows = (await tx.query(`SELECT ${cols.join(', ')} FROM "${table}" LIMIT ${EXPORT_ROW_CAP}`)).rows;
        if (rows.length) { data[table] = rows; counts[table] = rows.length; }
      }
    });
    await this.paudit.record({ adminId: p.adminId, tenantId, action: 'platform.firm_exported', entity: 'tenant', entityId: tenantId, diff: { reason, counts }, ip: p.ip });
    return { firm: { id: firm.id, name: firm.name, slug: firm.slug }, exportedAt: new Date().toISOString(), exportedBy: p.email,
      note: 'Passwords, tokens, two-factor secrets and encrypted fields are not included.', counts, tables: data };
  }
}
