import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SYNC_TABLES_TOKEN, type SyncTableDef } from './registry.js';

export type Mutation = { key: string; table: string; id: string; baseVersion: number; patch: Record<string, unknown>; delete?: boolean };
export type MutationResult = { key: string; status: 'applied' | 'duplicate' | 'rejected_stale' | 'rejected'; version?: number; reason?: string };
export type Change = { table: string; id: string; version: number; cursor: number; deleted: boolean; fields: Record<string, unknown> };

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Bad identifier ${s}`);
  return `"${s}"`;
};

@Injectable()
export class SyncService {
  constructor(
    private db: DbService, private audit: AuditService, private realtime: RealtimeService,
    @Inject(SYNC_TABLES_TOKEN) private tables: Record<string, SyncTableDef>,
  ) {}

  async push(a: RequestActor, mutations: Mutation[]): Promise<MutationResult[]> {
    const results: MutationResult[] = [];
    let maxCursor = 0;
    // One transaction per mutation: a rejected mutation never rolls back its neighbours.
    for (const m of mutations) {
      const r = await this.db.tenantTx(a.tenantId, async (tx) => {
        const prior = (await tx.query('SELECT result, user_id FROM sync_mutation WHERE key = $1', [m.key])).rows[0];
        // Keys are per user: another user's key is never treated as "already applied" for this caller.
        if (prior && prior.user_id !== a.userId) return { key: m.key, status: 'rejected' as const, reason: 'key_conflict' };
        if (prior) return { ...(prior.result as MutationResult), status: 'duplicate' as const };
        const res = await this.applyMutation(tx, a, m);
        await tx.query('INSERT INTO sync_mutation (tenant_id, key, user_id, result) VALUES ($1,$2,$3,$4)', [a.tenantId, m.key, a.userId, JSON.stringify(res.result)]);
        maxCursor = Math.max(maxCursor, res.cursor);
        return res.result;
      });
      results.push(r);
    }
    if (maxCursor) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: maxCursor });
    return results;
  }

  private async applyMutation(tx: Tx, a: RequestActor, m: Mutation): Promise<{ result: MutationResult; cursor: number }> {
    const def = this.tables[m.table];
    const reject = (reason: string) => ({ result: { key: m.key, status: 'rejected' as const, reason }, cursor: 0 });
    if (!def || (def.visible && !def.visible(a))) return reject('unknown_table');

    // Validate the patch against the whitelist before touching the DB.
    const patch: Record<string, unknown> = {};
    for (const [f, v] of Object.entries(m.patch)) {
      const schema = def.writable[f];
      if (!schema) return reject(`field_not_writable:${f}`);
      const p = schema.safeParse(v);
      if (!p.success) return reject(`invalid:${f}`);
      patch[f] = p.data;
    }

    const t = ident(def.table);
    const cur = (await tx.query(`SELECT * FROM ${t} WHERE id = $1 FOR UPDATE`, [m.id])).rows[0];
    if (!cur) {
      if (m.delete || !def.canInsert?.(a)) return reject('not_found');
      const row = { ...patch, ...def.owner?.(a) };
      const cols = Object.keys(row);
      const fv = Object.fromEntries(cols.map((c) => [c, 1]));
      const r = await tx.query(
        `INSERT INTO ${t} (id, tenant_id, updated_by, device_id, field_versions${cols.map((c) => `, ${ident(c)}`).join('')})
         VALUES ($1, $2, $3, $4, $5${cols.map((_, i) => `, $${i + 6}`).join('')}) RETURNING version, sync_cursor`,
        [m.id, a.tenantId, a.userId, a.deviceId, JSON.stringify(fv), ...cols.map((c) => toDb(row[c]))]);
      if (def.audit) await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: `${def.table}.created`, entity: def.table, entityId: m.id, diff: row });
      return { result: { key: m.key, status: 'applied', version: r.rows[0].version }, cursor: Number(r.rows[0].sync_cursor) };
    }

    if (m.delete ? !def.canDelete?.(a, cur) : !def.canUpdate(a, cur)) return reject('forbidden');
    if (def.strict && m.baseVersion !== cur.version) {
      return { result: { key: m.key, status: 'rejected_stale', version: cur.version }, cursor: 0 };
    }
    const next = await this.writePatch(tx, a, def, cur, patch, m.baseVersion, m.key, m.delete ?? false);
    if (def.audit) await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: m.delete ? `${def.table}.deleted` : `${def.table}.updated`, entity: def.table, entityId: m.id, diff: patch });
    return { result: { key: m.key, status: 'applied', version: next.version }, cursor: next.cursor };
  }

  /**
   * Field-level last-writer-wins in server receive order. If another write touched a field after the
   * writer's base version and the values differ, the overwritten value goes to the conflict log.
   */
  async writePatch(tx: Tx, a: RequestActor, def: SyncTableDef, cur: Record<string, unknown>, patch: Record<string, unknown>,
    baseVersion: number, key: string, del: boolean): Promise<{ version: number; cursor: number }> {
    const fv = (cur.field_versions ?? {}) as Record<string, number>;
    const newVersion = (cur.version as number) + 1;
    for (const [f, v] of Object.entries(patch)) {
      if ((fv[f] ?? 0) > baseVersion && !sameValue(cur[f], v)) {
        await tx.query(
          `INSERT INTO sync_conflict (id, tenant_id, table_name, row_id, field, lost, kept, mutation_key, user_id, device_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [uuidv7(), a.tenantId, def.table, cur.id, f, JSON.stringify(jsonable(cur[f])), JSON.stringify(jsonable(v)), key, a.userId, a.deviceId]);
      }
    }
    const cols = Object.keys(patch);
    const nfv = Object.fromEntries(cols.map((c) => [c, newVersion]));
    const sets = cols.map((c, i) => `${ident(c)} = $${i + 5}`);
    const r = await tx.query(
      `UPDATE ${ident(def.table)} SET field_versions = field_versions || $2, updated_by = $3, device_id = $4
         ${del ? ', deleted_at = now()' : ''}${sets.length ? ', ' + sets.join(', ') : ''}
       WHERE id = $1 RETURNING version, sync_cursor`,
      [cur.id, JSON.stringify(nfv), a.userId, a.deviceId, ...cols.map((c) => toDb(patch[c]))]);
    return { version: r.rows[0].version, cursor: Number(r.rows[0].sync_cursor) };
  }

  /** Server-side writes (REST actions, workers) go through the same field-version bookkeeping. */
  async serverPatch(tx: Tx, a: RequestActor, table: string, id: string, patch: Record<string, unknown>): Promise<{ version: number; cursor: number } | null> {
    const def = this.tables[table];
    if (!def) throw new Error(`Unknown sync table ${table}`);
    const cur = (await tx.query(`SELECT * FROM ${ident(def.table)} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) return null;
    return this.writePatch(tx, a, def, cur, patch, cur.version, `server:${uuidv7()}`, false);
  }

  /**
   * Delta pull across all tables, merged by the global cursor. Rows outside the actor's scope are never
   * shipped; rows that were synced and then deleted come back as tombstones.
   */
  async pull(a: RequestActor, since: number, limit: number): Promise<{ changes: Change[]; cursor: number; hasMore: boolean }> {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const all: Change[] = [];
      for (const [name, def] of Object.entries(this.tables)) {
        if (def.visible && !def.visible(a)) continue;
        const cols = def.columns.map(ident).join(', ');
        const r = await tx.query(
          `SELECT id, version, sync_cursor, deleted_at, ${cols} FROM ${ident(def.table)}
           WHERE sync_cursor > $2 AND $1::uuid IS NOT NULL AND (${def.scopeSql}) ORDER BY sync_cursor LIMIT $3`, [a.userId, since, limit + 1]);
        for (const row of r.rows) {
          const fields: Record<string, unknown> = {};
          for (const c of def.columns) fields[c] = jsonable(row[c]);
          all.push({ table: name, id: row.id, version: row.version, cursor: Number(row.sync_cursor), deleted: !!row.deleted_at, fields: row.deleted_at ? {} : fields });
        }
      }
      all.sort((x, y) => x.cursor - y.cursor);
      const page = all.slice(0, limit);
      const hasMore = all.length > limit;
      return { changes: page, cursor: page.length ? page[page.length - 1]!.cursor : since, hasMore };
    });
  }

  conflicts(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(
      `SELECT id, table_name AS "table", row_id AS "rowId", field, lost, kept, created_at AS "createdAt"
       FROM sync_conflict WHERE user_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 200`, [a.userId])).rows);
  }

  /** Dismiss, or restore the losing value (applied as a new write so it syncs everywhere). */
  async resolveConflict(a: RequestActor, id: string, restore: boolean) {
    const cursor = await this.db.tenantTx(a.tenantId, async (tx) => {
      const c = (await tx.query('SELECT * FROM sync_conflict WHERE id = $1 AND user_id = $2 AND resolved_at IS NULL FOR UPDATE', [id, a.userId])).rows[0];
      if (!c) throw new BadRequestException('Conflict not found');
      let cursor = 0;
      if (restore) {
        const def = Object.values(this.tables).find((d) => d.table === c.table_name);
        const cur = def && (await tx.query(`SELECT * FROM ${ident(def.table)} WHERE id = $1 FOR UPDATE`, [c.row_id])).rows[0];
        if (!def || !cur || !def.writable[c.field] || !def.canUpdate(a, cur)) throw new BadRequestException('Cannot restore');
        cursor = (await this.writePatch(tx, a, def, cur, { [c.field]: c.lost }, cur.version, `restore:${id}`, false)).cursor;
        if (def.audit) await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: `${def.table}.conflict_restored`, entity: def.table, entityId: c.row_id, diff: { field: c.field } });
      }
      await tx.query('UPDATE sync_conflict SET resolved_at = now() WHERE id = $1', [id]);
      return cursor;
    });
    if (cursor) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor });
  }
}

function toDb(v: unknown): unknown {
  return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
}
function jsonable(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v === undefined ? null : v;
}
function sameValue(a: unknown, b: unknown): boolean {
  const x = jsonable(a); const y = jsonable(b);
  if (typeof x === 'string' && typeof y === 'string' && !isNaN(Date.parse(x)) && !isNaN(Date.parse(y)) && /T/.test(x)) return Date.parse(x) === Date.parse(y);
  return JSON.stringify(x) === JSON.stringify(y);
}
