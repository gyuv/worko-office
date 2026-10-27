import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { can, coversRole } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { hashPassword } from '../auth/crypto.js';
import { DbService } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';

export type CreateUser = { name: string; email: string; phone?: string; password: string; roleKeys: string[]; branchId?: string };

@Injectable()
export class UsersService {
  constructor(private db: DbService, private audit: AuditService) {}

  list(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.branch_id AS "branchId", u.totp_enabled AS "totpEnabled",
              coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
       FROM app_user u LEFT JOIN user_role ur ON ur.user_id = u.id LEFT JOIN role r ON r.id = ur.role_id
       WHERE u.deleted_at IS NULL AND u.kind = 'staff' GROUP BY u.id ORDER BY u.name`)).rows);
  }

  me(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const u = (await tx.query(
        `SELECT u.id, u.name, u.email, u.phone, u.totp_enabled AS "totpEnabled", t.name AS "firmName", t.slug AS "firmSlug"
         FROM app_user u JOIN tenant t ON t.id = u.tenant_id WHERE u.id = $1`, [a.userId])).rows[0];
      return { ...u, roles: a.roles.map((r) => r.key), grants: a.roles.flatMap((r) => r.grants) };
    });
  }

  async create(a: RequestActor, i: CreateUser) {
    // Prevent privilege escalation: you can only hand out roles whose grants you hold yourself.
    const passwordHash = await hashPassword(i.password);
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const branchId = i.branchId ?? a.branchId;
      if (!can(a, 'users', 'create', { branchId })) throw new ForbiddenException('Cannot add users to that branch');
      const roles = (await tx.query('SELECT id, key, grants, hidden_fields FROM role WHERE key = ANY($1) AND deleted_at IS NULL', [i.roleKeys])).rows;
      if (roles.length !== new Set(i.roleKeys).size) throw new BadRequestException('Unknown role');
      for (const r of roles) {
        if (!coversRole(a, { grants: r.grants, hiddenFields: r.hidden_fields })) throw new ForbiddenException(`Cannot grant role ${r.key}`);
      }
      const id = uuidv7();
      try {
        await tx.query(`INSERT INTO app_user (id, tenant_id, email, phone, name, password_hash, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, a.tenantId, i.email.toLowerCase(), i.phone ?? null, i.name, passwordHash, branchId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('A user with that email or phone exists');
        throw e;
      }
      for (const r of roles) await tx.query('INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1,$2,$3)', [a.tenantId, id, r.id]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'user.created', entity: 'app_user', entityId: id, diff: { email: i.email, roles: i.roleKeys } });
      return { id };
    });
  }

  roles(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(
      'SELECT id, key, name, system, grants, hidden_fields AS "hiddenFields" FROM role WHERE deleted_at IS NULL ORDER BY system DESC, name')).rows);
  }
}
