import type { Role } from '@worko/domain';
import type { Tx } from '../db/db.service.js';

export async function loadUserRoles(tx: Tx, userId: string): Promise<Role[]> {
  const r = await tx.query(
    `SELECT r.key, r.name, r.system, r.grants, r.hidden_fields FROM role r JOIN user_role ur ON ur.role_id = r.id
     WHERE ur.user_id = $1 AND r.deleted_at IS NULL`, [userId]);
  return r.rows.map((x) => ({ key: x.key, name: x.name, system: x.system, grants: x.grants, hiddenFields: x.hidden_fields }));
}

/** Teams the user belongs to, plus teams they lead. Drives `team` permission scope. */
export async function loadTeamIds(tx: Tx, userId: string): Promise<string[]> {
  const r = await tx.query(
    `SELECT team_id AS id FROM team_member m JOIN team t ON t.id = m.team_id WHERE m.user_id = $1 AND t.deleted_at IS NULL
     UNION SELECT id FROM team WHERE lead_user_id = $1 AND deleted_at IS NULL`, [userId]);
  return r.rows.map((x) => x.id);
}
