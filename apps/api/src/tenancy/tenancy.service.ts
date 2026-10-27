import { ConflictException, Injectable } from '@nestjs/common';
import { SYSTEM_ROLES } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import { hashPassword } from '../auth/crypto.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';

export type SignupInput = {
  firmName: string; slug: string; stateCode: string;
  partner: { name: string; email: string; password: string; phone?: string };
};

@Injectable()
export class TenancyService {
  constructor(private db: DbService, private audit: AuditService) {}

  /** Creates a firm with its first entity, head office, system roles and a Partner user. */
  async signup(i: SignupInput): Promise<{ tenantId: string; userId: string }> {
    const tenantId = uuidv7();
    const slug = i.slug.toLowerCase();
    try {
      await this.db.systemTx((tx) => tx.query('INSERT INTO tenant (id, name, slug) VALUES ($1,$2,$3)', [tenantId, i.firmName, slug]));
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('That firm address is taken');
      throw e;
    }
    const passwordHash = await hashPassword(i.partner.password);
    const userId = await this.db.tenantTx(tenantId, async (tx) => {
      await tx.query('INSERT INTO firm_entity (id, tenant_id, name, state_code) VALUES ($1,$2,$3,$4)', [uuidv7(), tenantId, i.firmName, i.stateCode]);
      const branchId = uuidv7();
      await tx.query('INSERT INTO branch (id, tenant_id, name, state_code) VALUES ($1,$2,$3,$4)', [branchId, tenantId, 'Head office', i.stateCode]);
      const roleIds = await this.seedRoles(tx, tenantId);
      const uid = uuidv7();
      await tx.query(
        `INSERT INTO app_user (id, tenant_id, email, phone, name, password_hash, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uid, tenantId, i.partner.email.toLowerCase(), i.partner.phone ?? null, i.partner.name, passwordHash, branchId]);
      await tx.query('INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1,$2,$3)', [tenantId, uid, roleIds.get('partner')]);
      await this.audit.record(tx, tenantId, { actorId: uid, action: 'tenant.created', entity: 'tenant', entityId: tenantId, diff: { name: i.firmName, slug } });
      return uid;
    });
    return { tenantId, userId };
  }

  async seedRoles(tx: Tx, tenantId: string): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const r of SYSTEM_ROLES) {
      const id = uuidv7();
      await tx.query('INSERT INTO role (id, tenant_id, key, name, system, grants, hidden_fields) VALUES ($1,$2,$3,$4,true,$5,$6)',
        [id, tenantId, r.key, r.name, JSON.stringify(r.grants), r.hiddenFields ?? []]);
      ids.set(r.key, id);
    }
    return ids;
  }
}
