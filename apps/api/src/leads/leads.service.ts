import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  can, clientCtx, crmSettingsSchema, effectiveScope, ENGAGEMENT_LETTER_VARIABLES, isValidPan, LEAD_STAGES, templateErrors, leadTransitionError, needsRebalance, normalizeEmail, normalizePhone, positionBetween,
  type Action, type CrmSettings, type LeadStage, type ResourceCtx,
} from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Params, visibilityOf } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { insertNotifications } from '../notifications/insert.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { requireFirmWide } from '../tasks/system-actor.js';
import { ymd } from '../tasks/scope.js';

export type LeadIn = {
  name: string; company?: string | null; email?: string | null; phone?: string | null; pan?: string | null; gstin?: string | null; entityType?: string | null; stateCode?: string | null;
  source?: string; ownerId?: string | null; expectedValuePaise?: number; nextFollowupOn?: string | null; notes?: string | null;
};

/** Lead visibility (D131): leads are firm records owned by a person — owner/creator count as owners; branch scope by the lead's branch. */
export const leadCtx = (l: Record<string, unknown>): ResourceCtx => ({ ownerUserIds: [l.owner_id, l.created_by].filter((x): x is string => typeof x === 'string'), branchId: (l.branch_id as string) ?? null });
export function leadScopeSql(a: RequestActor, action: Action, p: Params, x = 'l'): string {
  if (a.superAdmin) return 'TRUE';
  const g = effectiveScope(a, 'leads', action);
  if (!g || g.scope === 'none') return 'FALSE';
  switch (g.scope) {
    case 'all': return 'TRUE';
    case 'branch': return a.branchId ? `(${x}.branch_id IS NULL OR ${x}.branch_id = ${p.add(a.branchId)}::uuid)` : `${x}.branch_id IS NULL`;
    default: { const me = p.add(a.userId); return `(${x}.owner_id = ${me}::uuid OR ${x}.created_by = ${me}::uuid)`; } // team/groups/own: leads carry no team or client group — owners only (same as `can` with leadCtx)
  }
}

const out = (l: Record<string, unknown>) => ({
  id: l.id, name: l.name, company: l.company, email: l.email, phone: l.phone, pan: l.pan, gstin: l.gstin, entityType: l.entity_type, stateCode: l.state_code, source: l.source,
  ownerId: l.owner_id, stage: l.stage, position: Number(l.position), lostReason: l.lost_reason, expectedValuePaise: Number(l.expected_value_paise ?? 0),
  nextFollowupOn: ymd(l.next_followup_on), notes: l.notes, clientId: l.client_id, convertedAt: l.converted_at, stageChangedAt: l.stage_changed_at, createdAt: l.created_at, version: l.version,
});

/** Leads pipeline (M4): kanban stages are data, moves validated by @worko/domain, every change audited (field names only — no contact PII in diffs). */
@Injectable()
export class LeadsService {
  constructor(private db: DbService, private audit: AuditService, private realtime: RealtimeService, private clock: Clock) {}

  rec(tx: Tx, a: RequestActor, action: string, entity: string, entityId: string, diff: Record<string, unknown> = {}) {
    return this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action, entity, entityId, diff });
  }
  activity(tx: Tx, tenantId: string, leadId: string, kind: string, body: string | null, by: string | null, meta: Record<string, unknown> = {}, at?: Date) {
    return tx.query('INSERT INTO lead_activity (id, tenant_id, lead_id, kind, body, meta, created_by, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [uuidv7(), tenantId, leadId, kind, body, JSON.stringify(meta), by, at ?? this.clock.now()]);
  }

  async loadLead(tx: Tx, a: RequestActor, id: string, action: Action, lock = false) {
    const l = (await tx.query(`SELECT * FROM lead WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
    if (!l || !can(a, 'leads', 'view', leadCtx(l))) throw new NotFoundException();
    if (!can(a, 'leads', action, leadCtx(l))) throw new ForbiddenException();
    return l;
  }

  // ---------- Settings ----------
  async settingsTx(tx: Tx): Promise<CrmSettings> {
    const r = (await tx.query('SELECT settings FROM crm_settings WHERE tenant_id = current_tenant()')).rows[0];
    return crmSettingsSchema.parse(r?.settings ?? {});
  }
  settings(a: RequestActor) { return this.db.tenantTx(a.tenantId, (tx) => this.settingsTx(tx)); }
  async putSettings(a: RequestActor, body: unknown) {
    requireFirmWide(a, 'settings', 'edit');
    const r = crmSettingsSchema.safeParse(body);
    if (!r.success) throw new BadRequestException({ message: 'Invalid settings', issues: r.error.issues });
    const errs = templateErrors(r.data.engagementLetterTemplate, ENGAGEMENT_LETTER_VARIABLES);
    if (errs.length) throw new BadRequestException({ message: 'Invalid engagement letter template', code: 'invalid_template', issues: errs });
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`INSERT INTO crm_settings (tenant_id, settings, updated_by) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [a.tenantId, JSON.stringify(r.data), a.userId]);
      await this.rec(tx, a, 'crm.settings_updated', 'tenant', a.tenantId, { fields: Object.keys(body as object) });
      return r.data;
    });
  }

  // ---------- Duplicates ----------
  /**
   * Matches by PAN, GSTIN (and its embedded PAN), email or mobile (last 10 digits) against clients and leads. Clients the caller
   * can't see are only counted (no names), so the check can't be used to discover other partners' clients.
   */
  async duplicatesTx(tx: Tx, a: RequestActor, q: { pan?: string | null; gstin?: string | null; email?: string | null; phone?: string | null }, excludeLeadId?: string) {
    const pan = q.pan?.toUpperCase() ?? (q.gstin ? q.gstin.toUpperCase().slice(2, 12) : null);
    const gstin = q.gstin?.toUpperCase() ?? null;
    const email = normalizeEmail(q.email ?? null);
    const phone = normalizePhone(q.phone ?? null);
    const ten = phone ? phone.replace(/\D/g, '').slice(-10) : null;
    if (!pan && !gstin && !email && !ten) return { clients: [], hiddenClients: 0, leads: [] };
    const d = (col: string) => `right(regexp_replace(coalesce(${col}, ''), '\\D', '', 'g'), 10)`;
    const clients = (await tx.query(`SELECT DISTINCT c.* FROM client c WHERE c.deleted_at IS NULL AND (
        ($1::text IS NOT NULL AND upper(c.pan) = $1) OR ($2::text IS NOT NULL AND EXISTS (SELECT 1 FROM client_registration r WHERE r.client_id = c.id AND r.kind = 'GSTIN' AND upper(r.number) = $2 AND r.deleted_at IS NULL))
        OR ($3::text IS NOT NULL AND (lower(c.email) = $3 OR EXISTS (SELECT 1 FROM contact ct WHERE ct.client_id = c.id AND ct.deleted_at IS NULL AND lower(ct.email) = $3)))
        OR ($4::text IS NOT NULL AND (${d('c.phone')} = $4 OR EXISTS (SELECT 1 FROM contact ct WHERE ct.client_id = c.id AND ct.deleted_at IS NULL AND (${d('ct.phone')} = $4 OR ${d('ct.whatsapp')} = $4)))))
      LIMIT 50`, [pan, gstin, email, ten])).rows;
    const visible = clients.filter((c) => can(a, 'clients', 'view', clientCtx(visibilityOf(c))));
    const leads = (await tx.query(`SELECT * FROM lead l WHERE l.deleted_at IS NULL AND ($5::uuid IS NULL OR l.id <> $5) AND (
        ($1::text IS NOT NULL AND upper(l.pan) = $1) OR ($2::text IS NOT NULL AND upper(l.gstin) = $2) OR ($3::text IS NOT NULL AND lower(l.email) = $3) OR ($4::text IS NOT NULL AND ${d('l.phone')} = $4)) LIMIT 50`,
      [pan, gstin, email, ten, excludeLeadId ?? null])).rows.filter((l) => can(a, 'leads', 'view', leadCtx(l)));
    const why = (r: Record<string, unknown>, own: { pan?: unknown; email?: unknown; phone?: unknown }) => [
      pan && String(own.pan ?? '').toUpperCase() === pan ? 'pan' : null, email && String(own.email ?? '').toLowerCase() === email ? 'email' : null,
      ten && String(own.phone ?? '').replace(/\D/g, '').slice(-10) === ten ? 'phone' : null].filter(Boolean).concat(r.gstin && gstin && String(r.gstin).toUpperCase() === gstin ? ['gstin'] : []);
    return {
      clients: visible.map((c) => ({ id: c.id, name: c.name, fileNo: c.file_no, matchedOn: why({}, { pan: c.pan, email: c.email, phone: c.phone }) })),
      hiddenClients: clients.length - visible.length,
      leads: leads.map((l) => ({ id: l.id, name: l.name, company: l.company, stage: l.stage, matchedOn: why(l, { pan: l.pan, email: l.email, phone: l.phone }) })),
    };
  }
  duplicates(a: RequestActor, q: { pan?: string; gstin?: string; email?: string; phone?: string }) { return this.db.tenantTx(a.tenantId, (tx) => this.duplicatesTx(tx, a, q)); }

  // ---------- CRUD ----------
  private validateIds(i: Partial<LeadIn>) {
    if (i.pan && !isValidPan(i.pan.toUpperCase())) throw new BadRequestException({ message: 'Invalid PAN', code: 'invalid:pan' });
    if (i.email && !normalizeEmail(i.email)) throw new BadRequestException({ message: 'Invalid email', code: 'invalid:email' });
    if (i.phone && !normalizePhone(i.phone)) throw new BadRequestException({ message: 'Invalid phone', code: 'invalid:phone' });
  }
  private async checkOwner(tx: Tx, a: RequestActor, ownerId: string) {
    if (ownerId === a.userId) return;
    if (!a.superAdmin && (effectiveScope(a, 'leads', 'assign')?.scope ?? 'none') === 'none') throw new ForbiddenException('Needs leads:assign to give a lead to someone else');
    if (!(await tx.query(`SELECT 1 FROM app_user WHERE id = $1 AND status = 'active' AND kind = 'staff' AND deleted_at IS NULL`, [ownerId])).rowCount) throw new BadRequestException({ message: 'Unknown owner', code: 'invalid:ownerId' });
  }
  private async followup(tx: Tx, tenantId: string, l: Record<string, unknown>) {
    if (!l.next_followup_on || !l.owner_id || ['won', 'lost'].includes(l.stage as string)) return 0;
    const day = ymd(l.next_followup_on)!;
    // 09:30 IST on the follow-up date; dedupe per lead × date.
    return (await insertNotifications(tx, tenantId, { userIds: [l.owner_id as string], category: 'lead.followup', title: `Follow up: ${String(l.company ?? l.name).slice(0, 150)}`,
      entityType: 'lead', entityId: l.id as string, fireAt: new Date(Date.parse(`${day}T04:00:00Z`)), dedupeKey: `lead-followup:${l.id}:${day}` })).cursor;
  }

  async create(a: RequestActor, i: LeadIn) {
    this.validateIds(i);
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const owner = i.ownerId ?? a.userId;
      await this.checkOwner(tx, a, owner);
      const id = uuidv7();
      const row = { owner_id: owner, created_by: a.userId, branch_id: a.branchId };
      if (!can(a, 'leads', 'create', leadCtx(row))) throw new ForbiddenException();
      const pos = Number((await tx.query(`SELECT coalesce(max(position), 0) AS m FROM lead WHERE stage = 'new' AND deleted_at IS NULL`)).rows[0].m) + 1024;
      await tx.query(`INSERT INTO lead (id, tenant_id, name, company, email, phone, pan, gstin, entity_type, state_code, source, owner_id, branch_id, position, expected_value_paise, next_followup_on, notes, created_by, stage_changed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, a.tenantId, i.name, i.company ?? null, normalizeEmail(i.email ?? null), normalizePhone(i.phone ?? null), i.pan?.toUpperCase() ?? null, i.gstin?.toUpperCase() ?? null, i.entityType ?? null,
        i.stateCode ?? i.gstin?.slice(0, 2) ?? null, i.source ?? 'other', owner, a.branchId, pos, i.expectedValuePaise ?? 0, i.nextFollowupOn ?? null, i.notes ?? null, a.userId, this.clock.now()]);
      await this.activity(tx, a.tenantId, id, 'system', 'Lead created', a.userId, { source: i.source ?? 'other' });
      await this.rec(tx, a, 'lead.created', 'lead', id, { source: i.source ?? 'other', ownerId: owner, expectedValuePaise: i.expectedValuePaise ?? 0 });
      const l = (await tx.query('SELECT * FROM lead WHERE id = $1', [id])).rows[0];
      const cur = await this.followup(tx, a.tenantId, l);
      return { lead: out(l), duplicates: await this.duplicatesTx(tx, a, i, id), cur };
    });
    if (r.cur) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r.cur });
    return { ...r.lead, duplicates: r.duplicates };
  }

  list(a: RequestActor, q: { stage?: LeadStage; ownerId?: string; q?: string; limit: number; offset: number }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = ['l.deleted_at IS NULL', leadScopeSql(a, 'view', p)];
      if (q.stage) where.push(`l.stage = ${p.add(q.stage)}`);
      if (q.ownerId) where.push(`l.owner_id = ${p.add(q.ownerId)}`);
      if (q.q) where.push(`(l.name ILIKE ${p.add(`%${q.q}%`)} OR l.company ILIKE $${p.values.length})`);
      const rows = (await tx.query(`SELECT l.*, count(*) OVER () AS total FROM lead l WHERE ${where.join(' AND ')} ORDER BY l.updated_at DESC LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`, p.values)).rows;
      return { total: Number(rows[0]?.total ?? 0), items: rows.map(out) };
    });
  }

  /** Kanban: every stage column in position order (won/lost show the latest 50). */
  board(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const rows = (await tx.query(`SELECT * FROM (SELECT l.*, row_number() OVER (PARTITION BY l.stage ORDER BY CASE WHEN l.stage IN ('won','lost') THEN -extract(epoch FROM l.stage_changed_at) ELSE l.position END) AS rn
        FROM lead l WHERE l.deleted_at IS NULL AND ${leadScopeSql(a, 'view', p)}) x WHERE x.stage NOT IN ('won','lost') OR x.rn <= 50 ORDER BY x.rn`, p.values)).rows;
      return LEAD_STAGES.map((s) => {
        const items = rows.filter((r) => r.stage === s).map(out);
        return { stage: s, count: items.length, valuePaise: items.reduce((t, x) => t + x.expectedValuePaise, 0), items };
      });
    });
  }

  get(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const l = await this.loadLead(tx, a, id, 'view');
      const acts = (await tx.query('SELECT id, kind, body, meta, created_by AS "by", at FROM lead_activity WHERE lead_id = $1 ORDER BY at DESC, id DESC LIMIT 100', [id])).rows;
      const props = (await tx.query(`SELECT id, number, title, status, current_version AS "currentVersion", sent_version AS "sentVersion", converted_at AS "convertedAt" FROM proposal WHERE lead_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [id])).rows;
      return { ...out(l), activities: acts, proposals: props };
    });
  }

  async update(a: RequestActor, id: string, i: Partial<LeadIn>) {
    this.validateIds(i);
    const cur = await this.db.tenantTx(a.tenantId, async (tx) => {
      const l = await this.loadLead(tx, a, id, 'edit', true);
      if (i.ownerId && i.ownerId !== l.owner_id) await this.checkOwner(tx, a, i.ownerId);
      const map: Record<string, [string, unknown]> = {
        name: ['name', i.name], company: ['company', i.company], email: ['email', i.email === undefined ? undefined : normalizeEmail(i.email)], phone: ['phone', i.phone === undefined ? undefined : normalizePhone(i.phone)],
        pan: ['pan', i.pan === undefined ? undefined : i.pan?.toUpperCase() ?? null], gstin: ['gstin', i.gstin === undefined ? undefined : i.gstin?.toUpperCase() ?? null], entityType: ['entity_type', i.entityType],
        stateCode: ['state_code', i.stateCode], source: ['source', i.source], ownerId: ['owner_id', i.ownerId], expectedValuePaise: ['expected_value_paise', i.expectedValuePaise],
        nextFollowupOn: ['next_followup_on', i.nextFollowupOn], notes: ['notes', i.notes],
      };
      const sets: string[] = []; const vals: unknown[] = [id];
      for (const [, [col, v]] of Object.entries(map)) if (v !== undefined) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
      if (!sets.length) return 0;
      await tx.query(`UPDATE lead SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`, vals);
      await this.rec(tx, a, 'lead.updated', 'lead', id, { fields: Object.keys(i).filter((k) => (i as Record<string, unknown>)[k] !== undefined) });
      return this.followup(tx, a.tenantId, (await tx.query('SELECT * FROM lead WHERE id = $1', [id])).rows[0]);
    });
    if (cur) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: cur });
  }

  /** Kanban move: stage change validated by the pipeline rules; position between the given neighbours (rebalanced when gaps get tiny). */
  async move(a: RequestActor, id: string, b: { stage: LeadStage; beforeId?: string | null; afterId?: string | null; lostReason?: string | null }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lead-board:${a.tenantId}`]);
      const l = await this.loadLead(tx, a, id, 'edit', true);
      const err = leadTransitionError(l.stage, b.stage, b.lostReason);
      if (err) throw new BadRequestException({ message: 'Move not allowed', code: err });
      if (b.stage === 'won' && !l.client_id) throw new BadRequestException({ message: 'Convert an accepted proposal (or link a client) to win a lead', code: 'convert_to_win' });
      const nb = async (nid: string | null | undefined) => {
        if (!nid) return null;
        const r = (await tx.query('SELECT position, stage FROM lead WHERE id = $1 AND deleted_at IS NULL', [nid])).rows[0];
        if (!r || r.stage !== b.stage || nid === id) throw new BadRequestException({ message: 'Neighbour must be in the target column', code: 'invalid:neighbour' });
        return Number(r.position);
      };
      let before = await nb(b.beforeId); let after = await nb(b.afterId);
      if (before === null && after === null) before = Number((await tx.query('SELECT coalesce(max(position), 0) AS m FROM lead WHERE stage = $1 AND deleted_at IS NULL AND id <> $2', [b.stage, id])).rows[0].m);
      if (before !== null && after !== null && after <= before) throw new BadRequestException({ message: 'Neighbours out of order', code: 'invalid:neighbour' });
      if (needsRebalance(before, after)) {
        await tx.query(`UPDATE lead x SET position = s.rn * 1024 FROM (SELECT id, row_number() OVER (ORDER BY position) AS rn FROM lead WHERE stage = $1 AND deleted_at IS NULL) s WHERE x.id = s.id`, [b.stage]);
        before = await nb(b.beforeId); after = await nb(b.afterId);
      }
      const pos = positionBetween(before, after);
      const changed = l.stage !== b.stage;
      await tx.query(`UPDATE lead SET stage = $2, position = $3, lost_reason = CASE WHEN $2 = 'lost' THEN $4 ELSE NULL END, stage_changed_at = CASE WHEN $5 THEN $6 ELSE stage_changed_at END,
        version = version + 1, updated_at = now() WHERE id = $1`, [id, b.stage, pos, b.lostReason ?? null, changed, this.clock.now()]);
      if (changed) {
        await this.activity(tx, a.tenantId, id, 'stage', b.stage === 'lost' ? `Lost: ${b.lostReason}` : null, a.userId, { from: l.stage, to: b.stage });
        await this.rec(tx, a, 'lead.moved', 'lead', id, { from: l.stage, to: b.stage });
      }
      return { stage: b.stage, position: pos };
    });
  }

  activities(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadLead(tx, a, id, 'view');
      return (await tx.query('SELECT id, kind, body, meta, created_by AS "by", at FROM lead_activity WHERE lead_id = $1 ORDER BY at DESC, id DESC LIMIT 500', [id])).rows;
    });
  }
  async addActivity(a: RequestActor, id: string, b: { kind: 'note' | 'call' | 'email' | 'meeting'; body: string; at?: string | null }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadLead(tx, a, id, 'edit');
      const at = b.at ? new Date(b.at) : this.clock.now();
      if (at.getTime() > this.clock.now().getTime() + 5 * 60_000) throw new BadRequestException({ message: 'Future time', code: 'future_time' });
      await this.activity(tx, a.tenantId, id, b.kind, b.body, a.userId, {}, at);
      await tx.query('UPDATE lead SET updated_at = now() WHERE id = $1', [id]);
      await this.rec(tx, a, 'lead.activity_logged', 'lead', id, { kind: b.kind });
      if ((await tx.query('SELECT 1 FROM lead WHERE id = $1 AND stage = $2', [id, 'new'])).rowCount && ['call', 'email', 'meeting'].includes(b.kind)) {
        // First contact moves a new lead to "contacted" automatically.
        await tx.query(`UPDATE lead SET stage = 'contacted', stage_changed_at = $2, version = version + 1 WHERE id = $1`, [id, this.clock.now()]);
        await this.activity(tx, a.tenantId, id, 'stage', null, a.userId, { from: 'new', to: 'contacted', auto: true });
      }
      return { ok: true };
    });
  }

  async remove(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const l = await this.loadLead(tx, a, id, 'delete', true);
      if (l.client_id) throw new ConflictException({ message: 'A converted lead cannot be deleted', code: 'lead_converted' });
      await tx.query('UPDATE lead SET deleted_at = now(), version = version + 1 WHERE id = $1', [id]);
      await this.rec(tx, a, 'lead.deleted', 'lead', id);
    });
  }
}
