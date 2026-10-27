import type { Role } from '@worko/domain';
import type { Tx } from '../db/db.service.js';

export async function loadUserRoles(tx: Tx, userId: string): Promise<Role[]> {
  const r = await tx.query(
    `SELECT r.key, r.name, r.system, r.grants, r.hidden_fields FROM role r JOIN user_role ur ON ur.role_id = r.id
     WHERE ur.user_id = $1 AND r.deleted_at IS NULL`, [userId]);
  return r.rows.map((x) => ({ key: x.key, name: x.name, system: x.system, grants: x.grants, hiddenFields: x.hidden_fields }));
}

export async function loadTeamIds(_tx: Tx, _userId: string): Promise<string[]> {
  return []; // Teams table arrives with Phase 3 (staff directory); team scope then resolves via membership.
}
