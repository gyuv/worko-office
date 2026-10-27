import { Injectable } from '@nestjs/common';
import { can, clientCtx, type ClientVisibility, type Module } from '@worko/domain';
import type { Tx } from '../db/db.service.js';
import { loadActors } from './actors.js';

const CHILD_MODULE: Record<string, Module> = {
  contact: 'clients', client_registration: 'clients', document: 'documents', inward_entry: 'registers', outward_entry: 'registers',
};

/**
 * Keeps devices consistent when a client's visibility changes.
 * - Narrowing: users who could see the client (or its children) before but not after get a revocation
 *   entry — nobody else learns the row exists.
 * - Widening: children are "touched" (new cursor) so newly entitled users receive them on their next pull.
 * Must run in the same transaction, after the client row itself was updated (cursor ordering).
 */
@Injectable()
export class VisibilityService {
  async onChange(tx: Tx, tenantId: string, clientId: string, before: ClientVisibility, after: ClientVisibility, opts: { childrenFrom?: string } = {}) {
    const actors = await loadActors(tx);
    const b = clientCtx(before); const a = clientCtx(after);
    const lost = (module: Module) => actors.filter((x) => can(x, module, 'view', b) && !can(x, module, 'view', a)).map((x) => x.userId);
    const childSource = opts.childrenFrom ?? clientId;
    const revoke = async (table: string, ids: string[], users: string[]) => {
      if (!users.length || !ids.length) return;
      for (const id of ids) {
        await tx.query(`INSERT INTO sync_revocation (tenant_id, table_name, row_id, user_ids, sync_cursor) VALUES ($1,$2,$3,$4, nextval('sync_cursor_seq'))`,
          [tenantId, table, id, users]);
      }
    };
    if (!opts.childrenFrom) await revoke('client', [clientId], lost('clients'));
    for (const [table, module] of Object.entries(CHILD_MODULE)) {
      const ids = (await tx.query(`SELECT id FROM ${table} WHERE client_id = $1 AND deleted_at IS NULL`, [childSource])).rows.map((r) => r.id as string);
      await revoke(table, ids, lost(module));
      // Touch so users who gained access get these rows on their next pull.
      if (ids.length) await tx.query(`UPDATE ${table} SET updated_at = now() WHERE client_id = $1 AND deleted_at IS NULL`, [childSource]);
    }
  }
}
