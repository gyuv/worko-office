/**
 * Worko sync core (pure, transport-agnostic).
 * Server is source of truth. Clients send idempotent mutations from an outbox; server assigns a
 * monotonically increasing cursor; clients pull deltas by cursor. Field-level last-writer-wins by
 * server receive order, with losing values recorded in a conflict log. Tables flagged `strict`
 * (invoices, receipts, filed status) reject stale base versions instead of merging.
 */
export type Row = { id: string; table: string; version: number; deleted: boolean; fields: Record<string, unknown>; cursor: number };
export type Mutation = {
  idempotencyKey: string; deviceId: string; table: string; id: string;
  baseVersion: number; patch: Record<string, unknown>; delete?: boolean;
};
export type Conflict = { mutation: string; table: string; id: string; field: string; lost: unknown; kept: unknown };
export type ApplyResult = { status: 'applied' | 'duplicate' | 'rejected_stale'; row?: Row };

export class SyncServer {
  private rows = new Map<string, Row>();
  private seen = new Map<string, ApplyResult>();
  private fieldVersion = new Map<string, number>();
  cursor = 0;
  readonly conflicts: Conflict[] = [];
  constructor(private strictTables: Set<string> = new Set()) {}

  apply(m: Mutation): ApplyResult {
    const prior = this.seen.get(m.idempotencyKey);
    if (prior) return { ...prior, status: 'duplicate' };
    const key = `${m.table}:${m.id}`;
    const cur = this.rows.get(key);
    if (cur && this.strictTables.has(m.table) && m.baseVersion !== cur.version) {
      const r: ApplyResult = { status: 'rejected_stale', row: cur };
      this.seen.set(m.idempotencyKey, r);
      return r;
    }
    const row: Row = cur ? { ...cur, fields: { ...cur.fields } } : { id: m.id, table: m.table, version: 0, deleted: false, fields: {}, cursor: 0 };
    for (const [f, v] of Object.entries(m.patch)) {
      const fk = `${key}.${f}`;
      // Someone else changed this field after the writer's base → record the overwritten value.
      if ((this.fieldVersion.get(fk) ?? 0) > m.baseVersion && row.fields[f] !== v) {
        this.conflicts.push({ mutation: m.idempotencyKey, table: m.table, id: m.id, field: f, lost: row.fields[f], kept: v });
      }
      row.fields[f] = v;
      this.fieldVersion.set(fk, row.version + 1);
    }
    if (m.delete) row.deleted = true;
    row.version += 1;
    row.cursor = ++this.cursor;
    this.rows.set(key, row);
    const r: ApplyResult = { status: 'applied', row };
    this.seen.set(m.idempotencyKey, r);
    return r;
  }

  /** Delta pull. `visible` enforces permissions: rows the user may not see are never shipped. */
  pull(since: number, visible: (r: Row) => boolean = () => true, limit = 500) {
    const out = [...this.rows.values()].filter((r) => r.cursor > since).sort((a, b) => a.cursor - b.cursor).slice(0, limit);
    return {
      upserts: out.filter(visible),
      revoked: out.filter((r) => !visible(r)).map((r) => `${r.table}:${r.id}`),
      cursor: out.length ? out.at(-1)!.cursor : since,
    };
  }

  snapshot() { return new Map([...this.rows].map(([k, r]) => [k, { deleted: r.deleted, fields: r.fields }])); }
}

export class SyncClient {
  rows = new Map<string, Row>();
  outbox: Mutation[] = [];
  cursor = 0;
  private seq = 0;
  constructor(readonly deviceId: string) {}

  write(table: string, id: string, patch: Record<string, unknown>, del = false) {
    const key = `${table}:${id}`;
    const cur = this.rows.get(key);
    const base = cur?.version ?? 0;
    this.rows.set(key, { id, table, version: base, deleted: del || !!cur?.deleted, fields: { ...cur?.fields, ...patch }, cursor: cur?.cursor ?? 0 });
    this.outbox.push({ idempotencyKey: `${this.deviceId}-${++this.seq}`, deviceId: this.deviceId, table, id, baseVersion: base, patch, delete: del });
  }

  /** Push the outbox. Mutations stay queued until acknowledged (applied, duplicate or rejected). */
  push(send: (m: Mutation) => ApplyResult | null, batch = 50): ApplyResult[] {
    const results: ApplyResult[] = [];
    for (const m of this.outbox.slice(0, batch)) {
      const r = send(m);
      if (!r) break; // network failure → retry later, preserve order
      results.push(r);
      this.outbox.shift();
    }
    return results;
  }

  ingest(p: ReturnType<SyncServer['pull']>) {
    for (const k of p.revoked) this.rows.delete(k);
    for (const r of p.upserts) {
      const pending = this.outbox.filter((m) => `${m.table}:${m.id}` === `${r.table}:${r.id}`);
      // Re-apply un-pushed local edits on top of server state so the UI never flickers back.
      const fields = { ...r.fields };
      for (const m of pending) Object.assign(fields, m.patch);
      this.rows.set(`${r.table}:${r.id}`, { ...r, fields });
    }
    this.cursor = p.cursor;
  }

  snapshot() { return new Map([...this.rows].map(([k, r]) => [k, { deleted: r.deleted, fields: r.fields }])); }
}
