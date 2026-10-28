import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { can, canTask, clientCtx, SEED_SAC_BY_CATEGORY } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { loadActors } from '../clients/actors.js';
import { visibilityOf } from '../clients/scope.js';
import { RulePackService } from '../compliance/rule-pack.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import { defaultCatalogue } from './catalogue.js';

export type ServiceTypeIn = {
  key?: string; name?: string; category?: string; description?: string | null; frequency?: string; ruleId?: string | null; slaDays?: number | null;
  defaultChecks?: Array<{ key: string; label: string; required: boolean }>; leaderId?: string | null; managerId?: string | null; reviewerId?: string | null;
  assigneeId?: string | null; billable?: boolean; active?: boolean; sacCode?: string | null; gstRate?: number | null;
};
export type ClientServiceIn = {
  active?: boolean; startPeriod?: string | null; endPeriod?: string | null; leaderId?: string | null; managerId?: string | null;
  reviewerId?: string | null; assigneeId?: string | null; notes?: string | null; billingFrequency?: 'monthly' | 'quarterly' | 'annual' | null;
};
const ST_COLS: Record<string, string> = {
  key: 'key', name: 'name', category: 'category', description: 'description', frequency: 'frequency', ruleId: 'rule_id', slaDays: 'sla_days',
  defaultChecks: 'default_checks', leaderId: 'leader_id', managerId: 'manager_id', reviewerId: 'reviewer_id', assigneeId: 'assignee_id', billable: 'billable', active: 'active',
  sacCode: 'sac_code', gstRate: 'gst_rate',
};
const CS_COLS: Record<string, string> = {
  active: 'active', startPeriod: 'start_period', endPeriod: 'end_period', leaderId: 'leader_id', managerId: 'manager_id', reviewerId: 'reviewer_id', assigneeId: 'assignee_id', notes: 'notes', billingFrequency: 'billing_frequency',
};
const toRow = (cols: Record<string, string>, i: Record<string, unknown>) => Object.fromEntries(Object.entries(i).filter(([k, v]) => k in cols && v !== undefined).map(([k, v]) => [cols[k]!, v]));

export const presentServiceType = (r: Record<string, unknown>) => ({
  id: r.id, key: r.key, name: r.name, category: r.category, description: r.description, frequency: r.frequency, ruleId: r.rule_id, slaDays: r.sla_days,
  defaultChecks: r.default_checks, leaderId: r.leader_id, managerId: r.manager_id, reviewerId: r.reviewer_id, assigneeId: r.assignee_id,
  billable: r.billable, active: r.active, sacCode: r.sac_code ?? null, gstRate: r.gst_rate == null ? null : Number(r.gst_rate), version: r.version,
});
const presentClientService = (r: Record<string, unknown>) => ({
  id: r.id, clientId: r.client_id, serviceTypeId: r.service_type_id, serviceKey: r.key, serviceName: r.name, startPeriod: r.start_period, endPeriod: r.end_period,
  leaderId: r.leader_id, managerId: r.manager_id, reviewerId: r.reviewer_id, assigneeId: r.assignee_id, active: r.active, notes: r.notes, billingFrequency: r.billing_frequency ?? null, version: r.version,
});

@Injectable()
export class CatalogueService {
  constructor(private db: DbService, private audit: AuditService, private sync: SyncService, private realtime: RealtimeService, private packs: RulePackService) {}

  list(a: RequestActor, includeInactive = false) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(
      `SELECT * FROM service_type WHERE deleted_at IS NULL ${includeInactive ? '' : 'AND active'} ORDER BY category, name`)).rows.map(presentServiceType));
  }

  private async checkUsers(tx: Tx, ids: Array<string | null | undefined>) {
    const u = [...new Set(ids.filter((x): x is string => !!x))];
    if (!u.length) return;
    const n = (await tx.query(`SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1) AND kind = 'staff' AND status = 'active' AND deleted_at IS NULL`, [u])).rows[0].n;
    if (n !== u.length) throw new BadRequestException('Unknown user');
  }

  private async insertType(tx: Tx, a: RequestActor, i: ServiceTypeIn) {
    const id = uuidv7();
    const row = { ...toRow(ST_COLS, i as Record<string, unknown>), default_checks: JSON.stringify(i.defaultChecks ?? []) };
    const cols = Object.keys(row);
    try {
      const r = await tx.query(`INSERT INTO service_type (id, tenant_id, updated_by, ${cols.join(', ')}) VALUES ($1,$2,$3, ${cols.map((_, n) => `$${n + 4}`).join(', ')}) RETURNING sync_cursor`,
        [id, a.tenantId, a.userId, ...cols.map((c) => row[c as keyof typeof row])]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'service_type.created', entity: 'service_type', entityId: id, diff: i });
      return { id, cursor: Number(r.rows[0].sync_cursor) };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('A service with that key exists');
      throw e;
    }
  }

  async create(a: RequestActor, i: ServiceTypeIn) {
    const r = await this.db.tenantTx(a.tenantId, async (tx) => { await this.checkUsers(tx, [i.leaderId, i.managerId, i.reviewerId, i.assigneeId]); return this.insertType(tx, a, i); });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r.cursor });
    return { id: r.id };
  }

  async update(a: RequestActor, id: string, i: ServiceTypeIn) {
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      if (!(await tx.query('SELECT 1 FROM service_type WHERE id = $1 AND deleted_at IS NULL', [id])).rowCount) throw new NotFoundException();
      await this.checkUsers(tx, [i.leaderId, i.managerId, i.reviewerId, i.assigneeId]);
      const patch = toRow(ST_COLS, i as Record<string, unknown>);
      try {
        const res = await this.sync.serverPatch(tx, a, 'service_type', id, patch);
        await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'service_type.updated', entity: 'service_type', entityId: id, diff: i });
        return res;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('A service with that key exists');
        throw e;
      }
    });
    if (r) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r.cursor });
  }

  /** Idempotent: adds catalogue entries whose key the firm doesn't have yet. */
  async installDefaults(a: RequestActor) {
    const r = await this.db.tenantTx(a.tenantId, (tx) => this.installDefaultsTx(tx, a));
    if (r.cursor) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r.cursor });
    return { created: r.created, skipped: r.skipped };
  }

  async installDefaultsTx(tx: Tx, a: RequestActor) {
    const { pack } = await this.packs.active(tx, a.tenantId);
    const have = new Set((await tx.query('SELECT key FROM service_type WHERE deleted_at IS NULL')).rows.map((r) => r.key as string));
    let created = 0; let skipped = 0; let cursor = 0;
    for (const s of defaultCatalogue(pack)) {
      if (have.has(s.key)) { skipped++; continue; }
      const r = await this.insertType(tx, a, { key: s.key, name: s.name, category: s.category, frequency: s.frequency, ruleId: s.ruleId, slaDays: s.slaDays, defaultChecks: s.checks, billable: s.billable,
        sacCode: SEED_SAC_BY_CATEGORY[s.category] ?? null }); // seed SAC — VERIFY AGAINST OFFICIAL DOCS
      cursor = Math.max(cursor, r.cursor); created++;
    }
    return { created, skipped, cursor };
  }

  /** Client must be visible (clients:view) and its tasks viewable; 404 otherwise. */
  private async client(tx: Tx, a: RequestActor, id: string, action: 'view' | 'assign') {
    const c = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
    if (!c || !canTask(a, 'view', { leaderId: null, managerId: null, assigneeId: null, reviewerId: null }, visibilityOf(c))) throw new NotFoundException('Client not found');
    if (action === 'assign' && !can(a, 'tasks', 'assign', clientCtx(visibilityOf(c)))) throw new NotFoundException('Client not found');
    return c;
  }

  listForClient(a: RequestActor, clientId: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.client(tx, a, clientId, 'view');
      return (await tx.query(`SELECT cs.*, s.key, s.name FROM client_service cs JOIN service_type s ON s.id = cs.service_type_id
        WHERE cs.client_id = $1 AND cs.deleted_at IS NULL ORDER BY s.category, s.name`, [clientId])).rows.map(presentClientService);
    });
  }

  /** Upsert a subscription; people named must be able to see the client. */
  async subscribe(a: RequestActor, clientId: string, serviceTypeId: string, i: ClientServiceIn) {
    if (i.startPeriod && i.endPeriod && i.endPeriod < i.startPeriod) throw new BadRequestException('endPeriod before startPeriod');
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await this.client(tx, a, clientId, 'assign');
      if (!(await tx.query('SELECT 1 FROM service_type WHERE id = $1 AND deleted_at IS NULL', [serviceTypeId])).rowCount) throw new NotFoundException('Service not found');
      const people = [i.leaderId, i.managerId, i.reviewerId, i.assigneeId].filter((x): x is string => !!x);
      if (people.length) {
        const actors = await loadActors(tx);
        for (const u of people) {
          const x = actors.find((y) => y.userId === u);
          if (!x || !can(x, 'clients', 'view', clientCtx(visibilityOf(c)))) throw new BadRequestException('Person cannot see this client');
        }
      }
      const cur = (await tx.query('SELECT id FROM client_service WHERE client_id = $1 AND service_type_id = $2 AND deleted_at IS NULL FOR UPDATE', [clientId, serviceTypeId])).rows[0];
      const patch = toRow(CS_COLS, i as Record<string, unknown>);
      let id: string; let cursor: number;
      if (cur) {
        id = cur.id;
        cursor = (await this.sync.serverPatch(tx, a, 'client_service', id, patch))!.cursor;
      } else {
        id = uuidv7();
        const cols = Object.keys(patch);
        cursor = Number((await tx.query(`INSERT INTO client_service (id, tenant_id, client_id, service_type_id, updated_by${cols.map((c2) => `, ${c2}`).join('')})
          VALUES ($1,$2,$3,$4,$5${cols.map((_, n) => `, $${n + 6}`).join('')}) RETURNING sync_cursor`, [id, a.tenantId, clientId, serviceTypeId, a.userId, ...cols.map((c2) => patch[c2])])).rows[0].sync_cursor);
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: cur ? 'client_service.updated' : 'client_service.created', entity: 'client_service', entityId: id, diff: { clientId, serviceTypeId, ...i } });
      return { id, cursor };
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r.cursor });
    return { id: r.id };
  }
}
