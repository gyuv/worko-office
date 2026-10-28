import type { Category, Priority } from '@worko/notify';
import type { Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { enqueueTx } from '../jobs/job-queue.service.js';

export type NotifyInput = {
  userIds: string[]; category: Category; priority?: Priority; title: string; body?: string;
  entityType?: string; entityId?: string; fireAt?: Date; requiresAck?: boolean; escalateAfterMinutes?: number;
  dedupeKey?: string; escalatedFrom?: string; escalationLevel?: number;
};

export const MAX_ESCALATION = 3;
export const DELIVER = 'notification.deliver';
export const ESCALATE = 'notification.escalate';

/** Inserts notifications + their delivery jobs in the caller's transaction (also used by sync registry hooks). Publish `cursor` after commit. */
export async function insertNotifications(tx: Tx, tenantId: string, i: NotifyInput): Promise<{ ids: string[]; cursor: number }> {
  const ids: string[] = []; let cursor = 0;
  const fireAt = i.fireAt ?? new Date();
  for (const userId of new Set(i.userIds)) {
    const id = uuidv7();
    const r = await tx.query(
      `INSERT INTO notification (id, tenant_id, user_id, category, priority, title, body, entity_type, entity_id, fire_at,
         requires_ack, escalate_after_minutes, escalation_level, escalated_from, dedupe_key, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'server')
       ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING sync_cursor`,
      [id, tenantId, userId, i.category, i.priority ?? 'normal', i.title.slice(0, 200), (i.body ?? '').slice(0, 2000), i.entityType ?? null,
        i.entityId ?? null, fireAt, i.requiresAck ?? false, i.escalateAfterMinutes ?? null, i.escalationLevel ?? 0, i.escalatedFrom ?? null, i.dedupeKey ?? null]);
    if (!r.rowCount) continue; // duplicate (same dedupe key) — never notify twice
    ids.push(id);
    cursor = Math.max(cursor, Number(r.rows[0].sync_cursor));
    await enqueueTx(tx, tenantId, DELIVER, id, fireAt);
    if (i.requiresAck && i.escalateAfterMinutes) {
      await enqueueTx(tx, tenantId, ESCALATE, id, new Date(fireAt.getTime() + i.escalateAfterMinutes * 60_000));
    }
  }
  return { ids, cursor };
}


