import type { Tx } from '../db/db.service.js';

/**
 * M8 gate: a task linked to an audit engagement that needs a UDIN can't be closed as billed/free (REST) or marked done
 * (device sync) until a live (non-revoked) UDIN is recorded for that engagement or task (D116).
 */
export async function udinGateError(tx: Tx, taskId: string): Promise<'udin_required' | null> {
  const r = await tx.query(`SELECT 1 FROM audit_engagement e WHERE e.task_id = $1 AND e.deleted_at IS NULL AND e.udin_required
      AND NOT EXISTS (SELECT 1 FROM udin_record u WHERE u.revoked_at IS NULL AND (u.engagement_id = e.id OR u.task_id = $1)) LIMIT 1`, [taskId]);
  return r.rowCount ? 'udin_required' : null;
}

/** SQL twin over a task alias: true when the task is NOT blocked by a missing UDIN (billing candidate filters). */
export const udinClearSql = (t = 't') => `NOT EXISTS (SELECT 1 FROM audit_engagement ue WHERE ue.task_id = ${t}.id AND ue.deleted_at IS NULL AND ue.udin_required
  AND NOT EXISTS (SELECT 1 FROM udin_record uu WHERE uu.revoked_at IS NULL AND (uu.engagement_id = ue.id OR uu.task_id = ${t}.id)))`;

/** Official ICAI UDIN portal (deep link only — the generation screen is never imitated). // VERIFY AGAINST OFFICIAL DOCS */
export const udinPortalUrl = () => process.env.ICAI_UDIN_PORTAL_URL || 'https://udin.icai.org/';
