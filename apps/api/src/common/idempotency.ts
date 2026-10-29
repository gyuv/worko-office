import type { DbService } from '../db/db.service.js';

/**
 * Idempotency for side effects requested by automation/approvals (D155): the caller passes a stable key
 * (`auto:<runId>:<idx>`, `suggestion:<id>`); the service stores it on the row it creates (unique per tenant) and a
 * repeat — sequential or concurrent — gets the existing row back instead of a second side effect.
 */
export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';
const TABLES = new Set(['comm_message', 'task', 'esign_request', 'invoice', 'pbc_item']);
export async function rowByKey(db: DbService, tenantId: string, table: string, key: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!key || !TABLES.has(table)) return null;
  return db.tenantTx(tenantId, async (tx) => (await tx.query(`SELECT * FROM ${table} WHERE idempotency_key = $1 LIMIT 1`, [key])).rows[0] ?? null);
}
/** Runs `create`; on a duplicate key (lost race) returns the row that won. */
export async function once<T>(db: DbService, tenantId: string, table: string, key: string | null | undefined, existing: (r: Record<string, unknown>) => T | Promise<T>, create: () => Promise<T>): Promise<T> {
  const ex = await rowByKey(db, tenantId, table, key);
  if (ex) return await existing(ex);
  try { return await create(); } catch (e) {
    if (key && isUniqueViolation(e)) { const w = await rowByKey(db, tenantId, table, key); if (w) return await existing(w); }
    throw e;
  }
}
