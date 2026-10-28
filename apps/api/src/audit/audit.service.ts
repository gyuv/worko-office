import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Tx } from '../db/db.service.js';

export type AuditEntry = {
  actorId?: string | null; deviceId?: string | null; action: string; entity: string;
  entityId?: string | null; diff?: unknown; ip?: string | null;
};

/** Stable JSON (sorted keys) so the hash is reproducible on verification. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

const REDACT = /password|secret|token|otp|code_hash|totp/i;
function redact(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(redact);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, REDACT.test(k) ? '[redacted]' : redact(x)]));
}

@Injectable()
export class AuditService {
  /** Appends an entry in the caller's transaction; serialised per tenant so the chain has no forks. */
  async record(tx: Tx, tenantId: string, e: AuditEntry): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${tenantId}`]);
    const prev = await tx.query<{ hash: Buffer }>('SELECT hash FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1', [tenantId]);
    const prevHash = prev.rows[0]?.hash ?? null;
    const at = new Date().toISOString();
    const diff = e.diff === undefined ? null : redact(e.diff);
    const body = canonical({ tenantId, at, actorId: e.actorId ?? null, action: e.action, entity: e.entity, entityId: e.entityId ?? null, diff });
    const hash = createHash('sha256').update(prevHash ?? Buffer.alloc(0)).update(body).digest();
    await tx.query(
      `INSERT INTO audit_log (tenant_id, at, actor_id, device_id, action, entity, entity_id, diff, ip, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [tenantId, at, e.actorId ?? null, e.deviceId ?? null, e.action, e.entity, e.entityId ?? null, diff === null ? null : JSON.stringify(diff), e.ip ?? null, prevHash, hash],
    );
  }

  /** Recomputes the chain; returns the first broken seq, or null if intact. */
  async verify(tx: Tx, tenantId: string): Promise<{ ok: boolean; checked: number; brokenAt: number | null }> {
    const rows = (await tx.query(
      `SELECT seq, at, actor_id, action, entity, entity_id, diff, prev_hash, hash FROM audit_log WHERE tenant_id = $1 ORDER BY seq`, [tenantId],
    )).rows as Array<{ seq: string; at: Date; actor_id: string | null; action: string; entity: string; entity_id: string | null; diff: unknown; prev_hash: Buffer | null; hash: Buffer }>;
    let prev: Buffer | null = null as Buffer | null;
    for (const r of rows) {
      const body = canonical({ tenantId, at: r.at.toISOString(), actorId: r.actor_id, action: r.action, entity: r.entity, entityId: r.entity_id, diff: r.diff });
      const h: Buffer = createHash('sha256').update(prev ?? Buffer.alloc(0)).update(body).digest();
      const prevOk = (prev === null && r.prev_hash === null) || (prev !== null && r.prev_hash !== null && prev.equals(r.prev_hash));
      if (!prevOk || !h.equals(r.hash)) return { ok: false, checked: rows.length, brokenAt: Number(r.seq) };
      prev = r.hash;
    }
    return { ok: true, checked: rows.length, brokenAt: null };
  }
}
