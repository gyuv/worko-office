import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonical } from '../audit/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';

export type PlatformAuditEntry = { adminId: string | null; tenantId?: string | null; action: string; entity: string; entityId?: string | null; diff?: unknown; ip?: string | null };

const REDACT = /password|secret|token|otp|code|totp|email|phone|name|address|pan/i;
function redact(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(redact);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, REDACT.test(k) ? '[redacted]' : redact(x)]));
}

/**
 * Platform audit log: every super-admin action, hash-chained like the tenant audit (D179). Global table, written with the
 * owner role (systemTx) — never reachable from tenant code paths (not granted to worko_app).
 */
@Injectable()
export class PlatformAuditService {
  constructor(private db: DbService) {}

  record(e: PlatformAuditEntry) { return this.db.systemTx((tx) => this.recordTx(tx, e)); }

  async recordTx(tx: Tx, e: PlatformAuditEntry): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['audit:platform']);
    const prevHash = (await tx.query<{ hash: Buffer }>('SELECT hash FROM platform_audit_log ORDER BY seq DESC LIMIT 1')).rows[0]?.hash ?? null;
    const at = new Date().toISOString();
    const diff = e.diff === undefined ? null : redact(e.diff);
    const body = canonical({ at, adminId: e.adminId, tenantId: e.tenantId ?? null, action: e.action, entity: e.entity, entityId: e.entityId ?? null, diff });
    const hash = createHash('sha256').update(prevHash ?? Buffer.alloc(0)).update(body).digest();
    await tx.query(`INSERT INTO platform_audit_log (at, admin_id, tenant_id, action, entity, entity_id, diff, ip, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [at, e.adminId, e.tenantId ?? null, e.action, e.entity, e.entityId ?? null, diff === null ? null : JSON.stringify(diff), e.ip ?? null, prevHash, hash]);
  }

  async verify(): Promise<{ ok: boolean; checked: number; brokenAt: number | null }> {
    return this.db.systemTx(async (tx) => {
      const rows = (await tx.query(`SELECT seq, at, admin_id, tenant_id, action, entity, entity_id, diff, prev_hash, hash FROM platform_audit_log ORDER BY seq`)).rows;
      let prev: Buffer | null = null;
      for (const r of rows) {
        const body = canonical({ at: (r.at as Date).toISOString(), adminId: r.admin_id, tenantId: r.tenant_id, action: r.action, entity: r.entity, entityId: r.entity_id, diff: r.diff });
        const h = createHash('sha256').update(prev ?? Buffer.alloc(0)).update(body).digest();
        const prevOk = (prev === null && r.prev_hash === null) || (prev !== null && r.prev_hash !== null && prev.equals(r.prev_hash));
        if (!prevOk || !h.equals(r.hash)) return { ok: false, checked: rows.length, brokenAt: Number(r.seq) };
        prev = r.hash;
      }
      return { ok: true, checked: rows.length, brokenAt: null };
    });
  }

  list(q: { tenantId?: string; limit: number }) {
    return this.db.systemTx(async (tx) => (await tx.query(
      `SELECT seq::int, at, admin_id AS "adminId", tenant_id AS "tenantId", action, entity, entity_id AS "entityId", diff FROM platform_audit_log
       WHERE ($1::uuid IS NULL OR tenant_id = $1) ORDER BY seq DESC LIMIT $2`, [q.tenantId ?? null, q.limit])).rows);
  }
}
