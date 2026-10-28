import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { FollowupStep } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { DbService } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { requireFirmWide } from '../tasks/system-actor.js';
import { d, loadSettings, n } from './common.js';

export type EntityIn = {
  name?: string; frn?: string | null; pan?: string | null; gstin?: string | null; stateCode?: string; address?: string | null; email?: string | null; phone?: string | null;
  bank?: { name?: string; accountNo?: string; ifsc?: string; branch?: string; upiId?: string }; invoicePrefix?: string; logoDocId?: string | null; active?: boolean;
};
export type SettingsIn = { defaultEntityId?: string | null; dueDays?: number; defaultGstRate?: number; defaultSac?: string; ladder?: FollowupStep[]; terms?: string | null };
export type RateIn = { serviceTypeId: string; clientId?: string | null; groupId?: string | null; amountPaise: number; effectiveFrom: string; effectiveTo?: string | null; notes?: string | null };

const E_COLS: Record<string, string> = { name: 'name', frn: 'frn', pan: 'pan', gstin: 'gstin', stateCode: 'state_code', address: 'address', email: 'email', phone: 'phone',
  bank: 'bank', invoicePrefix: 'invoice_prefix', logoDocId: 'logo_doc_id', active: 'active' };
const presentEntity = (e: Record<string, unknown>) => ({
  id: e.id, name: e.name, frn: e.frn, pan: e.pan, gstin: e.gstin, stateCode: e.state_code, address: e.address, email: e.email, phone: e.phone, bank: e.bank,
  invoicePrefix: e.invoice_prefix, logoDocId: e.logo_doc_id, active: e.active, registered: !!e.gstin,
});
const presentRate = (r: Record<string, unknown>) => ({
  id: r.id, serviceTypeId: r.service_type_id, serviceKey: r.service_key, clientId: r.client_id, groupId: r.group_id, amountPaise: n(r.amount_paise),
  effectiveFrom: d(r.effective_from), effectiveTo: d(r.effective_to), notes: r.notes,
});

/** Firm-wide billing configuration: entities, defaults + follow-up ladder, rate tables, Tally ledger map (settings:edit, firm-wide). */
@Injectable()
export class BillingConfigService {
  constructor(private db: DbService, private audit: AuditService, private realtime: RealtimeService) {}

  entities(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query('SELECT * FROM firm_entity WHERE deleted_at IS NULL ORDER BY name, id')).rows.map(presentEntity));
  }

  private check(i: EntityIn) {
    if (i.gstin && i.stateCode && i.gstin.slice(0, 2) !== i.stateCode) throw new BadRequestException({ message: 'GSTIN state does not match the entity state', code: 'gstin_state_mismatch' });
  }

  async createEntity(a: RequestActor, i: EntityIn) {
    requireFirmWide(a, 'settings', 'edit');
    this.check(i);
    const id = uuidv7();
    const row = Object.fromEntries(Object.entries(i).filter(([k, v]) => v !== undefined && k in E_COLS).map(([k, v]) => [E_COLS[k]!, k === 'bank' ? JSON.stringify(v) : v]));
    const cols = Object.keys(row);
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`INSERT INTO firm_entity (id, tenant_id, updated_by, ${cols.join(', ')}) VALUES ($1,$2,$3, ${cols.map((_, k) => `$${k + 4}`).join(', ')})`, [id, a.tenantId, a.userId, ...cols.map((c) => row[c])]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'firm_entity.created', entity: 'firm_entity', entityId: id, diff: i });
    });
    return { id };
  }

  async updateEntity(a: RequestActor, id: string, i: EntityIn) {
    requireFirmWide(a, 'settings', 'edit');
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const cur = (await tx.query('SELECT * FROM firm_entity WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!cur) throw new NotFoundException();
      this.check({ gstin: i.gstin === undefined ? cur.gstin : i.gstin, stateCode: i.stateCode ?? cur.state_code });
      // Series prefix and state are part of issued numbers/taxes: frozen once the entity has issued anything.
      if ((i.invoicePrefix && i.invoicePrefix !== cur.invoice_prefix) || (i.stateCode && i.stateCode !== cur.state_code) || (i.gstin !== undefined && i.gstin !== cur.gstin)) {
        if ((await tx.query(`SELECT 1 FROM invoice WHERE entity_id = $1 AND number IS NOT NULL UNION ALL SELECT 1 FROM receipt WHERE entity_id = $1 LIMIT 1`, [id])).rowCount) {
          throw new ConflictException({ message: 'Entity has issued documents; prefix, state and GSTIN are locked', code: 'entity_locked' });
        }
      }
      const sets = Object.entries(i).filter(([k, v]) => v !== undefined && k in E_COLS);
      if (!sets.length) return;
      await tx.query(`UPDATE firm_entity SET ${sets.map(([k], j) => `${E_COLS[k]} = $${j + 3}`).join(', ')}, updated_by = $2 WHERE id = $1`,
        [id, a.userId, ...sets.map(([k, v]) => (k === 'bank' ? JSON.stringify(v) : v))]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'firm_entity.updated', entity: 'firm_entity', entityId: id, diff: i });
    });
  }

  settings(a: RequestActor) { return this.db.tenantTx(a.tenantId, (tx) => loadSettings(tx)); }

  async putSettings(a: RequestActor, i: SettingsIn) {
    requireFirmWide(a, 'settings', 'edit');
    await this.db.tenantTx(a.tenantId, async (tx) => {
      if (i.defaultEntityId && !(await tx.query('SELECT 1 FROM firm_entity WHERE id = $1 AND deleted_at IS NULL', [i.defaultEntityId])).rowCount) throw new BadRequestException('Unknown entity');
      const cur = await loadSettings(tx);
      const next = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) } as typeof cur;
      await tx.query(`INSERT INTO billing_settings (tenant_id, default_entity_id, due_days, default_gst_rate, default_sac, ladder, terms, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (tenant_id) DO UPDATE SET default_entity_id = $2, due_days = $3, default_gst_rate = $4, default_sac = $5, ladder = $6, terms = $7, updated_by = $8, updated_at = now()`,
        [a.tenantId, next.defaultEntityId, next.dueDays, next.defaultGstRate, next.defaultSac, JSON.stringify(next.ladder), next.terms, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'billing_settings.updated', entity: 'billing_settings', entityId: a.tenantId, diff: i });
    });
  }

  rates(a: RequestActor, q: { serviceTypeId?: string; clientId?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT r.*, s.key AS service_key FROM billing_rate r JOIN service_type s ON s.id = r.service_type_id
      WHERE r.deleted_at IS NULL AND ($1::uuid IS NULL OR r.service_type_id = $1) AND ($2::uuid IS NULL OR r.client_id = $2)
      ORDER BY s.key, r.client_id NULLS FIRST, r.group_id NULLS FIRST, r.effective_from DESC`, [q.serviceTypeId ?? null, q.clientId ?? null])).rows.map(presentRate));
  }

  async createRate(a: RequestActor, i: RateIn) {
    requireFirmWide(a, 'settings', 'edit');
    if (i.effectiveTo && i.effectiveTo < i.effectiveFrom) throw new BadRequestException('effectiveTo before effectiveFrom');
    const id = uuidv7();
    const cursor = await this.db.tenantTx(a.tenantId, async (tx) => {
      if (!(await tx.query('SELECT 1 FROM service_type WHERE id = $1 AND deleted_at IS NULL', [i.serviceTypeId])).rowCount) throw new BadRequestException('Unknown service');
      if (i.clientId && !(await tx.query('SELECT 1 FROM client WHERE id = $1 AND deleted_at IS NULL', [i.clientId])).rowCount) throw new BadRequestException('Unknown client');
      if (i.groupId && !(await tx.query('SELECT 1 FROM client_group WHERE id = $1', [i.groupId])).rowCount) throw new BadRequestException('Unknown group');
      const r = await tx.query(`INSERT INTO billing_rate (id, tenant_id, service_type_id, client_id, group_id, amount_paise, effective_from, effective_to, notes, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING sync_cursor`,
        [id, a.tenantId, i.serviceTypeId, i.clientId ?? null, i.groupId ?? null, i.amountPaise, i.effectiveFrom, i.effectiveTo ?? null, i.notes ?? null, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'billing_rate.created', entity: 'billing_rate', entityId: id, diff: i });
      return Number(r.rows[0].sync_cursor);
    });
    this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor });
    return { id };
  }

  /** Rates are history: change the amount or end-date of a rate; a new price is a new row with a later effective date. */
  async updateRate(a: RequestActor, id: string, i: { amountPaise?: number; effectiveTo?: string | null; notes?: string | null; deleted?: boolean }) {
    requireFirmWide(a, 'settings', 'edit');
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const cur = (await tx.query('SELECT * FROM billing_rate WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!cur) throw new NotFoundException();
      if (i.effectiveTo && i.effectiveTo < d(cur.effective_from)!) throw new BadRequestException('effectiveTo before effectiveFrom');
      await tx.query(`UPDATE billing_rate SET amount_paise = COALESCE($2, amount_paise), effective_to = CASE WHEN $3 THEN $4::date ELSE effective_to END,
          notes = CASE WHEN $5 THEN $6 ELSE notes END, deleted_at = CASE WHEN $7 THEN now() ELSE deleted_at END, updated_by = $8 WHERE id = $1`,
        [id, i.amountPaise ?? null, i.effectiveTo !== undefined, i.effectiveTo ?? null, i.notes !== undefined, i.notes ?? null, !!i.deleted, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: i.deleted ? 'billing_rate.deleted' : 'billing_rate.updated', entity: 'billing_rate', entityId: id, diff: i });
    });
  }

  ledgers(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query('SELECT entity_id, account_key, ledger_name FROM tally_ledger_map ORDER BY entity_id NULLS FIRST, account_key')).rows
      .map((r) => ({ entityId: r.entity_id, accountKey: r.account_key, ledgerName: r.ledger_name })));
  }

  /** Upserts mappings; `ledgerName: null` removes one. */
  async putLedgers(a: RequestActor, items: Array<{ entityId?: string | null; accountKey: string; ledgerName: string | null }>) {
    requireFirmWide(a, 'settings', 'edit');
    await this.db.tenantTx(a.tenantId, async (tx) => {
      for (const it of items) {
        await tx.query(`DELETE FROM tally_ledger_map WHERE COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid) AND account_key = $2`,
          [it.entityId ?? null, it.accountKey]);
        if (it.ledgerName) {
          await tx.query('INSERT INTO tally_ledger_map (id, tenant_id, entity_id, account_key, ledger_name, updated_by) VALUES ($1,$2,$3,$4,$5,$6)',
            [uuidv7(), a.tenantId, it.entityId ?? null, it.accountKey, it.ledgerName, a.userId]);
        }
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'tally_ledger_map.updated', entity: 'tally_ledger_map', diff: { items } });
    });
  }
}
