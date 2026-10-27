import type { Actor } from '@worko/domain';
import { loadTeamIds, loadUserRoles } from '../auth/roles.repo.js';
import type { Tx } from '../db/db.service.js';

/** Every active staff user of the tenant as an Actor — for "who could see this before/after" decisions. */
export async function loadActors(tx: Tx): Promise<Actor[]> {
  const users = (await tx.query(`SELECT id, branch_id FROM app_user WHERE status = 'active' AND deleted_at IS NULL AND kind = 'staff'`)).rows;
  return Promise.all(users.map(async (u) => ({ userId: u.id, branchId: u.branch_id, teamIds: await loadTeamIds(tx, u.id), roles: await loadUserRoles(tx, u.id) })));
}
