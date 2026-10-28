import { Injectable } from '@nestjs/common';
import { loadPack, type RulePack } from '@worko/rules';
import { AuditService } from '../audit/audit.service.js';
import type { Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RulesService } from '../rules/rules.service.js';

/**
 * Per-tenant rule packs (D54). The shipped pack is installed as the approved pack the first time a tenant needs one;
 * later versions are uploaded as drafts and approved by someone with firm-wide compliance:approve.
 */
@Injectable()
export class RulePackService {
  private cache = new Map<string, RulePack>();
  constructor(private rules: RulesService, private audit: AuditService) {}

  async active(tx: Tx, tenantId: string): Promise<{ id: string; pack: RulePack }> {
    let r = (await tx.query(`SELECT id, pack FROM rule_pack WHERE status = 'approved'`)).rows[0];
    if (!r) {
      const id = uuidv7(); const p = this.rules.pack;
      const ins = await tx.query(
        `INSERT INTO rule_pack (id, tenant_id, pack_id, pack_version, status, pack, notes, approved_at) VALUES ($1,$2,$3,$4,'approved',$5,$6, now()) ON CONFLICT DO NOTHING`,
        [id, tenantId, p.id, p.version, JSON.stringify(p), p.notes ?? null]);
      if (ins.rowCount) await this.audit.record(tx, tenantId, { actorId: null, action: 'rule_pack.installed', entity: 'rule_pack', entityId: id, diff: { packId: p.id, version: p.version } });
      r = (await tx.query(`SELECT id, pack FROM rule_pack WHERE status = 'approved'`)).rows[0];
    }
    let pack = this.cache.get(r.id);
    if (!pack) { pack = loadPack(r.pack); this.cache.set(r.id, pack); }
    return { id: r.id, pack };
  }
}
