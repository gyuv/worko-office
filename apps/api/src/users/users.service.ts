import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { can, coversRole, type Grant } from '@worko/domain';
import { loadUserRoles } from '../auth/roles.repo.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { hashPassword } from '../auth/crypto.js';
import { DbService } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { assertSeatAvailable } from '../platform/saas.service.js';
import { PasswordPolicyService } from '../auth/password-policy.js';

export type CreateUser = { name: string; email: string; phone?: string; password: string; roleKeys: string[]; branchId?: string };

@Injectable()
export class UsersService {
  constructor(private db: DbService, private audit: AuditService, private realtime: RealtimeService, private passwords: PasswordPolicyService) {}

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
      return { ...u, roles: a.roles.map((r) => r.key), grants: a.roles.flatMap((r) => r.grants), impersonation: a.impersonation ?? null };
    });
  }

  async create(a: RequestActor, i: CreateUser) {
    // Prevent privilege escalation: you can only hand out roles whose grants you hold yourself.
    await this.passwords.assert(i.password, { email: i.email, name: i.name }); // D198
    const passwordHash = await hashPassword(i.password);
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const branchId = i.branchId ?? a.branchId;
      if (!can(a, 'users', 'create', { branchId })) throw new ForbiddenException('Cannot add users to that branch');
      await assertSeatAvailable(tx, a.tenantId); // plan seats (402 SEAT_LIMIT, D184)
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

  /**
   * Edit a user: status (deactivate/reactivate), manager, branch, roles. The editor must cover the target's current
   * and new roles and both branches; deactivation ends every session (live sockets included).
   */
  async update(a: RequestActor, id: string, i: { status?: 'active' | 'disabled'; managerId?: string | null; branchId?: string; roleKeys?: string[]; name?: string; phone?: string | null }) {
    if (id === a.userId && (i.status === 'disabled' || i.roleKeys)) throw new BadRequestException('You cannot deactivate or re-role yourself');
    const sessions = await this.db.tenantTx(a.tenantId, async (tx) => {
      const u = (await tx.query(`SELECT id, branch_id, status FROM app_user WHERE id = $1 AND deleted_at IS NULL AND kind = 'staff'`, [id])).rows[0];
      if (!u) throw new NotFoundException();
      const current = await loadUserRoles(tx, id);
      if (!can(a, 'users', 'edit', { branchId: u.branch_id }) || !current.every((r) => coversRole(a, r))) throw new ForbiddenException();
      if (i.status === 'active' && u.status !== 'active') await assertSeatAvailable(tx, a.tenantId); // reactivation takes a seat (D184)
      if (i.branchId) {
        if (!(await tx.query('SELECT 1 FROM branch WHERE id = $1', [i.branchId])).rowCount || !can(a, 'users', 'edit', { branchId: i.branchId })) throw new ForbiddenException('Branch outside your scope');
      }
      if (i.managerId) {
        if (i.managerId === id) throw new BadRequestException('A user cannot manage themselves');
        if (!(await tx.query(`SELECT 1 FROM app_user WHERE id = $1 AND status = 'active' AND kind = 'staff'`, [i.managerId])).rowCount) throw new BadRequestException('Unknown manager');
      }
      if (i.roleKeys) {
        const roles = (await tx.query('SELECT id, key, grants, hidden_fields FROM role WHERE key = ANY($1) AND deleted_at IS NULL', [i.roleKeys])).rows;
        if (!roles.length || roles.length !== new Set(i.roleKeys).size) throw new BadRequestException('Unknown role');
        for (const r of roles) if (!coversRole(a, { grants: r.grants, hiddenFields: r.hidden_fields })) throw new ForbiddenException(`Cannot grant role ${r.key}`);
        await tx.query('DELETE FROM user_role WHERE user_id = $1', [id]);
        for (const r of roles) await tx.query('INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1,$2,$3)', [a.tenantId, id, r.id]);
      }
      const sets: string[] = []; const vals: unknown[] = [id];
      const set = (c: string, v: unknown) => { vals.push(v); sets.push(`${c} = $${vals.length}`); };
      if (i.status) set('status', i.status);
      if (i.managerId !== undefined) set('manager_id', i.managerId);
      if (i.branchId) set('branch_id', i.branchId);
      if (i.name) set('name', i.name);
      if (i.phone !== undefined) set('phone', i.phone);
      if (sets.length) await tx.query(`UPDATE app_user SET ${sets.join(', ')} WHERE id = $1`, vals);
      let ended: string[] = [];
      if (i.status === 'disabled') {
        ended = (await tx.query(`UPDATE device_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [id])).rows.map((r) => r.id);
        await tx.query(`UPDATE push_subscription SET disabled_at = now(), last_error = 'user disabled' WHERE user_id = $1 AND disabled_at IS NULL`, [id]);
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: i.status === 'disabled' ? 'user.deactivated' : 'user.updated', entity: 'app_user', entityId: id, diff: i });
      return ended;
    });
    for (const sessionId of sessions) this.realtime.publish({ type: 'session_revoked', tenantId: a.tenantId, sessionId, wipe: false });
  }

  roles(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(
      'SELECT id, key, name, system, grants, hidden_fields AS "hiddenFields" FROM role WHERE deleted_at IS NULL ORDER BY system DESC, name')).rows);
  }

  // ---------------- per-user UI preferences ----------------

  async uiPrefs(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query('SELECT ui_prefs AS p FROM app_user WHERE id = $1', [a.userId])).rows[0]?.p ?? {});
  }

  async setUiPrefs(a: RequestActor, prefs: Record<string, unknown>) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const r = (await tx.query('UPDATE app_user SET ui_prefs = $2 WHERE id = $1 RETURNING ui_prefs AS p', [a.userId, JSON.stringify(prefs)])).rows[0];
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'user.ui_prefs_changed', entity: 'app_user', entityId: a.userId, diff: prefs });
      return r?.p ?? {};
    });
  }

  // ---------------- roles (firm admin) ----------------

  /** Custom role: a key, a name and grants (usually cloned from an existing role, then edited). */
  async createRole(a: RequestActor, b: { key: string; name: string; grants: unknown[]; hiddenFields?: string[] }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      if (!a.roles.some((r) => r.key === 'partner') && !coversRole(a, { grants: b.grants as Grant[], hiddenFields: b.hiddenFields })) throw new ForbiddenException({ code: 'role_escalation', message: 'You can only grant permissions you hold yourself' });
      const id = uuidv7();
      try {
        await tx.query('INSERT INTO role (id, tenant_id, key, name, system, grants, hidden_fields, updated_by) VALUES ($1,$2,$3,$4,false,$5,$6,$7)',
          [id, a.tenantId, b.key, b.name, JSON.stringify(b.grants), b.hiddenFields ?? [], a.userId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException({ code: 'role_exists', message: 'A role with that key already exists' });
        throw e;
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'role.created', entity: 'role', entityId: id, diff: { key: b.key, name: b.name, grants: b.grants.length } });
      return { id };
    });
  }

  /** Edit a role's name/grants/hidden fields. The Partner role is locked so a firm can never lose its administrator. */
  async updateRole(a: RequestActor, id: string, b: { name?: string; grants?: unknown[]; hiddenFields?: string[] }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const r = (await tx.query('SELECT id, key FROM role WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
      if (!r) throw new NotFoundException();
      if (r.key === 'partner') throw new BadRequestException({ code: 'role_locked', message: 'The Partner role always has full access and cannot be changed' });
      if (!a.roles.some((r) => r.key === 'partner') && !coversRole(a, { grants: (b.grants ?? []) as Grant[], hiddenFields: b.hiddenFields })) throw new ForbiddenException({ code: 'role_escalation', message: 'You can only grant permissions you hold yourself' });
      await tx.query(`UPDATE role SET name = COALESCE($2, name), grants = COALESCE($3::jsonb, grants), hidden_fields = COALESCE($4, hidden_fields),
        version = version + 1, updated_at = now(), updated_by = $5 WHERE id = $1`,
      [id, b.name ?? null, b.grants ? JSON.stringify(b.grants) : null, b.hiddenFields ?? null, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'role.updated', entity: 'role', entityId: id, diff: { name: b.name, grants: b.grants?.length, hiddenFields: b.hiddenFields } });
    });
  }

  /** Delete a custom role that nobody holds. */
  async deleteRole(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const r = (await tx.query('SELECT id, system FROM role WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
      if (!r) throw new NotFoundException();
      if (r.system) throw new BadRequestException({ code: 'role_system', message: 'Built-in roles cannot be deleted' });
      if ((await tx.query('SELECT 1 FROM user_role WHERE role_id = $1 LIMIT 1', [id])).rowCount) throw new ConflictException({ code: 'role_in_use', message: 'Move the users holding this role to another role first' });
      await tx.query('UPDATE role SET deleted_at = now(), updated_by = $2 WHERE id = $1', [id, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'role.deleted', entity: 'role', entityId: id });
    });
  }
}
